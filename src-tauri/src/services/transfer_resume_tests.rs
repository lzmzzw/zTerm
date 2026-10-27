use super::*;
use russh_sftp::protocol::{Attrs, Data, File, Handle, Name, Status, StatusCode};

struct SourceServer {
    bytes: Arc<Mutex<Vec<u8>>>,
}
impl russh_sftp::server::Handler for SourceServer {
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
            handle: "source".into(),
        })
    }
    async fn fstat(&mut self, id: u32, _: String) -> Result<Attrs, Self::Error> {
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(self.bytes.lock().unwrap().len() as u64),
                mtime: Some(1),
                permissions: Some(0o100644),
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
    async fn read(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let bytes = self.bytes.lock().unwrap();
        if offset >= bytes.len() as u64 {
            return Err(StatusCode::Eof);
        }
        let end = bytes.len().min(offset as usize + len as usize);
        Ok(Data {
            id,
            data: bytes[offset as usize..end].to_vec(),
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

async fn source_session(bytes: Arc<Mutex<Vec<u8>>>) -> RusshSftpSession {
    let (client, server) = tokio::io::duplex(262144);
    russh_sftp::server::run(server, SourceServer { bytes }).await;
    RusshSftpSession::new(client).await.unwrap()
}

fn digest(bytes: &[u8]) -> String {
    let mut hash = Context::new(&SHA256);
    hash.update(bytes);
    digest_hex(hash)
}

#[tokio::test]
async fn trusted_download_resumes_only_matching_prefix_and_truncates_unconfirmed_tail() {
    for scenario in [
        "valid",
        "missing",
        "corrupt",
        "route-changed",
        "same-size-source-changed",
        "out-of-bounds",
    ] {
        let (_store, context) = crate::storage::transfer_resume::test_context();
        let dir = std::env::temp_dir().join(format!("zterm-resume-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).await.unwrap();
        let dir = fs::canonicalize(&dir).await.unwrap();
        let target = dir.join("target.txt");
        fs::write(&target, b"original").await.unwrap();
        let partial = dir.join(format!(".zterm-{}.partial", uuid::Uuid::new_v4()));
        let bytes = Arc::new(Mutex::new(b"trusted file payload".to_vec()));
        let source = bytes.lock().unwrap().clone();
        let mut manifest = new_manifest(
            binding(&[
                "download",
                "route",
                "/source",
                &target.to_string_lossy(),
                "overwrite",
            ]),
            partial.to_string_lossy().into_owned(),
            source.len() as u64,
            digest(&source),
        );
        manifest.confirmed_offset = 7;
        manifest.prefix_sha256 = digest(&source[..7]);
        fs::write(&partial, b"trustedUNCONFIRMED TAIL")
            .await
            .unwrap();
        match scenario {
            "missing" => {
                fs::remove_file(&partial).await.unwrap();
            }
            "corrupt" => {
                fs::write(&partial, b"WRONG!!").await.unwrap();
            }
            "route-changed" => {
                manifest.binding = "different route".into();
            }
            "same-size-source-changed" => {
                bytes.lock().unwrap()[0] = b'X';
            }
            "out-of-bounds" => {
                manifest.confirmed_offset = 9999;
            }
            _ => {}
        }
        context.save(&manifest).unwrap();
        let sftp = source_session(Arc::clone(&bytes)).await;
        let mut progress = Vec::new();
        download(
            &sftp,
            &context,
            "route",
            "/source",
            &target,
            TransferConflictPolicy::Overwrite,
            None,
            &mut |update| {
                progress.push(update.transferred_bytes);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(
            progress[0],
            if scenario == "valid" { 7 } else { 0 },
            "{scenario}"
        );
        assert_eq!(
            fs::read(&target).await.unwrap(),
            *bytes.lock().unwrap(),
            "{scenario}"
        );
        assert!(context.load().unwrap().is_none());
        if scenario == "valid" {
            assert!(!partial.exists());
        }
        sftp.close().await.unwrap();
        fs::remove_dir_all(dir).await.unwrap();
    }
}

#[tokio::test]
async fn resumed_download_rejects_content_change_with_unchanged_length_and_mtime() {
    let (_store, context) = crate::storage::transfer_resume::test_context();
    let dir = std::env::temp_dir().join(format!("zterm-resume-mutate-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).await.unwrap();
    let target = dir.join("target.txt");
    fs::write(&target, b"original").await.unwrap();
    let bytes = Arc::new(Mutex::new(b"trusted file payload".to_vec()));
    let sftp = source_session(Arc::clone(&bytes)).await;
    let error = download(
        &sftp,
        &context,
        "route",
        "/source",
        &target,
        TransferConflictPolicy::Overwrite,
        None,
        &mut |update| {
            if update.transferred_bytes > 0 {
                bytes.lock().unwrap()[0] = b'X';
            }
            Ok(())
        },
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("内容校验失败"));
    assert_eq!(fs::read(&target).await.unwrap(), b"original");
    assert!(context.load().unwrap().is_none());
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    sftp.close().await.unwrap();
    fs::remove_dir_all(dir).await.unwrap();
}

#[test]
fn partial_ownership_rejects_external_paths_and_invalid_names() {
    assert!(!owned_remote_partial(
        "/elsewhere/.zterm-00000000-0000-0000-0000-000000000000.partial",
        "/target/file"
    ));
    assert!(!owned_remote_partial(
        "/target/user.partial",
        "/target/file"
    ));
    assert!(owned_remote_partial(
        "/target/.zterm-00000000-0000-0000-0000-000000000000.partial",
        "/target/file"
    ));
    assert!(!valid_partial_name(".zterm-../../other.partial"));
}
