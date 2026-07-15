// Author: Liz
use std::{
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

use suppaftp::{list::File, tokio::AsyncFtpStream, types::FileType as FtpTransferType, Mode};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
};

use crate::{
    error::{AppError, AppResult},
    models::{
        session::{SavedSession, SessionType},
        sftp::{FileEntry, FileKind, TransferConflictPolicy, TransferKind},
    },
    services::{
        credential_service::CredentialService, sftp_service::TransferProgressUpdate,
        transfer_queue::TransferRunControl,
    },
};

const BUFFER_SIZE: usize = 64 * 1024;

pub async fn test_connection(
    session: &SavedSession,
    credentials: &CredentialService,
    transient_secret: Option<&str>,
) -> AppResult<()> {
    let mut ftp = connect(session, credentials, transient_secret).await?;
    ftp.pwd().await.map_err(ftp_error)?;
    let _ = ftp.quit().await;
    Ok(())
}

pub async fn list(
    session: &SavedSession,
    credentials: &CredentialService,
    path: &str,
) -> AppResult<Vec<FileEntry>> {
    let mut ftp = connect(session, credentials, None).await?;
    let lines = ftp
        .list(Some(required_remote_path(path)?))
        .await
        .map_err(ftp_error)?;
    let mut entries = lines
        .into_iter()
        .filter_map(|line| File::try_from(line.as_str()).ok())
        .filter(|file| safe_entry_name(file.name()).is_some())
        .map(|file| {
            let kind = if file.is_directory() {
                FileKind::Directory
            } else if file.is_symlink() {
                FileKind::Symlink
            } else {
                FileKind::File
            };
            let modified_at_ms = file
                .modified()
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|value| i64::try_from(value.as_millis()).ok());
            FileEntry {
                name: file.name().to_string(),
                path: join_remote_path(path, file.name()),
                kind,
                size: file.size() as u64,
                modified_at_ms,
                permissions: None,
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    let _ = ftp.quit().await;
    Ok(entries)
}

pub async fn exists(
    session: &SavedSession,
    credentials: &CredentialService,
    path: &str,
) -> AppResult<bool> {
    let mut ftp = connect(session, credentials, None).await?;
    let exists = ftp.size(path).await.is_ok() || ftp.cwd(path).await.is_ok();
    let _ = ftp.quit().await;
    Ok(exists)
}

pub async fn rename(
    session: &SavedSession,
    credentials: &CredentialService,
    from: &str,
    to: &str,
) -> AppResult<()> {
    let mut ftp = connect(session, credentials, None).await?;
    ftp.rename(required_remote_path(from)?, required_remote_path(to)?)
        .await
        .map_err(ftp_error)?;
    let _ = ftp.quit().await;
    Ok(())
}

pub async fn delete(
    session: &SavedSession,
    credentials: &CredentialService,
    path: &str,
    recursive: bool,
) -> AppResult<()> {
    let path = required_destructive_path(path)?.to_string();
    let mut ftp = connect(session, credentials, None).await?;
    if is_directory(&mut ftp, &path).await {
        if recursive {
            remove_directory_recursive(&mut ftp, &path).await?;
        } else {
            ftp.rmdir(&path).await.map_err(ftp_error)?;
        }
    } else {
        ftp.rm(&path).await.map_err(ftp_error)?;
    }
    let _ = ftp.quit().await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn upload_path<F>(
    session: &SavedSession,
    credentials: &CredentialService,
    local_path: &str,
    remote_path: &str,
    kind: Option<TransferKind>,
    conflict_policy: TransferConflictPolicy,
    control: Option<TransferRunControl>,
    mut on_progress: F,
) -> AppResult<()>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    let local_path = PathBuf::from(local_path);
    let metadata = fs::metadata(&local_path).await?;
    let mut ftp = connect(session, credentials, None).await?;
    let mut transferred = 0_u64;
    checkpoint(control.as_ref()).await?;
    if metadata.is_dir() || kind == Some(TransferKind::Directory) {
        let Some(remote_root) =
            remote_directory_conflict_path(&mut ftp, remote_path, conflict_policy).await?
        else {
            let _ = ftp.quit().await;
            return Ok(());
        };
        ensure_directory(&mut ftp, &remote_root).await?;
        let mut stack = vec![(local_path, remote_root)];
        while let Some((local_dir, remote_dir)) = stack.pop() {
            let mut children = fs::read_dir(local_dir).await?;
            while let Some(child) = children.next_entry().await? {
                checkpoint(control.as_ref()).await?;
                let remote_child =
                    join_remote_path(&remote_dir, &child.file_name().to_string_lossy());
                if child.file_type().await?.is_dir() {
                    ensure_directory(&mut ftp, &remote_child).await?;
                    stack.push((child.path(), remote_child));
                } else {
                    transferred = upload_file(
                        &mut ftp,
                        &child.path(),
                        &remote_child,
                        conflict_policy,
                        transferred,
                        control.as_ref(),
                        &mut on_progress,
                    )
                    .await?;
                }
            }
        }
    } else {
        transferred = upload_file(
            &mut ftp,
            &local_path,
            remote_path,
            conflict_policy,
            transferred,
            control.as_ref(),
            &mut on_progress,
        )
        .await?;
    }
    on_progress(TransferProgressUpdate {
        transferred_bytes: transferred,
        total_bytes: None,
    })?;
    let _ = ftp.quit().await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn download_path<F>(
    session: &SavedSession,
    credentials: &CredentialService,
    remote_path: &str,
    local_path: &str,
    kind: Option<TransferKind>,
    conflict_policy: TransferConflictPolicy,
    control: Option<TransferRunControl>,
    mut on_progress: F,
) -> AppResult<()>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    let mut ftp = connect(session, credentials, None).await?;
    let local_path = PathBuf::from(local_path);
    let directory =
        kind == Some(TransferKind::Directory) || is_directory(&mut ftp, remote_path).await;
    let mut transferred = 0_u64;
    if directory {
        let Some(local_root) = local_directory_conflict_path(&local_path, conflict_policy)? else {
            let _ = ftp.quit().await;
            return Ok(());
        };
        fs::create_dir_all(&local_root).await?;
        let mut stack = vec![(remote_path.to_string(), local_root)];
        while let Some((remote_dir, local_dir)) = stack.pop() {
            fs::create_dir_all(&local_dir).await?;
            for entry in ftp.list(Some(&remote_dir)).await.map_err(ftp_error)? {
                let Ok(file) = File::try_from(entry.as_str()) else {
                    continue;
                };
                let Some(entry_name) = safe_entry_name(file.name()) else {
                    continue;
                };
                let remote_child = join_remote_path(&remote_dir, entry_name);
                let local_child = local_dir.join(entry_name);
                if file.is_directory() {
                    stack.push((remote_child, local_child));
                } else {
                    transferred = download_file(
                        &mut ftp,
                        &remote_child,
                        &local_child,
                        conflict_policy,
                        transferred,
                        control.as_ref(),
                        &mut on_progress,
                    )
                    .await?;
                }
            }
        }
    } else {
        transferred = download_file(
            &mut ftp,
            remote_path,
            &local_path,
            conflict_policy,
            transferred,
            control.as_ref(),
            &mut on_progress,
        )
        .await?;
    }
    on_progress(TransferProgressUpdate {
        transferred_bytes: transferred,
        total_bytes: None,
    })?;
    let _ = ftp.quit().await;
    Ok(())
}

async fn connect(
    session: &SavedSession,
    credentials: &CredentialService,
    transient_secret: Option<&str>,
) -> AppResult<AsyncFtpStream> {
    if session.session_type != SessionType::Ftp {
        return Err(AppError::unsupported("FTP 服务只支持 FTP 会话"));
    }
    let address = format!("{}:{}", session.host.trim(), session.port);
    let timeout = Duration::from_millis(
        session
            .ftp_options
            .as_ref()
            .and_then(|options| options.connect_timeout_ms)
            .unwrap_or(30_000),
    );
    let mut ftp = tokio::time::timeout(timeout, AsyncFtpStream::connect(address))
        .await
        .map_err(|_| AppError::ftp("FTP 连接超时"))?
        .map_err(ftp_error)?;
    if !session
        .ftp_options
        .as_ref()
        .map(|options| options.passive_mode)
        .unwrap_or(true)
    {
        ftp.set_mode(Mode::Active);
    }
    let anonymous = session
        .ftp_options
        .as_ref()
        .map(|options| options.anonymous)
        .unwrap_or(false);
    let username = if anonymous {
        "anonymous"
    } else {
        session.username.trim()
    };
    let password = if anonymous {
        "anonymous@".to_string()
    } else if let Some(secret) = transient_secret {
        secret.to_string()
    } else {
        let reference = session
            .credential_ref
            .as_deref()
            .ok_or_else(|| AppError::credential("FTP 密码凭据引用不能为空"))?;
        credentials.read_secret(reference)?
    };
    ftp.login(username, &password).await.map_err(ftp_error)?;
    ftp.transfer_type(FtpTransferType::Binary)
        .await
        .map_err(ftp_error)?;
    Ok(ftp)
}

async fn upload_file<F>(
    ftp: &mut AsyncFtpStream,
    local: &Path,
    remote: &str,
    policy: TransferConflictPolicy,
    mut transferred: u64,
    control: Option<&TransferRunControl>,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    let Some(remote) = conflict_path(ftp, remote, policy).await? else {
        return Ok(transferred);
    };
    let mut source = fs::File::open(local).await?;
    let mut destination = ftp.put_with_stream(&remote).await.map_err(ftp_error)?;
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        checkpoint(control).await?;
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        destination
            .write_all(&buffer[..read])
            .await
            .map_err(|error| AppError::ftp(error.to_string()))?;
        transferred += read as u64;
        on_progress(TransferProgressUpdate {
            transferred_bytes: transferred,
            total_bytes: None,
        })?;
    }
    ftp.finalize_put_stream(destination)
        .await
        .map_err(ftp_error)?;
    Ok(transferred)
}

async fn download_file<F>(
    ftp: &mut AsyncFtpStream,
    remote: &str,
    local: &Path,
    policy: TransferConflictPolicy,
    mut transferred: u64,
    control: Option<&TransferRunControl>,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    let Some(local) = local_conflict_path(local, policy).await? else {
        return Ok(transferred);
    };
    if let Some(parent) = local.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut source = ftp.retr_as_stream(remote).await.map_err(ftp_error)?;
    let mut destination = fs::File::create(&local).await?;
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        checkpoint(control).await?;
        let read = source
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::ftp(error.to_string()))?;
        if read == 0 {
            break;
        }
        destination.write_all(&buffer[..read]).await?;
        transferred += read as u64;
        on_progress(TransferProgressUpdate {
            transferred_bytes: transferred,
            total_bytes: None,
        })?;
    }
    destination.flush().await?;
    ftp.finalize_retr_stream(source).await.map_err(ftp_error)?;
    Ok(transferred)
}

