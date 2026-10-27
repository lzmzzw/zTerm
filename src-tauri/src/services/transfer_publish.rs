//! Publish completed SFTP files without exposing an incomplete final path.
#[cfg(test)]
#[path = "transfer_publish_protocol_tests.rs"]
mod protocol_tests;
use super::{
    local_conflict_candidates, remote_conflict_candidates, remote_parent_path, AppError, AppResult,
    FileAttributes, OpenFlags, RusshSftpSession, SftpFile, SshConnectionChain,
    TransferConflictPolicy,
};
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{Packet, StatusCode},
};
use std::path::{Path, PathBuf};
use tokio::fs;

pub const SFTP_PUBLISH_OUTCOME_UNKNOWN: &str = "SFTP_PUBLISH_OUTCOME_UNKNOWN";
const POSIX_RENAME: &str = "posix-rename@openssh.com";

pub(super) fn outcome_unknown(error: &AppError) -> bool {
    error.to_string().contains(SFTP_PUBLISH_OUTCOME_UNKNOWN)
}

fn unknown_commit() -> AppError {
    AppError::sftp(format!(
        "{SFTP_PUBLISH_OUTCOME_UNKNOWN}: 发布结果未知，请先核对目标文件，禁止重试此传输"
    ))
}

pub(super) struct RemotePublisher {
    raw: RawSftpSession,
    posix_rename: bool,
}

impl RemotePublisher {
    #[cfg(test)]
    pub(super) fn for_test(raw: RawSftpSession, posix_rename: bool) -> Self {
        Self { raw, posix_rename }
    }

    pub(super) async fn new(connection: &SshConnectionChain) -> AppResult<Self> {
        let channel = connection.open_session_channel().await?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::sftp(e.to_string()))?;
        let raw = RawSftpSession::new(channel.into_stream());
        let version = match raw.init().await {
            Ok(version) => version,
            Err(error) => {
                let _ = raw.close_session();
                return Err(AppError::sftp(error.to_string()));
            }
        };
        Ok(Self {
            raw,
            posix_rename: version
                .extensions
                .get(POSIX_RENAME)
                .is_some_and(|v| v == "1"),
        })
    }

    pub(super) async fn check_overwrite(
        &self,
        sftp: &RusshSftpSession,
        target: &str,
        policy: TransferConflictPolicy,
    ) -> AppResult<()> {
        if matches!(policy, TransferConflictPolicy::Overwrite)
            && !self.posix_rename
            && sftp.try_exists(target).await.map_err(sftp_error)?
        {
            return Err(AppError::unsupported(
                "服务器未提供 posix-rename@openssh.com，无法安全覆盖已有文件",
            ));
        }
        Ok(())
    }

    pub(super) async fn publish(
        &self,
        sftp: &RusshSftpSession,
        partial: &str,
        target: &str,
        policy: TransferConflictPolicy,
    ) -> AppResult<()> {
        if matches!(policy, TransferConflictPolicy::Overwrite) && self.posix_rename {
            // Once sent, do not cancel or replay this request: a missing reply
            // cannot establish whether the server committed the replacement.
            return match self
                .raw
                .extended(POSIX_RENAME, rename_payload(partial, target))
                .await
            {
                Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => Ok(()),
                Ok(Packet::Status(status)) => Err(sftp_error(SftpError::Status(status))),
                _ => Err(unknown_commit()),
            };
        }
        let limit = if matches!(policy, TransferConflictPolicy::Rename) {
            1000
        } else {
            1
        };
        for candidate in remote_conflict_candidates(target).take(limit) {
            // SFTP v3 RENAME must fail if newpath exists. No delete fallback.
            match self.raw.rename(partial, candidate.clone()).await {
                Ok(_) => return Ok(()),
                Err(SftpError::Status(status)) => {
                    if !matches!(policy, TransferConflictPolicy::Overwrite)
                        && sftp.try_exists(&candidate).await.map_err(sftp_error)?
                    {
                        if matches!(policy, TransferConflictPolicy::Skip) {
                            sftp.remove_file(partial).await.map_err(sftp_error)?;
                            return Ok(());
                        }
                        continue;
                    }
                    return Err(sftp_error(SftpError::Status(status)));
                }
                Err(_) => return Err(unknown_commit()),
            }
        }
        Err(AppError::sftp("无法生成不冲突的远程文件名称"))
    }
}

