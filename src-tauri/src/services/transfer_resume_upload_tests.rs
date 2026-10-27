use super::*;
use russh_sftp::protocol::{Attrs, Data, File, Handle, Name, Packet, Status, StatusCode};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncRead, ReadBuf};

struct DisconnectStream {
    inner: tokio::io::DuplexStream,
    cut: Arc<AtomicBool>,
}
impl AsyncRead for DisconnectStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.cut.load(Ordering::SeqCst) {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
impl AsyncWrite for DisconnectStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.cut.load(Ordering::SeqCst) {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[derive(Clone)]
struct DestinationServer {
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    cut: Arc<AtomicBool>,
    fail_after: Option<u64>,
}
fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
impl russh_sftp::server::Handler for DestinationServer {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut files = self.files.lock().unwrap();
        if flags.contains(OpenFlags::CREATE) {
            if flags.contains(OpenFlags::EXCLUDE) && files.contains_key(&path) {
                return Err(StatusCode::Failure);
            }
            files.entry(path.clone()).or_default();
        }
        if !files.contains_key(&path) {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Handle { id, handle: path })
    }
    async fn fstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let files = self.files.lock().unwrap();
        let bytes = files.get(&path).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(bytes.len() as u64),
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
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(path)],
        })
    }
    async fn write(
        &mut self,
        id: u32,
        path: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        if self.fail_after.is_some_and(|limit| offset >= limit) {
            self.cut.store(true, Ordering::SeqCst);
            return Err(StatusCode::Failure);
        }
        let mut files = self.files.lock().unwrap();
        let bytes = files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        let end = offset as usize + data.len();
        bytes.resize(bytes.len().max(end), 0);
        bytes[offset as usize..end].copy_from_slice(&data);
        Ok(status(id))
    }
    async fn read(
        &mut self,
        id: u32,
        path: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let files = self.files.lock().unwrap();
        let bytes = files.get(&path).ok_or(StatusCode::NoSuchFile)?;
        if offset >= bytes.len() as u64 {
            return Err(StatusCode::Eof);
        }
        let end = bytes.len().min(offset as usize + len as usize);
        Ok(Data {
            id,
            data: bytes[offset as usize..end].to_vec(),
        })
    }
    async fn fsetstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        if let Some(size) = attrs.size {
            self.files
                .lock()
                .unwrap()
                .get_mut(&path)
                .ok_or(StatusCode::NoSuchFile)?
                .resize(size as usize, 0);
        }
        Ok(status(id))
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        self.fsetstat(id, path, attrs).await
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        self.files.lock().unwrap().remove(&path);
        Ok(status(id))
    }
    async fn extended(&mut self, id: u32, _: String, data: Vec<u8>) -> Result<Packet, Self::Error> {
        let len = u32::from_be_bytes(data[..4].try_into().unwrap()) as usize;
        let old = String::from_utf8(data[4..4 + len].to_vec()).unwrap();
        let offset = 4 + len;
        let len = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
        let new = String::from_utf8(data[offset + 4..offset + 4 + len].to_vec()).unwrap();
        let mut files = self.files.lock().unwrap();
        let bytes = files.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        files.insert(new, bytes);
        Ok(Packet::Status(status(id)))
    }
}

async fn destination_session(
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    fail_after: Option<u64>,
) -> RusshSftpSession {
    let (client, peer) = tokio::io::duplex(262144);
    let cut = Arc::new(AtomicBool::new(false));
    russh_sftp::server::run(
        DisconnectStream {
            inner: peer,
            cut: Arc::clone(&cut),
        },
        DestinationServer {
            files,
            cut,
            fail_after,
        },
    )
    .await;
    RusshSftpSession::new(client).await.unwrap()
}

#[tokio::test]
async fn disconnected_upload_recovers_confirmed_checkpoint_and_cancel_cleans_manifest() {
    let (_store, context) = crate::storage::transfer_resume::test_context();
    let source_path =
        std::env::temp_dir().join(format!("zterm-upload-resume-{}", uuid::Uuid::new_v4()));
    let source = vec![b'A'; CHECKPOINT_BYTES as usize + 1024 * 1024];
    fs::write(&source_path, &source).await.unwrap();
    let files = Arc::new(Mutex::new(HashMap::from([(
        "/target".to_string(),
        b"original".to_vec(),
    )])));
    let sftp = destination_session(Arc::clone(&files), Some(CHECKPOINT_BYTES)).await;
    let (client, peer) = tokio::io::duplex(8192);
    russh_sftp::server::run(
        peer,
        DestinationServer {
            files: Arc::clone(&files),
            cut: Arc::new(AtomicBool::new(false)),
            fail_after: None,
        },
    )
    .await;
    let raw = russh_sftp::client::RawSftpSession::new(client);
    raw.init().await.unwrap();
    // Test-only constructor keeps the same production publication path.
    let publisher = RemotePublisher::for_test(raw, true);
    let result = upload(
        &sftp,
        &publisher,
        &context,
        "route",
        &source_path,
        "/target",
        TransferConflictPolicy::Overwrite,
        None,
        &mut |_| Ok(()),
    )
    .await;
    assert!(result.is_err());
    let manifest = context.load().unwrap().unwrap();
    assert_eq!(manifest.confirmed_offset, CHECKPOINT_BYTES);
    assert_eq!(files.lock().unwrap().get("/target").unwrap(), b"original");
    // Simulate unacknowledged extra writes; resume must truncate these.
    files
        .lock()
        .unwrap()
        .get_mut(&manifest.partial_path)
        .unwrap()
        .extend_from_slice(b"unconfirmed");
    let sftp = destination_session(Arc::clone(&files), None).await;
    let mut progress = Vec::new();
    upload(
        &sftp,
        &publisher,
        &context,
        "route",
        &source_path,
        "/target",
        TransferConflictPolicy::Overwrite,
        None,
        &mut |p| {
            progress.push(p.transferred_bytes);
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(progress[0], CHECKPOINT_BYTES);
    {
        let files = files.lock().unwrap();
        let actual = files.get("/target").unwrap();
        assert!(
            actual == &source,
            "uploaded bytes differ: expected len {}, actual len {}, first mismatch {:?}",
            source.len(),
            actual.len(),
            actual.iter().zip(&source).position(|(a, b)| a != b)
        );
    }
    assert!(context.load().unwrap().is_none());
    let control = TransferRunControl::new();
    let result = upload(
        &sftp,
        &publisher,
        &context,
        "route",
        &source_path,
        "/target",
        TransferConflictPolicy::Overwrite,
        Some(&control),
        &mut |p| {
            if p.transferred_bytes > 0 {
                control.cancel();
            }
            Ok(())
        },
    )
    .await;
    assert!(result.is_err());
    assert!(context.load().unwrap().is_none());
    assert_eq!(files.lock().unwrap().len(), 1);
    sftp.close().await.unwrap();
    fs::remove_file(source_path).await.unwrap();
}
