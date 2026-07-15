// Author: Liz
use std::{env, fs, path::Path, process::Command};

#[cfg(target_os = "windows")]
use std::{ffi::c_void, io, os::windows::process::CommandExt, ptr};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::session::{SavedSession, SessionType},
    services::credential_service::read_system_secret,
};

const RDP_SIGNING_CERT_THUMBPRINT_ENV: &str = "ZTERM_RDP_SIGNING_CERT_THUMBPRINT";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RdpLaunchCommand {
    pub program: String,
    pub args: Vec<String>,
}

pub fn build_mstsc_arguments(session: &SavedSession) -> AppResult<RdpLaunchCommand> {
    if session.session_type != SessionType::Rdp {
        return Err(AppError::unsupported("only RDP sessions can launch mstsc"));
    }
    let options = session
        .rdp_options
        .as_ref()
        .ok_or_else(|| AppError::validation("RDP 会话缺少 RDP 选项"))?;
    let mut args = vec![
        format!("/v:{}:{}", session.host, session.port),
        format!("/w:{}", options.width),
        format!("/h:{}", options.height),
    ];
    if options.color_depth > 0 {
        args.push(format!("/bpp:{}", options.color_depth));
    }
    if options.fullscreen {
        args.push("/f".to_string());
    }
    Ok(RdpLaunchCommand {
        program: "mstsc.exe".to_string(),
        args,
    })
}

pub fn launch_mstsc(session: &SavedSession) -> AppResult<()> {
    let password = match session.credential_ref.as_deref() {
        Some(credential_ref) if session.auth_mode == crate::models::session::AuthMode::Password => {
            Some(read_system_secret(credential_ref)?)
        }
        _ => None,
    };
    write_rdp_password_credential(session, password.as_deref())?;
    let rdp_content = build_rdp_file_content(session)?;
    let file_path = std::env::temp_dir().join(format!(
        "zterm-{}-{}.rdp",
        sanitize_file_token(&session.name),
        Uuid::new_v4()
    ));
    fs::write(&file_path, rdp_content)?;
    try_sign_rdp_file(&file_path);
    Command::new("mstsc.exe")
        .arg(&file_path)
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::terminal(format!("failed to launch mstsc: {error}")))
}

fn try_sign_rdp_file(file_path: &Path) -> bool {
    let configured_thumbprint = env::var(RDP_SIGNING_CERT_THUMBPRINT_ENV).ok();
    let Some(thumbprint) = normalize_rdp_signing_thumbprint(configured_thumbprint.as_deref())
    else {
        return false;
    };

    let mut command = Command::new("rdpsign.exe");
    command.args(["/sha256", &thumbprint, "/q"]).arg(file_path);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.status().is_ok_and(|status| status.success())
}

fn normalize_rdp_signing_thumbprint(configured_thumbprint: Option<&str>) -> Option<String> {
    let thumbprint = configured_thumbprint?.trim();
    if thumbprint.len() != 40 || !thumbprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(thumbprint.to_ascii_uppercase())
}

pub fn build_rdp_file_content(session: &SavedSession) -> AppResult<String> {
    if session.session_type != SessionType::Rdp {
        return Err(AppError::unsupported(
            "only RDP sessions can build RDP content",
        ));
    }
    let options = session
        .rdp_options
        .as_ref()
        .ok_or_else(|| AppError::validation("RDP 会话缺少 RDP 选项"))?;
    let username = rdp_username(session);
    let has_password_credential = session.auth_mode == crate::models::session::AuthMode::Password
        && session
            .credential_ref
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    let mut lines = vec![
        format!(
            "full address:s:{}",
            format_rdp_full_address(&session.host, session.port)
        ),
        "authentication level:i:2".to_string(),
        "enablecredsspsupport:i:1".to_string(),
        format!(
            "redirectclipboard:i:{}",
            if options.redirect_clipboard { 1 } else { 0 }
        ),
        format!(
            "prompt for credentials:i:{}",
            if has_password_credential { 0 } else { 1 }
        ),
        format!(
            "promptcredentialonce:i:{}",
            if has_password_credential { 1 } else { 0 }
        ),
        format!(
            "screen mode id:i:{}",
            if options.fullscreen { 2 } else { 1 }
        ),
        format!("desktopwidth:i:{}", options.width),
        format!("desktopheight:i:{}", options.height),
        format!("session bpp:i:{}", options.color_depth),
    ];

    if let Some(username) = username {
        lines.push(format!("username:s:{username}"));
    }

    Ok(lines.join("\r\n") + "\r\n")
}