impl Drop for RemotePublisher {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}

fn rename_payload(source: &str, target: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(source.len() + target.len() + 8);
    for value in [source, target] {
        data.extend_from_slice(&(value.len() as u32).to_be_bytes());
        data.extend_from_slice(value.as_bytes());
    }
    data
}

pub(super) fn sftp_error(error: SftpError) -> AppError {
    AppError::sftp(error.to_string())
}

pub(super) async fn remote_partial(
    sftp: &RusshSftpSession,
    target: &str,
) -> AppResult<(String, SftpFile)> {
    let parent = remote_parent_path(target).unwrap_or_else(|| ".".to_string());
    let partial = format!("{parent}/.zterm-{}.partial", uuid::Uuid::new_v4());
    let file = sftp
        .open_with_flags(
            &partial,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await
        .map_err(sftp_error)?;
    Ok((partial, file))
}

pub(super) async fn local_partial(target: &Path) -> AppResult<(PathBuf, fs::File)> {
    let partial = target.with_file_name(format!(".zterm-{}.partial", uuid::Uuid::new_v4()));
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&partial)
        .await?;
    if let Err(error) = inherit_local_target_permissions(&partial, target).await {
        drop(file);
        let _ = fs::remove_file(&partial).await;
        return Err(error.into());
    }
    Ok((partial, file))
}

async fn inherit_local_target_permissions(partial: &Path, target: &Path) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(target).await {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    #[cfg(windows)]
    {
        let _ = metadata;
        let target = windows_path(target)?;
        let partial = windows_path(partial)?;
        tokio::task::spawn_blocking(move || copy_windows_dacl(&target, &partial))
            .await
            .map_err(std::io::Error::other)?
    }
    #[cfg(not(windows))]
    {
        fs::set_permissions(partial, metadata.permissions()).await
    }
}

#[cfg(windows)]
fn copy_windows_dacl(target: &[u16], partial: &[u16]) -> std::io::Result<()> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::{
                Authorization::{GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT},
                GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION,
                PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
                UNPROTECTED_DACL_SECURITY_INFORMATION,
            },
        },
    };
    struct Descriptor(PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 .0)));
            }
        }
    }
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let result = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(target.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        )
    };
    if result.0 != 0 {
        return Err(std::io::Error::from_raw_os_error(result.0 as i32));
    }
    let descriptor = Descriptor(descriptor);
    let (mut control, mut revision) = (0, 0);
    unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) }
        .map_err(|_| std::io::Error::last_os_error())?;
    let protection = if control & SE_DACL_PROTECTED.0 != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let result = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(partial.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | protection,
            None,
            None,
            Some(dacl.cast_const()),
            None,
        )
    };
    if result.0 != 0 {
        return Err(std::io::Error::from_raw_os_error(result.0 as i32));
    }
    Ok(())
}

