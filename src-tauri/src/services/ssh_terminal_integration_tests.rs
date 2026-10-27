// Author: Liz
//! Loopback-only SSH protocol tests; no real server, user key or credentials.
use super::*;
use crate::models::session::{SshContainerOptions, SshOptions};
use russh::{server, Channel, ChannelId};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

fn payload() -> Vec<u8> {
    let mut bytes = b"**\x18B0100000023be50\r\x8a\x11".to_vec();
    bytes.extend(0..=255);
    bytes
}

struct EchoServer {
    reject_auth: bool,
    password: String,
    keyboard_prompt: Option<&'static str>,
    allow_none: bool,
    hang_shell: bool,
    shell_channels: std::collections::HashSet<ChannelId>,
    opened: Arc<AtomicUsize>,
    execs: Arc<AtomicUsize>,
}

impl server::Handler for EchoServer {
    type Error = russh::Error;
    async fn auth_publickey_offered(
        &mut self,
        _: &str,
        public: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        self.auth_publickey("loopback", public).await
    }
    async fn auth_publickey(
        &mut self,
        _: &str,
        public: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        let pair = keys::ssh_key::private::Ed25519Keypair::from_seed(&[23; 32]);
        let expected = PrivateKey::new(pair.into(), "loopback-client").unwrap();
        Ok(
            if !self.reject_auth && public.key_data() == expected.public_key().key_data() {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    async fn auth_password(
        &mut self,
        _: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(
            if !self.reject_auth && self.keyboard_prompt.is_none() && password == self.password {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(if self.allow_none {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        let Some(prompt) = self.keyboard_prompt else {
            return Ok(server::Auth::reject());
        };
        if let Some(mut response) = response {
            return Ok(
                if response
                    .next()
                    .is_some_and(|bytes| bytes.as_ref() == self.password.as_bytes())
                {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                },
            );
        }
        Ok(server::Auth::Partial {
            name: "loopback-only".into(),
            instructions: "".into(),
            prompts: vec![(std::borrow::Cow::Borrowed(prompt), false)].into(),
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        _: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        self.shell_channels.insert(channel.id());
        Ok(true)
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.hang_shell {
            return Ok(());
        }
        session.channel_success(channel)?;
        session.data(channel, payload())?;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        assert!(String::from_utf8_lossy(command).contains("docker"));
        self.execs.fetch_add(1, Ordering::SeqCst);
        self.shell_request(channel, session).await
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        bytes: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.shell_channels.contains(&channel) {
            session.data(channel, bytes.to_vec())?;
        }
        Ok(())
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        target_host: &str,
        target_port: u32,
        _: &str,
        _: u32,
        _: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        let target = if target_host == "synthetic-target" {
            None
        } else {
            Some(
                TcpStream::connect((target_host, target_port as u16))
                    .await
                    .unwrap(),
            )
        };
        tokio::spawn(async move {
            let stream = channel.into_stream();
            if let Some(mut target) = target {
                let mut stream = stream;
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
                return;
            }
            let (mut reader, mut writer) = tokio::io::split(stream);
            let _ = tokio::io::copy(&mut reader, &mut writer).await;
        });
        Ok(true)
    }
}

struct Fixture {
    port: u16,
    opened: Arc<AtomicUsize>,
    execs: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fixture(reject_auth: bool) -> Fixture {
    fixture_with_auth(reject_auth, "loopback-only", None, false).await
}

async fn fixture_with_auth(
    reject_auth: bool,
    password: &str,
    keyboard_prompt: Option<&'static str>,
    allow_none: bool,
) -> Fixture {
    fixture_options(reject_auth, password, keyboard_prompt, allow_none, false).await
}

async fn fixture_options(
    reject_auth: bool,
    password: &str,
    keyboard_prompt: Option<&'static str>,
    allow_none: bool,
    hang_shell: bool,
) -> Fixture {
    let key = keys::ssh_key::private::Ed25519Keypair::from_seed(&[19; 32]);
    let config = Arc::new(server::Config {
        keys: vec![PrivateKey::new(key.into(), "loopback-only").unwrap()],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let opened = Arc::new(AtomicUsize::new(0));
    let execs = Arc::new(AtomicUsize::new(0));
    let handler = EchoServer {
        reject_auth,
        password: password.into(),
        keyboard_prompt,
        allow_none,
        hang_shell,
        shell_channels: std::collections::HashSet::new(),
        opened: Arc::clone(&opened),
        execs: Arc::clone(&execs),
    };
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let session = server::run_stream(config, socket, handler).await.unwrap();
        let _ = session.await;
    });
    Fixture {
        port,
        opened,
        execs,
        task,
    }
}

struct TestSecrets;
impl SshCommandSecretResolver for TestSecrets {
    fn secret_for(&self, _: &str) -> AppResult<String> {
        Ok("loopback-only".into())
    }
}

fn saved_session(port: u16) -> SavedSession {
    SavedSession {
        id: "loopback-only".into(),
        name: "loopback-only".into(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "127.0.0.1".into(),
        port,
        username: "loopback".into(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("test-only".into()),
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: Some(SshOptions::default()),
        rdp_options: None,
        local_options: None,
        ftp_options: None,
    }
}

async fn exchange(mut runtime: NativeSshRuntime) {
    let control = runtime.control.clone();
    let expected = payload();
    let operation = tokio::task::spawn_blocking(move || {
        let mut read = vec![0; expected.len()];
        runtime
            .reader
            .read_exact(&mut read)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&read)));
        assert_eq!(
            read, expected,
            "server output must retain all bytes, including ZDLE"
        );
        runtime.writer.write_all(&expected).unwrap();
        runtime.reader.read_exact(&mut read).unwrap();
        assert_eq!(read, expected, "terminal input must retain all bytes");
        runtime.control.close();
        let mut byte = [0];
        assert_eq!(
            runtime.reader.read(&mut byte).unwrap(),
            0,
            "close must release reader"
        );
    });
    let result = tokio::time::timeout(Duration::from_secs(10), operation).await;
    control.close();
    result.expect("loopback transfer timed out").unwrap();
}

fn native(spawn: SshTerminalSpawn) -> NativeSshRuntime {
    match spawn.runtime {
        SshTerminalRuntime::Native(runtime) => runtime,
        _ => panic!("SSH must avoid local PTY"),
    }
}

#[tokio::test]
async fn loopback_plain_ssh_preserves_zmodem_and_binary_input_output() {
    let fixture = fixture(false).await;
    let session = saved_session(fixture.port);
    exchange(native(
        spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap(),
    ))
    .await;
    assert_eq!(fixture.opened.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn loopback_gateway_identity_preserves_single_shell_binary_stream() {
    let fixture = fixture(false).await;
    let mut session = saved_session(fixture.port);
    session.username = "b64>>bG9vcGJhY2s=".into();
    exchange(native(
        spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap(),
    ))
    .await;
    assert_eq!(fixture.opened.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn loopback_container_exec_preserves_zmodem_binary_stream() {
    let fixture = fixture(false).await;
    let mut session = saved_session(fixture.port);
    session.ssh_options.as_mut().unwrap().container = Some(SshContainerOptions::default());
    exchange(native(
        spawn_ssh_container_terminal_with_resolver(
            &session,
            "test-container",
            80,
            24,
            &TestSecrets,
        )
        .unwrap(),
    ))
    .await;
    assert_eq!(fixture.execs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn loopback_local_tunnel_keeps_terminal_binary_and_releases_listener() {
    let fixture = fixture(false).await;
    let reserve = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let tunnel_port = reserve.local_addr().unwrap().port();
    drop(reserve);
    let mut session = saved_session(fixture.port);
    session
        .ssh_options
        .as_mut()
        .unwrap()
        .tunnels
        .push(SshTunnel {
            mode: None,
            name: None,
            kind: SshTunnelKind::Local,
            auto_open: true,
            bind_address: Some("127.0.0.1".into()),
            local_port: Some(tunnel_port),
            remote_host: Some("synthetic-target".into()),
            remote_port: Some(22),
        });
    let runtime = native(spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap());
    let control = runtime.control.clone();
    let tunnel = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match TcpStream::connect(("127.0.0.1", tunnel_port)).await {
                Ok(stream) => break stream,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
    })
    .await
    .expect("native tunnel listener must start");
    let (mut reader, mut writer) = tokio::io::split(tunnel);
    let bytes = payload();
    writer.write_all(&bytes).await.unwrap();
    let mut received = vec![0; bytes.len()];
    tokio::time::timeout(Duration::from_secs(10), reader.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, bytes);
    exchange(runtime).await;
    control.close();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", tunnel_port)).await {
                drop(listener);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("closing terminal must release native tunnel listener");
}

#[tokio::test]
async fn loopback_authentication_failure_exits_without_opening_shell() {
    let fixture = fixture(true).await;
    let session = saved_session(fixture.port);
    let mut runtime =
        native(spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap());
    let control = runtime.control.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            runtime.reader.read_to_end(&mut output).unwrap();
            assert!(String::from_utf8_lossy(&output).contains("认证"));
            assert_eq!(*runtime.exit_status.lock().unwrap(), Some(-1));
        }),
    )
    .await;
    control.close();
    result
        .expect("authentication rejection must release reader promptly")
        .unwrap();
    assert_eq!(fixture.opened.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn loopback_keyboard_password_fallback_preserves_binary() {
    let fixture = fixture_with_auth(false, "loopback-only", Some("Password:"), false).await;
    let session = saved_session(fixture.port);
    exchange(native(
        spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap(),
    ))
    .await;
    assert_eq!(fixture.opened.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn loopback_keyboard_otp_uses_manual_answer_without_sending_saved_password() {
    let fixture = fixture_with_auth(false, "123456", Some("Verification code:"), false).await;
    let session = saved_session(fixture.port);
    let mut runtime =
        native(spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap());
    let control = runtime.control.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            while !output.ends_with(b"Verification code:") {
                let mut byte = [0];
                runtime.reader.read_exact(&mut byte).unwrap();
                output.push(byte[0]);
                assert!(output.len() < 4096);
            }
            runtime.writer.write_all(b"123456\r").unwrap();
            let mut newline = [0; 2];
            runtime.reader.read_exact(&mut newline).unwrap();
            assert_eq!(newline, *b"\r\n", "OTP must not be echoed");
            runtime
        }),
    )
    .await;
    match result {
        Ok(runtime) => exchange(runtime.unwrap()).await,
        Err(error) => {
            control.close();
            panic!("manual OTP prompt timed out: {error}");
        }
    }
    assert_eq!(fixture.opened.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn loopback_none_auth_preserves_binary() {
    let fixture = fixture_with_auth(false, "", None, true).await;
    let mut session = saved_session(fixture.port);
    session.auth_mode = AuthMode::None;
    session.credential_ref = None;
    exchange(native(
        spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap(),
    ))
    .await;
}

#[tokio::test]
async fn loopback_private_key_auth_preserves_binary_without_user_credentials() {
    let fixture = fixture(false).await;
    let pair = keys::ssh_key::private::Ed25519Keypair::from_seed(&[23; 32]);
    let key = PrivateKey::new(pair.into(), "loopback-client").unwrap();
    struct TestKeyFile(PathBuf);
    impl Drop for TestKeyFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let file = TestKeyFile(
        std::env::temp_dir().join(format!("zterm-loopback-test-{}.key", uuid::Uuid::new_v4())),
    );
    std::fs::write(
        &file.0,
        key.to_openssh(keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let mut session = saved_session(fixture.port);
    session.auth_mode = AuthMode::Key;
    session.credential_ref = None;
    session.ssh_options.as_mut().unwrap().identity_file =
        Some(file.0.to_string_lossy().into_owned());
    exchange(native(
        spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap(),
    ))
    .await;
}

struct ChainSecrets {
    sessions: Vec<SavedSession>,
}
impl SshCommandSecretResolver for ChainSecrets {
    fn secret_for(&self, reference: &str) -> AppResult<String> {
        Ok(reference.into())
    }
    fn saved_ssh_sessions(&self) -> &[SavedSession] {
        &self.sessions
    }
}

async fn jump_chain(hop_count: usize) {
    let target = fixture_with_auth(false, "target-only-password", None, false).await;
    let mut session = saved_session(target.port);
    session.id = "target-only".into();
    session.credential_ref = Some("target-only-password".into());
    let mut fixtures = Vec::new();
    let mut saved = Vec::new();
    for index in 0..hop_count {
        let password = format!("jump-{index}-only-password");
        let fixture = fixture_with_auth(false, &password, None, false).await;
        let mut jump = saved_session(fixture.port);
        jump.id = format!("jump-{index}");
        jump.credential_ref = Some(password);
        session
            .ssh_options
            .as_mut()
            .unwrap()
            .jump_hosts
            .push(format!("loopback@127.0.0.1:{}", fixture.port));
        saved.push(jump);
        fixtures.push(fixture);
    }
    let reserve = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let tunnel_port = reserve.local_addr().unwrap().port();
    drop(reserve);
    session
        .ssh_options
        .as_mut()
        .unwrap()
        .tunnels
        .push(SshTunnel {
            mode: None,
            name: None,
            kind: SshTunnelKind::Local,
            auto_open: true,
            bind_address: Some("127.0.0.1".into()),
            local_port: Some(tunnel_port),
            remote_host: Some("synthetic-target".into()),
            remote_port: Some(22),
        });
    let resolver = ChainSecrets { sessions: saved };
    let runtime = native(spawn_ssh_terminal_with_resolver(&session, 80, 24, &resolver).unwrap());
    let mut tunnel = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(stream) = TcpStream::connect(("127.0.0.1", tunnel_port)).await {
                break stream;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("tunnel through saved jump chain must start");
    let bytes = payload();
    tunnel.write_all(&bytes).await.unwrap();
    let mut received = vec![0; bytes.len()];
    tokio::time::timeout(Duration::from_secs(10), tunnel.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, bytes);
    drop(tunnel);
    exchange(runtime).await;
    assert_eq!(target.opened.load(Ordering::SeqCst), 1);
    for fixture in fixtures {
        assert_eq!(
            fixture.opened.load(Ordering::SeqCst),
            0,
            "jump should use direct-tcpip, not shell"
        );
    }
}

#[tokio::test]
async fn loopback_saved_single_jump_uses_own_password_and_binary_tunnel() {
    jump_chain(1).await;
}

#[tokio::test]
async fn loopback_saved_two_jumps_use_distinct_passwords_and_binary_tunnel() {
    jump_chain(2).await;
}

#[tokio::test]
async fn loopback_hanging_shell_close_releases_reader_and_tunnel_listener() {
    let fixture = fixture_options(false, "loopback-only", None, false, true).await;
    let mut session = saved_session(fixture.port);
    let reserve = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = reserve.local_addr().unwrap().port();
    drop(reserve);
    session
        .ssh_options
        .as_mut()
        .unwrap()
        .tunnels
        .push(SshTunnel {
            mode: None,
            name: None,
            kind: SshTunnelKind::Local,
            auto_open: true,
            bind_address: Some("127.0.0.1".into()),
            local_port: Some(port),
            remote_host: Some("synthetic-target".into()),
            remote_port: Some(22),
        });
    let mut runtime =
        native(spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.opened.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("shell channel must reach hanging server");
    runtime.control.close();
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            runtime.reader.read_to_end(&mut output).unwrap();
            assert!(
                output.is_empty(),
                "closed hanging shell must not synthesize protocol bytes"
            );
        }),
    )
    .await
    .expect("close must release hanging shell reader")
    .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("close must release tunnel listener");
    drop(listener);
}

#[tokio::test]
async fn loopback_mixed_saved_password_and_unsaved_none_jump_preserves_binary() {
    let first = fixture_with_auth(false, "saved-jump-only", None, false).await;
    let second = fixture_with_auth(false, "", None, true).await;
    let target = fixture(false).await;
    let mut saved = saved_session(first.port);
    saved.id = "saved-jump".into();
    saved.credential_ref = Some("saved-jump-only".into());
    let mut session = saved_session(target.port);
    session.id = "mixed-target".into();
    session.credential_ref = Some("loopback-only".into());
    session.ssh_options.as_mut().unwrap().jump_hosts = vec![
        format!("loopback@127.0.0.1:{}", first.port),
        format!("loopback@127.0.0.1:{}", second.port),
    ];
    let resolver = ChainSecrets {
        sessions: vec![saved],
    };
    exchange(native(
        spawn_ssh_terminal_with_resolver(&session, 80, 24, &resolver).unwrap(),
    ))
    .await;
    assert_eq!(first.opened.load(Ordering::SeqCst), 0);
    assert_eq!(second.opened.load(Ordering::SeqCst), 0);
    assert_eq!(target.opened.load(Ordering::SeqCst), 1);
}

#[test]
fn loopback_known_host_accepts_first_key_and_rejects_changed_key() {
    let first = PrivateKey::new(
        keys::ssh_key::private::Ed25519Keypair::from_seed(&[31; 32]).into(),
        "",
    )
    .unwrap();
    let changed = PrivateKey::new(
        keys::ssh_key::private::Ed25519Keypair::from_seed(&[32; 32]).into(),
        "",
    )
    .unwrap();
    let hostname = format!("loopback-test-{}.invalid", uuid::Uuid::new_v4());
    verify_native_server_key(&hostname, 22, first.public_key()).unwrap();
    verify_native_server_key(&hostname, 22, first.public_key()).unwrap();
    assert!(verify_native_server_key(&hostname, 22, changed.public_key()).is_err());
    // Public fixture from ssh-key's published test examples; never a user identity.
    let changed_algorithm = PublicKey::from_openssh("ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=").unwrap();
    assert!(verify_native_server_key(&hostname, 22, &changed_algorithm).is_err());
}

#[cfg(windows)]
#[test]
#[ignore = "subprocess-only loopback ProxyCommand relay"]
fn loopback_proxy_relay_helper() {
    use std::io::{Read, Write};
    // libtest's startup lines precede the SSH identification and are valid
    // pre-identification text. Once this test starts, only raw TCP bytes go to
    // stdout; never use println! or text decoding inside the relay.
    let port = std::env::var("ZTERM_TEST_PROXY_PORT")
        .expect("relay is only launched by its parent test")
        .parse::<u16>()
        .unwrap();
    let mut socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket.set_nodelay(true).unwrap();
    let mut upload = socket.try_clone().unwrap();
    // Dedicated blocking threads avoid the .NET Framework thread pool used
    // by PowerShell ConsoleStream.CopyToAsync in the previous test fixture.
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut upload);
        let _ = upload.shutdown(std::net::Shutdown::Write);
    });
    let mut stdout = std::io::stdout().lock();
    let mut buffer = [0_u8; 8192];
    while let Ok(count) = socket.read(&mut buffer) {
        if count == 0
            || stdout
                .write_all(&buffer[..count])
                .and_then(|_| stdout.flush())
                .is_err()
        {
            break;
        }
    }
    // Avoid libtest's trailing status text on the protocol stream. This is a
    // dedicated child process; the parent owns its lifetime through the proxy job.
    std::process::exit(0);
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loopback_proxy_command_preserves_native_ssh_zmodem_binary_stream() {
    let server = fixture(false).await;
    let mut session = saved_session(server.port);
    let executable = std::env::current_exe().unwrap();
    let executable = executable.to_str().unwrap();
    assert!(
        !executable.contains(['"', '%', '\r', '\n']),
        "test executable must be safe inside a quoted cmd argument"
    );
    // SET affects only the child cmd, never the parent's process environment.
    // Still exercises the production ProxyCommand raw-pipe/process lifecycle.
    session.ssh_options.as_mut().unwrap().proxy_command = Some(format!(
        r#"set "ZTERM_TEST_PROXY_PORT=%p" && "{executable}" --exact services::ssh_terminal_service::integration_tests::loopback_proxy_relay_helper --ignored --nocapture --quiet"#
    ));
    exchange(native(
        spawn_ssh_terminal_with_resolver(&session, 80, 24, &TestSecrets).unwrap(),
    ))
    .await;
    assert_eq!(server.opened.load(Ordering::SeqCst), 1);
}