async fn conflict_path(
    ftp: &mut AsyncFtpStream,
    path: &str,
    policy: TransferConflictPolicy,
) -> AppResult<Option<String>> {
    if ftp.size(path).await.is_err() {
        return Ok(Some(path.to_string()));
    }
    match policy {
        TransferConflictPolicy::Overwrite => Ok(Some(path.to_string())),
        TransferConflictPolicy::Skip => Ok(None),
        TransferConflictPolicy::Rename => {
            for index in 1..1000 {
                let candidate = suffixed_remote_path(path, index);
                if ftp.size(&candidate).await.is_err() {
                    return Ok(Some(candidate));
                }
            }
            Err(AppError::ftp("无法为 FTP 目标生成可用名称"))
        }
    }
}

async fn local_conflict_path(
    path: &Path,
    policy: TransferConflictPolicy,
) -> AppResult<Option<PathBuf>> {
    if !path.exists() {
        return Ok(Some(path.to_path_buf()));
    }
    match policy {
        TransferConflictPolicy::Overwrite => Ok(Some(path.to_path_buf())),
        TransferConflictPolicy::Skip => Ok(None),
        TransferConflictPolicy::Rename => {
            for index in 1..1000 {
                let candidate = suffixed_local_path(path, index);
                if !candidate.exists() {
                    return Ok(Some(candidate));
                }
            }
            Err(AppError::ftp("无法为本地目标生成可用名称"))
        }
    }
}

