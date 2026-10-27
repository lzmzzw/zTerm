use super::*;
use russh_sftp::protocol::{Attrs, Handle, Status};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone, Default)]
struct FileServer {
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    renames: Arc<AtomicUsize>,
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

impl russh_sftp::server::Handler for FileServer {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut files = self.files.lock().unwrap();
        if flags.contains(OpenFlags::CREATE) {
            if flags.contains(OpenFlags::EXCLUDE) && files.contains_key(&filename) {
                return Err(StatusCode::Failure);
            }
            files.entry(filename.clone()).or_default();
        }
        if !files.contains_key(&filename) {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Handle {
            id,
            handle: filename,
        })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let files = self.files.lock().unwrap();
        let file = files.get(&handle).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(file.len() as u64),
                mtime: Some(1),
                permissions: Some(0o100600),
                uid: Some(1),
                gid: Some(1),
                ..Default::default()
            },
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.fstat(id, path).await
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.fstat(id, path).await
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let mut files = self.files.lock().unwrap();
        let bytes = files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        if let Some(size) = attrs.size {
            bytes.resize(size as usize, 0);
        }
        assert!(
            attrs.size.is_none(),
            "permission updates must never truncate file data"
        );
        Ok(ok(id))
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let mut files = self.files.lock().unwrap();
        let file = files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        let end = offset as usize + data.len();
        file.resize(file.len().max(end), 0);
        file[offset as usize..end].copy_from_slice(&data);
        Ok(ok(id))
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(ok(id))
    }
    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        self.files
            .lock()
            .unwrap()
            .remove(&filename)
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(ok(id))
    }
    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        self.renames.fetch_add(1, Ordering::SeqCst);
        let mut files = self.files.lock().unwrap();
        if files.contains_key(&newpath) {
            return Err(StatusCode::Failure);
        }
        let data = files.remove(&oldpath).ok_or(StatusCode::NoSuchFile)?;
        files.insert(newpath, data);
        Ok(ok(id))
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        if request != POSIX_RENAME {
            return Err(StatusCode::OpUnsupported);
        }
        self.renames.fetch_add(1, Ordering::SeqCst);
        let len = u32::from_be_bytes(data[..4].try_into().unwrap()) as usize;
        let old = String::from_utf8(data[4..4 + len].to_vec()).unwrap();
        let offset = 4 + len;
        let len = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
        let new = String::from_utf8(data[offset + 4..offset + 4 + len].to_vec()).unwrap();
        let mut files = self.files.lock().unwrap();
        let bytes = files.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        files.insert(new, bytes);
        Ok(Packet::Status(ok(id)))
    }
}

async fn sessions(server: &FileServer, posix: bool) -> (RusshSftpSession, RemotePublisher) {
    let (client, peer) = tokio::io::duplex(262144);
    russh_sftp::server::run(peer, server.clone()).await;
    let sftp = RusshSftpSession::new(client).await.unwrap();
    let (client, peer) = tokio::io::duplex(8192);
    russh_sftp::server::run(peer, server.clone()).await;
    let raw = RawSftpSession::new(client);
    raw.init().await.unwrap();
    (
        sftp,
        RemotePublisher {
            raw,
            posix_rename: posix,
        },
    )
}

#[tokio::test]
async fn upload_publishes_complete_file_and_no_posix_preserves_original() {
    let source = std::env::temp_dir().join(format!("zterm-upload-{}", uuid::Uuid::new_v4()));
    fs::write(&source, b"complete upload").await.unwrap();
    for posix in [false, true] {
        let server = FileServer::default();
        server
            .files
            .lock()
            .unwrap()
            .insert("/target".into(), b"original".to_vec());
        let (sftp, publisher) = sessions(&server, posix).await;
        let result = super::super::upload_file(
            &sftp,
            &publisher,
            &source,
            "/target",
            TransferConflictPolicy::Overwrite,
            0,
            None,
            &mut |_| Ok(()),
        )
        .await;
        if posix {
            assert_eq!(result.unwrap(), 15);
            assert_eq!(
                server.files.lock().unwrap().get("/target").unwrap(),
                b"complete upload"
            );
            assert_eq!(server.renames.load(Ordering::SeqCst), 1);
        } else {
            assert!(matches!(result, Err(AppError::Unsupported(_))));
            assert_eq!(
                server.files.lock().unwrap().get("/target").unwrap(),
                b"original"
            );
            assert_eq!(server.renames.load(Ordering::SeqCst), 0);
        }
        assert_eq!(server.files.lock().unwrap().len(), 1);
        sftp.close().await.unwrap();
    }
    fs::remove_file(source).await.unwrap();
}

#[tokio::test]
async fn remote_no_replace_commit_handles_skip_and_rename_races() {
    for policy in [
        TransferConflictPolicy::Skip,
        TransferConflictPolicy::Rename,
        TransferConflictPolicy::Overwrite,
    ] {
        let server = FileServer::default();
        {
            let mut files = server.files.lock().unwrap();
            files.insert("/target.txt".into(), b"original".to_vec());
            files.insert("/target (1).txt".into(), b"other".to_vec());
            files.insert("/partial".into(), b"completed".to_vec());
        }
        let (sftp, publisher) = sessions(&server, false).await;
        let result = publisher
            .publish(&sftp, "/partial", "/target.txt", policy)
            .await;
        {
            let files = server.files.lock().unwrap();
            assert_eq!(files.get("/target.txt").unwrap(), b"original");
            assert_eq!(files.get("/target (1).txt").unwrap(), b"other");
            match policy {
                TransferConflictPolicy::Skip => {
                    assert!(result.is_ok());
                    assert!(!files.contains_key("/partial"));
                }
                TransferConflictPolicy::Rename => {
                    assert!(result.is_ok());
                    assert_eq!(files.get("/target (2).txt").unwrap(), b"completed");
                    assert!(!files.contains_key("/partial"));
                }
                TransferConflictPolicy::Overwrite => {
                    assert!(result.is_err());
                    assert_eq!(files.get("/partial").unwrap(), b"completed");
                }
            }
        }
        sftp.close().await.unwrap();
    }
}

#[tokio::test]
async fn ordinary_rename_lost_reply_is_unknown_without_candidate_retry() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (client, mut peer) = tokio::io::duplex(8192);
    let worker = tokio::spawn(async move {
        let len = peer.read_u32().await.unwrap();
        let mut packet = vec![0; len as usize];
        peer.read_exact(&mut packet).await.unwrap();
        peer.write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3]).await.unwrap();
        let len = peer.read_u32().await.unwrap();
        let mut packet = vec![0; len as usize];
        peer.read_exact(&mut packet).await.unwrap();
        assert_eq!(packet[0], 18); // SSH_FXP_RENAME
    });
    let raw = RawSftpSession::new(client);
    raw.set_timeout(1);
    raw.init().await.unwrap();
    let publisher = RemotePublisher {
        raw,
        posix_rename: false,
    };
    let (sftp, _) = sessions(&FileServer::default(), false).await;
    let error = publisher
        .publish(&sftp, "/partial", "/target", TransferConflictPolicy::Rename)
        .await
        .unwrap_err();
    assert!(outcome_unknown(&error));
    worker.await.unwrap();
    sftp.close().await.unwrap();
}