pub fn rdp_password_credential_target(session: &SavedSession) -> AppResult<String> {
    if session.session_type != SessionType::Rdp {
        return Err(AppError::unsupported(
            "only RDP sessions can build password credential targets",
        ));
    }
    Ok(format!(
        "TERMSRV/{}",
        format_rdp_full_address(&session.host, session.port)
    ))
}

fn rdp_username(session: &SavedSession) -> Option<String> {
    let username = session.username.trim();
    if username.is_empty() {
        return None;
    }
    let Some(domain) = session
        .rdp_options
        .as_ref()
        .and_then(|options| options.domain.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Some(username.to_string());
    };
    if username.contains('\\') || username.contains('@') {
        Some(username.to_string())
    } else {
        Some(format!("{domain}\\{username}"))
    }
}

fn format_rdp_full_address(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn write_rdp_password_credential(session: &SavedSession, password: Option<&str>) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        let Some(password) = password.filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let target = rdp_password_credential_target(session)?;
        let username = rdp_username(session)
            .ok_or_else(|| AppError::validation("RDP PasswordCredential 缺少用户名"))?;
        write_windows_password_credential(&target, &username, password)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = session;
        let _ = password;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
#[repr(C)]
struct FileTime {
    dwLowDateTime: u32,
    dwHighDateTime: u32,
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
#[repr(C)]
struct CredentialW {
    Flags: u32,
    Type: u32,
    TargetName: *mut u16,
    Comment: *mut u16,
    LastWritten: FileTime,
    CredentialBlobSize: u32,
    CredentialBlob: *mut u8,
    Persist: u32,
    AttributeCount: u32,
    Attributes: *mut c_void,
    TargetAlias: *mut u16,
    UserName: *mut u16,
}

#[cfg(target_os = "windows")]
#[link(name = "Advapi32")]
extern "system" {
    fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
}

#[cfg(target_os = "windows")]
const CRED_TYPE_GENERIC: u32 = 1;
#[cfg(target_os = "windows")]
const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;

#[cfg(target_os = "windows")]
fn write_windows_password_credential(
    target: &str,
    username: &str,
    password: &str,
) -> AppResult<()> {
    let mut target_wide = wide_null(target);
    let mut username_wide = wide_null(username);
    let mut password_blob = utf16le_bytes(password);
    let credential_blob_size = u32::try_from(password_blob.len())
        .map_err(|_| AppError::validation("RDP PasswordCredential 密码过长"))?;

    let credential = CredentialW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target_wide.as_mut_ptr(),
        Comment: ptr::null_mut(),
        LastWritten: FileTime {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        },
        CredentialBlobSize: credential_blob_size,
        CredentialBlob: password_blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: ptr::null_mut(),
        TargetAlias: ptr::null_mut(),
        UserName: username_wide.as_mut_ptr(),
    };

    let written = unsafe { CredWriteW(&credential, 0) };
    if written == 0 {
        return Err(AppError::terminal(format!(
            "RDP PasswordCredential 写入失败: {}",
            io::Error::last_os_error()
        )));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn utf16le_bytes(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}

fn sanitize_file_token(value: &str) -> String {
    let token = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let token = token.trim_matches('-');
    if token.is_empty() {
        "rdp".to_string()
    } else {
        token.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_rdp_signing_thumbprint;

    #[test]
    fn rdp_signing_thumbprint_accepts_a_trimmed_sha1_thumbprint() {
        assert_eq!(
            normalize_rdp_signing_thumbprint(Some(" bb4b8edc26a071a2bc4b2bed641dee3fae6e9f7b ",)),
            Some("BB4B8EDC26A071A2BC4B2BED641DEE3FAE6E9F7B".to_string())
        );
    }

    #[test]
    fn rdp_signing_thumbprint_skips_missing_or_invalid_configuration() {
        assert_eq!(normalize_rdp_signing_thumbprint(None), None);
        assert_eq!(normalize_rdp_signing_thumbprint(Some("")), None);
        assert_eq!(
            normalize_rdp_signing_thumbprint(Some("not-a-thumbprint")),
            None
        );
        assert_eq!(
            normalize_rdp_signing_thumbprint(Some(
                "CF697719CB0A2C6BAC01C7E20C185EBCB825F6208AC7CE453FDB91BC9E3EA01F",
            )),
            None
        );
    }
}