async fn ensure_directory(ftp: &mut AsyncFtpStream, path: &str) -> AppResult<()> {
    let mut current = String::new();
    for segment in path.split('/').filter(|value| !value.is_empty()) {
        current.push('/');
        current.push_str(segment);
        if !is_directory(ftp, &current).await {
            if let Err(error) = ftp.mkdir(&current).await {
                if !is_directory(ftp, &current).await {
                    return Err(ftp_error(error));
                }
            }
        }
    }
    Ok(())
}

async fn remote_directory_conflict_path(
    ftp: &mut AsyncFtpStream,
    path: &str,
    policy: TransferConflictPolicy,
) -> AppResult<Option<String>> {
    if !remote_exists(ftp, path).await {
        return Ok(Some(path.to_string()));
    }
    match policy {
        TransferConflictPolicy::Overwrite => Ok(Some(path.to_string())),
        TransferConflictPolicy::Skip => Ok(None),
        TransferConflictPolicy::Rename => {
            for index in 1..1000 {
                let candidate = format!("{} ({index})", path.trim_end_matches('/'));
                if !remote_exists(ftp, &candidate).await {
                    return Ok(Some(candidate));
                }
            }
            Err(AppError::ftp("无法为 FTP 目录生成可用名称"))
        }
    }
}