/// A staged overwrite replaces the inode, so preserve the existing regular
/// file's ownership and mode before commit. Do not silently replace symlinks.
pub(super) async fn preserve_remote_overwrite_metadata(
    sftp: &RusshSftpSession,
    partial: &str,
    target: &str,
    policy: TransferConflictPolicy,
) -> AppResult<()> {
    if !matches!(policy, TransferConflictPolicy::Overwrite) {
        return Ok(());
    }
    let target_attrs = match sftp.symlink_metadata(target).await {
        Ok(attrs) => attrs,
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
            return Ok(())
        }
        Err(error) => return Err(sftp_error(error)),
    };
    let Some(mode) = target_attrs.permissions else {
        return Err(AppError::unsupported(
            "服务器未返回目标文件类型与权限，无法安全覆盖",
        ));
    };
    match mode & 0o170000 {
        0o100000 => {}
        0o120000 => {
            return Err(AppError::unsupported(
                "原子覆盖不支持符号链接目标；请明确选择链接指向的普通文件",
            ))
        }
        _ => return Err(AppError::unsupported("原子覆盖仅支持可确认类型的普通文件")),
    }
    let staged = sftp.symlink_metadata(partial).await.map_err(sftp_error)?;
    match (target_attrs.uid, target_attrs.gid) {
        (Some(uid), Some(gid)) if staged.uid != Some(uid) || staged.gid != Some(gid) => {
            // chown may clear special permission bits; restore mode afterwards.
            sftp.set_metadata(
                partial,
                FileAttributes {
                    uid: Some(uid),
                    gid: Some(gid),
                    ..FileAttributes::empty()
                },
            )
            .await
            .map_err(sftp_error)?;
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err(AppError::unsupported(
                "服务器未完整返回目标所有者信息，无法安全覆盖",
            ))
        }
        _ => {}
    }
    sftp.set_metadata(
        partial,
        FileAttributes {
            permissions: Some(mode & 0o7777),
            ..FileAttributes::empty()
        },
    )
    .await
    .map_err(sftp_error)?;
    let applied = sftp.symlink_metadata(partial).await.map_err(sftp_error)?;
    if applied.permissions.map(|value| value & 0o7777) != Some(mode & 0o7777)
        || target_attrs.uid.is_some_and(|uid| applied.uid != Some(uid))
        || target_attrs.gid.is_some_and(|gid| applied.gid != Some(gid))
    {
        return Err(AppError::sftp(
            "临时文件未保留原目标权限或所有者，未发布目标文件",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_path(path: &Path) -> std::io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    let absolute = std::path::absolute(path)?;
    let raw: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    if raw.contains(&0) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "文件路径包含 NUL",
        ));
    }
    let mut wide: Vec<u16> = if raw.starts_with(&[92, 92, 63, 92]) {
        raw
    } else if raw.starts_with(&[92, 92]) {
        "\\\\?\\UNC\\"
            .encode_utf16()
            .chain(raw.into_iter().skip(2))
            .collect()
    } else {
        "\\\\?\\".encode_utf16().chain(raw).collect()
    };
    wide.push(0);
    Ok(wide)
}

