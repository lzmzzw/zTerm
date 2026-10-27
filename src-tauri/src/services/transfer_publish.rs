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
        .write(true)
        .create_new(true)
        .open(&partial)
        .await?;
    Ok((partial, file))
}

pub(super) async fn publish_local(
    partial: &Path,
    target: &Path,
    policy: TransferConflictPolicy,
) -> AppResult<()> {
    if matches!(policy, TransferConflictPolicy::Overwrite) {
        // Rust uses MoveFileExW(REPLACE_EXISTING) on Windows. Both paths are
        // in the same directory; never remove the original before replacement.
        fs::rename(partial, target).await?;
        return Ok(());
    }
    let limit = if matches!(policy, TransferConflictPolicy::Rename) {
        1000
    } else {
        1
    };
    for candidate in local_conflict_candidates(target).take(limit) {
        match fs::hard_link(partial, &candidate).await {
            Ok(()) => {
                // The final link has committed; cleanup failure must not turn
                // this into a retryable failed transfer.
                let _ = fs::remove_file(partial).await;
                return Ok(());
            }
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