fn local_directory_conflict_path(
    path: &Path,
    policy: TransferConflictPolicy,
) -> AppResult<Option<PathBuf>> {
    if !path.exists() {
        return Ok(Some(path.to_path_buf()));
    }
    match policy {
        TransferConflictPolicy::Overwrite => Ok(Some(path.to_path_buf())),
        TransferConflictPolicy::Skip => Ok(None),
        TransferConflictPolicy::Rename => {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("directory");
            for index in 1..1000 {
                let candidate = path.with_file_name(format!("{name} ({index})"));
                if !candidate.exists() {
                    return Ok(Some(candidate));
                }
            }
            Err(AppError::ftp("无法为本地目录生成可用名称"))
        }
    }
}

async fn remote_exists(ftp: &mut AsyncFtpStream, path: &str) -> bool {
    ftp.size(path).await.is_ok() || is_directory(ftp, path).await
}

async fn remove_directory_recursive(ftp: &mut AsyncFtpStream, root: &str) -> AppResult<()> {
    let mut stack = vec![(root.to_string(), false)];
    while let Some((path, visited)) = stack.pop() {
        if visited {
            ftp.rmdir(&path).await.map_err(ftp_error)?;
            continue;
        }
        stack.push((path.clone(), true));
        for line in ftp.list(Some(&path)).await.map_err(ftp_error)? {
            let Ok(file) = File::try_from(line.as_str()) else {
                continue;
            };
            let Some(entry_name) = safe_entry_name(file.name()) else {
                continue;
            };
            let child = join_remote_path(&path, entry_name);
            if file.is_directory() {
                stack.push((child, false));
            } else {
                ftp.rm(&child).await.map_err(ftp_error)?;
            }
        }
    }
    Ok(())
}