#[cfg(windows)]
async fn publish_no_replace(partial: &Path, target: &Path) -> std::io::Result<()> {
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS},
    };
    let partial = windows_path(partial)?;
    let target = windows_path(target)?;
    tokio::task::spawn_blocking(move || {
        // flags=0 fails if the destination exists and works on FAT/exFAT.
        unsafe {
            MoveFileExW(
                PCWSTR(partial.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVE_FILE_FLAGS(0),
            )
        }
        .map_err(|_| std::io::Error::last_os_error())
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(windows)]
async fn replace_existing_local(
    partial: &Path,
    target: &Path,
    _: std::fs::Metadata,
) -> AppResult<()> {
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS},
    };
    let backup = target.with_file_name(format!(".zterm-backup-{}.partial", uuid::Uuid::new_v4()));
    let wide_partial = windows_path(partial)?;
    let wide_target = windows_path(target)?;
    let wide_backup = windows_path(&backup)?;
    let result = tokio::task::spawn_blocking(move || {
        // No IGNORE_* flags: ACL/stream merge failures must fail closed.
        unsafe {
            ReplaceFileW(
                PCWSTR(wide_target.as_ptr()),
                PCWSTR(wide_partial.as_ptr()),
                PCWSTR(wide_backup.as_ptr()),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        }
        .map_err(|_| std::io::Error::last_os_error())
    })
    .await
    .map_err(|_| unknown_commit())?;
    match result {
        Ok(()) => {
            // Replacement committed. A leftover backup is cleanup, not failure.
            let _ = fs::remove_file(backup).await;
            Ok(())
        }
        Err(error) if matches!(error.raw_os_error(), Some(1176 | 1177)) => Err(unknown_commit()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(not(windows))]
async fn replace_existing_local(
    partial: &Path,
    target: &Path,
    metadata: std::fs::Metadata,
) -> AppResult<()> {
    fs::set_permissions(partial, metadata.permissions()).await?;
    fs::rename(partial, target).await?;
    Ok(())
}

#[cfg(not(windows))]
async fn publish_no_replace(partial: &Path, target: &Path) -> std::io::Result<()> {
    fs::hard_link(partial, target).await?;
    // The final link has committed; cleanup cannot make the transfer retryable.
    let _ = fs::remove_file(partial).await;
    Ok(())
}

pub(super) async fn publish_local(
    partial: &Path,
    target: &Path,
    policy: TransferConflictPolicy,
) -> AppResult<()> {
    if matches!(policy, TransferConflictPolicy::Overwrite) {
        return match fs::symlink_metadata(target).await {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::unsupported(
                "原子覆盖不支持本地符号链接目标，请选择链接指向的普通文件",
            )),
            Ok(metadata) if metadata.is_file() => {
                replace_existing_local(partial, target, metadata).await
            }
            Ok(_) => Err(AppError::unsupported("原子覆盖仅支持本地普通文件")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                publish_no_replace(partial, target)
                    .await
                    .map_err(Into::into)
            }
            Err(error) => Err(error.into()),
        };
    }
    let limit = if matches!(policy, TransferConflictPolicy::Rename) {
        1000
    } else {
        1
    };
    for candidate in local_conflict_candidates(target).take(limit) {
        match publish_no_replace(partial, &candidate).await {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if matches!(policy, TransferConflictPolicy::Skip) {
                    fs::remove_file(partial).await?;
                    return Ok(());
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::sftp("无法生成不冲突的本地文件名称"))
}

pub(super) fn validate_remote_source(
    before: &FileAttributes,
    after: &FileAttributes,
    copied: u64,
) -> AppResult<()> {
    if before.size != after.size
        || before.mtime != after.mtime
        || before.size.is_some_and(|size| size != copied)
    {
        return Err(AppError::sftp(
            "传输期间源文件发生变化或传输长度不符，未发布目标文件",
        ));
    }
    Ok(())
}

pub(super) fn validate_local_source(
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
    copied: u64,
) -> AppResult<()> {
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || before.len() != copied
    {
        return Err(AppError::sftp(
            "传输期间源文件发生变化或传输长度不符，未发布目标文件",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use russh_sftp::protocol::{Attrs, Data, Handle, Status};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    #[derive(Clone)]
    struct MetadataServer {
        files: Arc<Mutex<HashMap<String, FileAttributes>>>,
        contents: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        writes: Arc<Mutex<Vec<FileAttributes>>>,
        reject: bool,
    }

    impl russh_sftp::server::Handler for MetadataServer {
        type Error = StatusCode;
        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }
        async fn open(
            &mut self,
            id: u32,
            path: String,
            _: OpenFlags,
            _: FileAttributes,
        ) -> Result<Handle, Self::Error> {
            if !self.files.lock().unwrap().contains_key(&path) {
                return Err(StatusCode::NoSuchFile);
            }
            Ok(Handle { id, handle: path })
        }
        async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            Ok(Attrs {
                id,
                attrs: self
                    .files
                    .lock()
                    .unwrap()
                    .get(&path)
                    .cloned()
                    .ok_or(StatusCode::NoSuchFile)?,
            })
        }
        async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
            self.lstat(id, handle).await
        }
        async fn read(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, Self::Error> {
            let contents = self.contents.lock().unwrap();
            let data = contents.get(&handle).ok_or(StatusCode::NoSuchFile)?;
            let start = usize::try_from(offset).map_err(|_| StatusCode::Eof)?;
            if start >= data.len() {
                return Err(StatusCode::Eof);
            }
            let end = start.saturating_add(len as usize).min(data.len());
            Ok(Data {
                id,
                data: data[start..end].to_vec(),
            })
        }
        async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
        async fn setstat(
            &mut self,
            id: u32,
            path: String,
            attrs: FileAttributes,
        ) -> Result<Status, Self::Error> {
            self.writes.lock().unwrap().push(attrs.clone());
            if self.reject {
                return Err(StatusCode::PermissionDenied);
            }
            let mut files = self.files.lock().unwrap();
            let file = files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
            // Model truncation rather than just inspecting the attribute patch:
            // FileAttributes::default() includes size=0 and would destroy data.
            if let Some(size) = attrs.size {
                self.contents
                    .lock()
                    .unwrap()
                    .get_mut(&path)
                    .ok_or(StatusCode::NoSuchFile)?
                    .resize(size as usize, 0);
                file.size = Some(size);
            }
            if let Some(atime) = attrs.atime {
                file.atime = Some(atime);
            }
            if let Some(mtime) = attrs.mtime {
                file.mtime = Some(mtime);
            }
            if let Some(uid) = attrs.uid {
                file.uid = Some(uid);
            }
            if let Some(gid) = attrs.gid {
                file.gid = Some(gid);
            }
            if let Some(mode) = attrs.permissions {
                file.permissions = Some((file.permissions.unwrap_or(0) & 0o170000) | mode);
            }
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
    }

    async fn fixture(mode: u32, reject: bool) -> (RusshSftpSession, MetadataServer) {
        let server = MetadataServer {
            files: Arc::new(Mutex::new(HashMap::from([
                (
                    "/target".into(),
                    FileAttributes {
                        size: Some(10),
                        mtime: Some(5),
                        permissions: Some(mode),
                        uid: Some(42),
                        gid: Some(43),
                        ..Default::default()
                    },
                ),
                (
                    "/partial".into(),
                    FileAttributes {
                        size: Some(20),
                        mtime: Some(9),
                        permissions: Some(0o100644),
                        uid: Some(1000),
                        gid: Some(1000),
                        ..Default::default()
                    },
                ),
            ]))),
            contents: Arc::new(Mutex::new(HashMap::from([
                ("/target".into(), b"old target".to_vec()),
                ("/partial".into(), b"new uploaded payload".to_vec()),
            ]))),
            writes: Arc::new(Mutex::new(Vec::new())),
            reject,
        };
        let (client, stream) = tokio::io::duplex(8192);
        russh_sftp::server::run(stream, server.clone()).await;
        (RusshSftpSession::new(client).await.unwrap(), server)
    }

    #[tokio::test]
    async fn remote_overwrite_preserves_mode_and_ownership_without_copying_old_size_or_times() {
        for mode in [0o100755, 0o100600, 0o104755] {
            let (sftp, server) = fixture(mode, false).await;
            let before = sftp.read("/partial").await.unwrap();
            assert_eq!(before, b"new uploaded payload");
            preserve_remote_overwrite_metadata(
                &sftp,
                "/partial",
                "/target",
                TransferConflictPolicy::Overwrite,
            )
            .await
            .unwrap();
            assert_eq!(sftp.read("/partial").await.unwrap(), before);
            {
                let writes = server.writes.lock().unwrap();
                assert_eq!(writes.len(), 2);
                assert_eq!(writes[0].uid, Some(42));
                assert_eq!(writes[0].gid, Some(43));
                assert_eq!(writes[0].permissions, None);
                assert_eq!(writes[0].size, None);
                assert_eq!(writes[0].atime, None);
                assert_eq!(writes[0].mtime, None);
                assert_eq!(writes[1].permissions, Some(mode & 0o7777));
                assert_eq!(writes[1].size, None);
                assert_eq!(writes[1].mtime, None);
            }
            let staged = server.files.lock().unwrap()["/partial"].clone();
            assert_eq!(staged.permissions, Some(mode));
            assert_eq!(staged.size, Some(20));
            assert_eq!(staged.mtime, Some(9));
            sftp.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn remote_overwrite_metadata_rejects_symlinks_and_failed_attribute_updates() {
        for (mode, reject) in [(0o120777, false), (0o040755, false), (0o100600, true)] {
            let (sftp, server) = fixture(mode, reject).await;
            assert!(preserve_remote_overwrite_metadata(
                &sftp,
                "/partial",
                "/target",
                TransferConflictPolicy::Overwrite
            )
            .await
            .is_err());
            assert_eq!(
                server.files.lock().unwrap()["/target"].permissions,
                Some(mode)
            );
            sftp.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn remote_overwrite_metadata_does_not_change_new_or_nonoverwrite_targets() {
        let (sftp, server) = fixture(0o100755, false).await;
        for policy in [TransferConflictPolicy::Skip, TransferConflictPolicy::Rename] {
            preserve_remote_overwrite_metadata(&sftp, "/partial", "/target", policy)
                .await
                .unwrap();
        }
        preserve_remote_overwrite_metadata(
            &sftp,
            "/partial",
            "/missing",
            TransferConflictPolicy::Overwrite,
        )
        .await
        .unwrap();
        assert!(server.writes.lock().unwrap().is_empty());
        sftp.close().await.unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::{Attrs, Data, Handle, Status};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    struct DownloadServer {
        changed: bool,
        read: bool,
    }

    impl russh_sftp::server::Handler for DownloadServer {
        type Error = StatusCode;
        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }
        async fn open(
            &mut self,
            id: u32,
            _: String,
            _: OpenFlags,
            _: FileAttributes,
        ) -> Result<Handle, Self::Error> {
            Ok(Handle {
                id,
                handle: "source".to_string(),
            })
        }
        async fn fstat(&mut self, id: u32, _: String) -> Result<Attrs, Self::Error> {
            Ok(Attrs {
                id,
                attrs: FileAttributes {
                    size: Some(4),
                    mtime: Some(if self.changed && self.read { 2 } else { 1 }),
                    ..Default::default()
                },
            })
        }
        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            self.fstat(id, path).await
        }
        async fn read(
            &mut self,
            id: u32,
            _: String,
            offset: u64,
            _: u32,
        ) -> Result<Data, Self::Error> {
            self.read = true;
            if offset >= 4 {
                return Err(StatusCode::Eof);
            }
            Ok(Data {
                id,
                data: b"data"[offset as usize..].to_vec(),
            })
        }
        async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
    }

    async fn download_session(changed: bool) -> RusshSftpSession {
        let (client, server) = tokio::io::duplex(8192);
        russh_sftp::server::run(
            server,
            DownloadServer {
                changed,
                read: false,
            },
        )
        .await;
        RusshSftpSession::new(client).await.unwrap()
    }

    #[tokio::test]
    async fn pipelined_download_does_not_replace_original_when_source_changes() {
        let dir = std::env::temp_dir().join(format!("zterm-download-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).await.unwrap();
        let target = dir.join("test.txt");
        fs::write(&target, b"original").await.unwrap();
        let sftp = download_session(true).await;
        let result = super::super::download_file(
            &sftp,
            "/source",
            &target,
            TransferConflictPolicy::Overwrite,
            0,
            None,
            &mut |_| Ok(()),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fs::read(&target).await.unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        sftp.close().await.unwrap();
        let sftp = download_session(false).await;
        super::super::download_file(
            &sftp,
            "/source",
            &target,
            TransferConflictPolicy::Overwrite,
            0,
            None,
            &mut |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(fs::read(&target).await.unwrap(), b"data");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        sftp.close().await.unwrap();
        fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_after_download_bytes_preserves_original() {
        use crate::services::transfer_queue::TransferRunControl;
        let dir = std::env::temp_dir().join(format!("zterm-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).await.unwrap();
        let target = dir.join("test.txt");
        fs::write(&target, b"original").await.unwrap();
        let sftp = download_session(false).await;
        let control = TransferRunControl::new();
        let result = super::super::download_file(
            &sftp,
            "/source",
            &target,
            TransferConflictPolicy::Overwrite,
            0,
            Some(&control),
            &mut |progress| {
                if progress.transferred_bytes > 0 {
                    control.cancel();
                }
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fs::read(&target).await.unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        sftp.close().await.unwrap();
        fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn missing_commit_reply_is_unknown_and_is_not_replayed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (client, mut server) = tokio::io::duplex(8192);
        let committed = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&committed);
        let peer = tokio::spawn(async move {
            let len = server.read_u32().await.unwrap();
            let mut packet = vec![0; len as usize];
            server.read_exact(&mut packet).await.unwrap();
            // Minimal SSH_FXP_VERSION, then consume exactly one EXTENDED.
            server
                .write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3])
                .await
                .unwrap();
            let len = server.read_u32().await.unwrap();
            let mut packet = vec![0; len as usize];
            server.read_exact(&mut packet).await.unwrap();
            assert_eq!(packet[0], 200);
            observed.store(true, Ordering::SeqCst);
            // Simulate successful server rename with its response lost.
        });
        let raw = RawSftpSession::new(client);
        raw.set_timeout(1);
        raw.init().await.unwrap();
        let publisher = RemotePublisher {
            raw,
            posix_rename: true,
        };
        let sftp = download_session(false).await;
        let error = publisher
            .publish(
                &sftp,
                "/partial",
                "/target",
                TransferConflictPolicy::Overwrite,
            )
            .await
            .unwrap_err();
        assert!(outcome_unknown(&error));
        assert!(committed.load(Ordering::SeqCst));
        peer.await.unwrap();
        sftp.close().await.unwrap();
    }

    #[tokio::test]
    async fn posix_publish_distinguishes_success_from_explicit_rejection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for code in [0_u32, 3] {
            let (client, mut server) = tokio::io::duplex(8192);
            let peer = tokio::spawn(async move {
                let len = server.read_u32().await.unwrap();
                let mut packet = vec![0; len as usize];
                server.read_exact(&mut packet).await.unwrap();
                server
                    .write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3])
                    .await
                    .unwrap();
                let len = server.read_u32().await.unwrap();
                let mut packet = vec![0; len as usize];
                server.read_exact(&mut packet).await.unwrap();
                assert_eq!(packet[0], 200);
                assert!(packet.ends_with(&rename_payload("/partial", "/target")));
                let mut reply = vec![0, 0, 0, 17, 101];
                reply.extend_from_slice(&packet[1..5]);
                reply.extend_from_slice(&code.to_be_bytes());
                reply.extend_from_slice(&[0; 8]);
                server.write_all(&reply).await.unwrap();
            });
            let raw = RawSftpSession::new(client);
            raw.init().await.unwrap();
            let publisher = RemotePublisher {
                raw,
                posix_rename: true,
            };
            let sftp = download_session(false).await;
            let result = publisher
                .publish(
                    &sftp,
                    "/partial",
                    "/target",
                    TransferConflictPolicy::Overwrite,
                )
                .await;
            if code == 0 {
                assert!(result.is_ok());
            } else {
                assert!(!outcome_unknown(&result.unwrap_err()));
            }
            peer.await.unwrap();
            sftp.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn missing_posix_extension_rejects_existing_target_before_writing() {
        let (client, _server) = tokio::io::duplex(8192);
        let publisher = RemotePublisher {
            raw: RawSftpSession::new(client),
            posix_rename: false,
        };
        let sftp = download_session(false).await;
        assert!(matches!(
            publisher
                .check_overwrite(&sftp, "/target", TransferConflictPolicy::Overwrite)
                .await,
            Err(AppError::Unsupported(_))
        ));
        sftp.close().await.unwrap();
    }

    #[test]
    fn publish_payload_uses_utf8_byte_lengths() {
        assert_eq!(
            rename_payload("a", "b"),
            vec![0, 0, 0, 1, b'a', 0, 0, 0, 1, b'b']
        );
        assert_eq!(&rename_payload("中", "b")[..4], &[0, 0, 0, 3]);
    }

    #[test]
    fn changed_or_truncated_remote_source_is_not_publishable() {
        let before = FileAttributes {
            size: Some(8),
            mtime: Some(5),
            ..Default::default()
        };
        assert!(validate_remote_source(&before, &before, 7).is_err());
        let changed = FileAttributes {
            mtime: Some(6),
            ..before.clone()
        };
        assert!(validate_remote_source(&before, &changed, 8).is_err());
        assert!(validate_remote_source(&before, &before, 8).is_ok());
    }

    #[tokio::test]
    async fn staged_local_overwrite_of_new_target_publishes_without_replacing_racing_files() {
        let dir = std::env::temp_dir().join(format!("zterm-no-replace-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).await.unwrap();
        let target = dir.join("new.txt");
        let (partial, file) = local_partial(&target).await.unwrap();
        drop(file);
        fs::write(&partial, b"complete").await.unwrap();
        publish_local(&partial, &target, TransferConflictPolicy::Overwrite)
            .await
            .unwrap();
        assert_eq!(fs::read(&target).await.unwrap(), b"complete");
        let (partial, file) = local_partial(&target).await.unwrap();
        drop(file);
        fs::write(&partial, b"must not win").await.unwrap();
        assert_eq!(
            publish_no_replace(&partial, &target)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&target).await.unwrap(), b"complete");
        assert_eq!(fs::read(&partial).await.unwrap(), b"must not win");
        fs::remove_dir_all(dir).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn staged_local_overwrite_preserves_unix_mode_and_rejects_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("zterm-unix-mode-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).await.unwrap();
        let target = dir.join("script");
        fs::write(&target, b"original").await.unwrap();
        fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750))
            .await
            .unwrap();
        let (partial, file) = local_partial(&target).await.unwrap();
        drop(file);
        assert_eq!(
            fs::metadata(&partial).await.unwrap().permissions().mode() & 0o7777,
            0o750
        );
        fs::write(&partial, b"complete").await.unwrap();
        publish_local(&partial, &target, TransferConflictPolicy::Overwrite)
            .await
            .unwrap();
        assert_eq!(
            fs::metadata(&target).await.unwrap().permissions().mode() & 0o7777,
            0o750
        );
        let link = dir.join("link");
        symlink(&target, &link).unwrap();
        let (partial, file) = local_partial(&link).await.unwrap();
        drop(file);
        assert!(
            publish_local(&partial, &link, TransferConflictPolicy::Overwrite)
                .await
                .is_err()
        );
        assert!(fs::symlink_metadata(&link)
            .await
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&target).await.unwrap(), b"complete");
        fs::remove_dir_all(dir).await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn staged_local_overwrite_preserves_windows_acl() {
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{LocalFree, HLOCAL},
                Security::{
                    Authorization::{
                        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                    },
                    GetFileSecurityW, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
                    SetFileSecurityW, ACL, DACL_SECURITY_INFORMATION,
                    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
                },
            },
        };
        fn dacl(path: &Path) -> (Vec<u8>, bool) {
            let wide = windows_path(path).unwrap();
            let mut needed = 0;
            unsafe {
                let _ = GetFileSecurityW(
                    PCWSTR(wide.as_ptr()),
                    DACL_SECURITY_INFORMATION.0,
                    None,
                    0,
                    &mut needed,
                );
            }
            assert!(needed > 0);
            let mut buffer = vec![0u8; needed as usize];
            unsafe {
                GetFileSecurityW(
                    PCWSTR(wide.as_ptr()),
                    DACL_SECURITY_INFORMATION.0,
                    Some(PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast())),
                    needed,
                    &mut needed,
                )
                .ok()
                .unwrap();
            }
            let descriptor = PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast());
            let (mut control, mut revision) = (0, 0);
            let (mut present, mut defaulted) = (Default::default(), Default::default());
            let mut acl: *mut ACL = std::ptr::null_mut();
            unsafe {
                GetSecurityDescriptorControl(descriptor, &mut control, &mut revision).unwrap();
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
                    .unwrap();
                assert!(present.as_bool());
                assert!(!acl.is_null());
                (
                    std::slice::from_raw_parts(acl.cast::<u8>(), (*acl).AclSize as usize).to_vec(),
                    control & SE_DACL_PROTECTED.0 != 0,
                )
            }
        }
        let dir = std::env::temp_dir().join(format!("zterm-win-acl-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).await.unwrap();
        let target = dir.join("target");
        fs::write(&target, b"original").await.unwrap();
        let wide = windows_path(&target).unwrap();
        let sddl: Vec<u16> = "D:P(A;;FA;;;OW)(A;;FR;;;WD)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .unwrap();
            let applied = SetFileSecurityW(
                PCWSTR(wide.as_ptr()),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            );
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            applied.ok().unwrap();
        }
        let before = dacl(&target);
        let (partial, file) = local_partial(&target).await.unwrap();
        drop(file);
        assert_eq!(
            dacl(&partial),
            before,
            "staging must inherit the existing target ACL before writes"
        );
        fs::write(&partial, b"complete").await.unwrap();
        publish_local(&partial, &target, TransferConflictPolicy::Overwrite)
            .await
            .unwrap();
        assert_eq!(fs::read(&target).await.unwrap(), b"complete");
        assert_eq!(dacl(&target), before);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn staged_local_publish_preserves_original_until_commit_and_honors_conflicts() {
        let dir = std::env::temp_dir().join(format!("zterm-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).await.unwrap();
        let target = dir.join("test.txt");
        fs::write(&target, b"original").await.unwrap();
        for policy in [
            TransferConflictPolicy::Skip,
            TransferConflictPolicy::Rename,
            TransferConflictPolicy::Overwrite,
        ] {
            let (partial, file) = local_partial(&target).await.unwrap();
            drop(file);
            fs::write(&partial, b"completed").await.unwrap();
            assert_eq!(fs::read(&target).await.unwrap(), b"original");
            publish_local(&partial, &target, policy).await.unwrap();
            assert!(!partial.exists());
        }
        assert_eq!(fs::read(&target).await.unwrap(), b"completed");
        assert_eq!(
            fs::read(dir.join("test (1).txt")).await.unwrap(),
            b"completed"
        );
        fs::remove_dir_all(dir).await.unwrap();
    }
}
