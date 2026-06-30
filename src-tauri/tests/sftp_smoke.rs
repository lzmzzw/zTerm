// Author: Liz
use std::{env, fs, path::Path};

use uuid::Uuid;
use zterm_lib::{
    models::{
        session::{AuthMode, SavedSession, SessionType},
        sftp::{TransferConflictPolicy, TransferKind},
    },
    services::sftp_service::SftpService,
};

const KEYRING_SERVICE: &str = "zTerm";

#[tokio::test]
#[ignore = "requires a controlled SSH/SFTP host and ZTERM_SMOKE_SSH_* environment variables"]
async fn sftp_password_session_uploads_downloads_renames_and_deletes_folder() {
    let host = env::var("ZTERM_SMOKE_SSH_HOST").expect("ZTERM_SMOKE_SSH_HOST is required");
    let username = env::var("ZTERM_SMOKE_SSH_USER").expect("ZTERM_SMOKE_SSH_USER is required");
    let password =
        env::var("ZTERM_SMOKE_SSH_PASSWORD").expect("ZTERM_SMOKE_SSH_PASSWORD is required");
    let port = env::var("ZTERM_SMOKE_SSH_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(22);

    let credential_ref = format!("sftp-smoke-{}", Uuid::new_v4());
    let entry = keyring::Entry::new(KEYRING_SERVICE, &credential_ref)
        .expect("smoke keyring entry should open");
    entry
        .set_password(&password)
        .expect("smoke keyring password should save");

    let result = run_sftp_smoke(host.clone(), username.clone(), port, credential_ref.clone()).await;
    let _ = entry.delete_credential();

    if let Err(error) = result {
        panic!(
            "sftp smoke should complete: {}",
            sanitize(&error, &host, &username, &password)
        );
    }
}

async fn run_sftp_smoke(
    host: String,
    username: String,
    port: u16,
    credential_ref: String,
) -> Result<(), String> {
    let service = SftpService::new();
    let session = SavedSession {
        id: "sftp-smoke".to_string(),
        name: "SFTP Smoke".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host,
        port,
        username,
        auth_mode: AuthMode::Password,
        credential_ref: Some(credential_ref),
        description: None,
        tags: Vec::new(),
        sort_order: 0,
        created_at_ms: 0,
        updated_at_ms: 0,
        last_used_at_ms: None,
        ssh_options: None,
        rdp_options: None,
        local_options: None,
    };

    let nonce = Uuid::new_v4().to_string();
    let local_root = env::temp_dir().join(format!("zterm-sftp-upload-{nonce}"));
    let download_root = env::temp_dir().join(format!("zterm-sftp-download-{nonce}"));
    let nested = local_root.join("nested");
    fs::create_dir_all(&nested).map_err(|error| error.to_string())?;
    fs::write(nested.join("hello.txt"), b"zterm sftp smoke").map_err(|error| error.to_string())?;

    let remote_root = format!("/tmp/zterm-sftp-smoke-{nonce}");
    let remote_file = format!("{remote_root}/nested/hello.txt");
    let renamed_file = format!("{remote_root}/nested/renamed.txt");

    let smoke_result = async {
        service
            .upload_path(
                &session,
                path_string(&local_root)?.as_str(),
                &remote_root,
                Some(TransferKind::Directory),
                TransferConflictPolicy::Overwrite,
                None,
                |_| Ok(()),
            )
            .await
            .map_err(|error| error.to_string())?;
        let entries = service
            .list(&session, &remote_root)
            .await
            .map_err(|error| error.to_string())?;
        if !entries.iter().any(|entry| entry.name == "nested") {
            return Err("uploaded folder was not visible in SFTP list".to_string());
        }
        service
            .rename(&session, &remote_file, &renamed_file)
            .await
            .map_err(|error| error.to_string())?;
        service
            .download_path(
                &session,
                &remote_root,
                path_string(&download_root)?.as_str(),
                Some(TransferKind::Directory),
                TransferConflictPolicy::Overwrite,
                None,
                |_| Ok(()),
            )
            .await
            .map_err(|error| error.to_string())?;

        let downloaded = fs::read(download_root.join("nested").join("renamed.txt"))
            .map_err(|error| error.to_string())?;
        if downloaded != b"zterm sftp smoke" {
            return Err("downloaded file content mismatch".to_string());
        }

        service
            .delete(&session, &remote_root, true)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;

    let _ = service.delete(&session, &remote_root, true).await;
    let _ = fs::remove_dir_all(local_root);
    let _ = fs::remove_dir_all(download_root);
    smoke_result
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "path is not valid utf-8".to_string())
}

fn sanitize(text: &str, host: &str, username: &str, password: &str) -> String {
    text.replace(password, "<redacted-secret>")
        .replace(host, "<redacted-host>")
        .replace(username, "<redacted-user>")
}