async fn is_directory(ftp: &mut AsyncFtpStream, path: &str) -> bool {
    let original = ftp.pwd().await.ok();
    let result = ftp.cwd(path).await.is_ok();
    if let Some(original) = original {
        let _ = ftp.cwd(original).await;
    }
    result
}
async fn checkpoint(control: Option<&TransferRunControl>) -> AppResult<()> {
    if let Some(control) = control {
        control.checkpoint().await?;
    }
    Ok(())
}
fn required_remote_path(path: &str) -> AppResult<&str> {
    let path = path.trim();
    if path.is_empty() {
        Err(AppError::validation("FTP 路径不能为空"))
    } else {
        Ok(path)
    }
}
fn required_destructive_path(path: &str) -> AppResult<&str> {
    let path = required_remote_path(path)?;
    if path == "/" {
        Err(AppError::validation("不允许修改 FTP 根目录"))
    } else {
        Ok(path)
    }
}
fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}
fn safe_entry_name(name: &str) -> Option<&str> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        None
    } else {
        Some(name)
    }
}
fn suffixed_remote_path(path: &str, index: usize) -> String {
    let (stem, extension) = split_name(path);
    format!("{stem} ({index}){extension}")
}
fn split_name(path: &str) -> (&str, &str) {
    match path
        .rfind('.')
        .filter(|index| *index > path.rfind('/').unwrap_or(0))
    {
        Some(index) => path.split_at(index),
        None => (path, ""),
    }
}
fn suffixed_local_path(path: &Path, index: usize) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());
    let name = extension
        .map(|ext| format!("{stem} ({index}).{ext}"))
        .unwrap_or_else(|| format!("{stem} ({index})"));
    path.with_file_name(name)
}
fn ftp_error(error: impl std::fmt::Display) -> AppError {
    AppError::ftp(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    use super::*;
    use crate::{models::session::FtpOptions, storage::sqlite::SqliteStore};

    #[tokio::test]
    async fn anonymous_connection_test_completes_the_ftp_control_flow() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let port = listener.local_addr().expect("listener address").port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("client should connect");
            let (reader, mut writer) = stream.into_split();
            let mut lines = BufReader::new(reader).lines();
            writer
                .write_all(b"220 Test FTP ready\r\n")
                .await
                .expect("welcome should write");
            let mut commands = Vec::new();
            while let Some(line) = lines.next_line().await.expect("command should read") {
                commands.push(line.clone());
                let response = if line.starts_with("USER ") {
                    "331 Password required\r\n"
                } else if line.starts_with("PASS ") {
                    "230 Logged in\r\n"
                } else if line == "TYPE I" {
                    "200 Binary mode\r\n"
                } else if line == "PWD" {
                    "257 \"/\" is current directory\r\n"
                } else if line == "QUIT" {
                    "221 Bye\r\n"
                } else {
                    "500 Unexpected command\r\n"
                };
                writer
                    .write_all(response.as_bytes())
                    .await
                    .expect("response should write");
                if line == "QUIT" {
                    break;
                }
            }
            commands
        });
        let credentials = CredentialService::new(Arc::new(
            SqliteStore::open_in_memory().expect("store should open"),
        ));
        let session = SavedSession {
            id: "ftp-test".to_string(),
            name: "FTP Test".to_string(),
            session_type: SessionType::Ftp,
            group_id: None,
            host: "127.0.0.1".to_string(),
            port,
            username: "".to_string(),
            auth_mode: crate::models::session::AuthMode::None,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_used_at_ms: None,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: Some(FtpOptions {
                connect_timeout_ms: Some(2_000),
                initial_directory: Some("/".to_string()),
                passive_mode: true,
                anonymous: true,
            }),
        };

        test_connection(&session, &credentials, None)
            .await
            .expect("FTP connection should pass");
        let commands = server.await.expect("server should finish");
        assert_eq!(
            commands,
            ["USER anonymous", "PASS anonymous@", "TYPE I", "PWD", "QUIT"]
        );
    }

    #[test]
    fn destructive_paths_and_rename_suffixes_are_bounded() {
        assert!(required_destructive_path("/").is_err());
        assert_eq!(safe_entry_name("release.txt"), Some("release.txt"));
        assert_eq!(safe_entry_name(".."), None);
        assert_eq!(safe_entry_name("../outside.txt"), None);
        assert_eq!(safe_entry_name("..\\outside.txt"), None);
        assert_eq!(
            suffixed_remote_path("/release/app.tar.gz", 2),
            "/release/app.tar (2).gz"
        );
        let directory =
            std::env::temp_dir().join(format!("zterm-ftp-directory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("source directory should exist");
        let renamed = local_directory_conflict_path(&directory, TransferConflictPolicy::Rename)
            .expect("rename policy should resolve")
            .expect("rename policy should keep transfer");
        let expected_name = format!(
            "{} (1)",
            directory
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap()
        );
        assert_eq!(
            renamed.file_name().and_then(|value| value.to_str()),
            Some(expected_name.as_str())
        );
        std::fs::remove_dir_all(directory).expect("source directory should clean up");
    }
}
