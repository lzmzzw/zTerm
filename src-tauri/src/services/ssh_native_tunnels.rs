// Author: Liz
//! TCP forwarding stays on the terminal's authenticated SSH connection.
use std::{
    io,
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

use russh::{client, Channel};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinSet,
    time::timeout,
};

use crate::{
    error::{AppError, AppResult},
    models::session::{SshTunnel, SshTunnelKind},
};

const SETUP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONNECTIONS: usize = 256;

pub struct ForwardedTcpip {
    pub channel: Channel<client::Msg>,
    pub connected_address: String,
    pub connected_port: u32,
}

#[derive(Clone)]
struct Forward {
    address: String,
    port: u16,
    target: Option<(String, u16)>,
}

/// Dropping this guard aborts listeners and all connection tasks. The caller
/// must also disconnect its SSH handle, which releases remote listeners.
pub struct NativeTunnels<H: client::Handler> {
    handle: Arc<client::Handle<H>>,
    remote: Vec<Forward>,
    tasks: JoinSet<()>,
}

impl<H: client::Handler + 'static> NativeTunnels<H> {
    pub async fn start(
        handle: Arc<client::Handle<H>>,
        tunnels: &[SshTunnel],
        mut forwarded: mpsc::Receiver<ForwardedTcpip>,
    ) -> AppResult<Self> {
        let mut result = Self {
            handle,
            remote: Vec::new(),
            tasks: JoinSet::new(),
        };
        for tunnel in tunnels.iter().filter(|t| t.auto_open) {
            let setup = async {
                let forward = parse_forward(tunnel)?;
                match tunnel.kind {
                    SshTunnelKind::Local | SshTunnelKind::Dynamic => {
                        let bind = if forward.address == "*" { "0.0.0.0" } else { &forward.address };
                        let listener = TcpListener::bind((bind, forward.port)).await
                            .map_err(|_| AppError::ssh("无法绑定本地 SSH 隧道端口"))?;
                        let handle = Arc::clone(&result.handle);
                        result.tasks.spawn(async move {
                            let mut connections = JoinSet::new();
                            loop {
                                tokio::select! {
                                    incoming = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                                        let Ok((socket, origin)) = incoming else { break; };
                                        let handle = Arc::clone(&handle);
                                        let target = forward.target.clone();
                                        connections.spawn(async move {
                                            let _ = serve_local(handle, socket, target, origin.ip().to_string(), u32::from(origin.port())).await;
                                        });
                                    }
                                    _ = connections.join_next(), if !connections.is_empty() => {}
                                }
                            }
                        });
                    }
                    SshTunnelKind::Remote | SshTunnelKind::RemoteDynamic => {
                        timeout(SETUP_TIMEOUT, result.handle.tcpip_forward(forward.address.clone(), u32::from(forward.port))).await
                            .map_err(|_| AppError::ssh("请求远端 SSH 隧道超时"))?
                            .map_err(|_| AppError::ssh("服务器拒绝远端 SSH 隧道"))?;
                        result.remote.push(forward);
                    }
                }
                Ok::<_, AppError>(())
            }.await;
            if let Err(error) = setup {
                result.shutdown().await;
                return Err(error);
            }
        }
        let routes = result.remote.clone();
        result.tasks.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    incoming = forwarded.recv() => {
                        let Some(incoming) = incoming else { break; };
                        let route = routes.iter().find(|route| route.port as u32 == incoming.connected_port && address_matches(&route.address, &incoming.connected_address));
                        if connections.len() >= MAX_CONNECTIONS || route.is_none() {
                            let _ = incoming.channel.close().await;
                            continue;
                        }
                        let target = route.unwrap().target.clone();
                        connections.spawn(async move { let _ = serve_remote(incoming.channel, target).await; });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(result)
    }

    pub async fn shutdown(&mut self) {
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        for route in self.remote.drain(..) {
            let _ = timeout(
                SETUP_TIMEOUT,
                self.handle
                    .cancel_tcpip_forward(route.address, u32::from(route.port)),
            )
            .await;
        }
    }
}

fn address_matches(configured: &str, received: &str) -> bool {
    configured == received
        || configured == "*"
        || configured == "0.0.0.0"
        || configured == "::"
        || (configured == "localhost" && matches!(received, "127.0.0.1" | "::1"))
}

fn parse_forward(tunnel: &SshTunnel) -> AppResult<Forward> {
    let port = tunnel
        .local_port
        .filter(|port| *port != 0)
        .ok_or_else(|| AppError::validation("SSH 隧道绑定端口必须在 1 到 65535 之间"))?;
    let address = tunnel
        .bind_address
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .unwrap_or("127.0.0.1")
        .to_owned();
    let target = match tunnel.kind {
        SshTunnelKind::Local | SshTunnelKind::Remote => Some((
            tunnel
                .remote_host
                .as_deref()
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .ok_or_else(|| AppError::validation("SSH 隧道缺少目标主机"))?
                .to_owned(),
            tunnel
                .remote_port
                .filter(|p| *p != 0)
                .ok_or_else(|| AppError::validation("SSH 隧道缺少有效目标端口"))?,
        )),
        _ => None,
    };
    Ok(Forward {
        address,
        port,
        target,
    })
}

async fn serve_local<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    mut socket: TcpStream,
    fixed: Option<(String, u16)>,
    origin: String,
    origin_port: u32,
) -> io::Result<()> {
    let socks = if fixed.is_none() {
        Some(
            timeout(SETUP_TIMEOUT, socks_request(&mut socket))
                .await
                .map_err(|_| timed_out())??,
        )
    } else {
        None
    };
    let (host, port) = fixed.unwrap_or_else(|| socks.as_ref().unwrap().target.clone());
    let opened = timeout(
        SETUP_TIMEOUT,
        handle.channel_open_direct_tcpip(host, u32::from(port), origin, origin_port),
    )
    .await;
    let channel = match opened {
        Ok(Ok(channel)) => channel,
        _ => {
            if let Some(request) = socks {
                socks_reply(&mut socket, request.version, false).await?;
            }
            return Err(io::Error::other("SSH forwarding connection failed"));
        }
    };
    if let Some(request) = socks {
        socks_reply(&mut socket, request.version, true).await?;
    }
    relay(socket, channel.into_stream()).await
}

async fn serve_remote(
    channel: Channel<client::Msg>,
    fixed: Option<(String, u16)>,
) -> io::Result<()> {
    let mut stream = channel.into_stream();
    let socks = if fixed.is_none() {
        Some(
            timeout(SETUP_TIMEOUT, socks_request(&mut stream))
                .await
                .map_err(|_| timed_out())??,
        )
    } else {
        None
    };
    let target = fixed.unwrap_or_else(|| socks.as_ref().unwrap().target.clone());
    let opened = timeout(SETUP_TIMEOUT, TcpStream::connect(target)).await;
    let socket = match opened {
        Ok(Ok(socket)) => socket,
        _ => {
            if let Some(request) = socks {
                socks_reply(&mut stream, request.version, false).await?;
            }
            return Err(io::Error::other("forwarding target unavailable"));
        }
    };
    if let Some(request) = socks {
        socks_reply(&mut stream, request.version, true).await?;
    }
    relay(socket, stream).await
}

async fn relay<A, B>(mut first: A, mut second: B) -> io::Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    // Tokio shuts down each writer after the opposite reader reaches EOF,
    // while keeping the remaining direction alive for the response.
    tokio::io::copy_bidirectional(&mut first, &mut second)
        .await
        .map(|_| ())
}

fn malformed() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid or unsupported SOCKS request",
    )
}
fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "forwarding setup timed out")
}

struct SocksRequest {
    version: u8,
    target: (String, u16),
}

async fn socks_request<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
) -> io::Result<SocksRequest> {
    let version = stream.read_u8().await?;
    let (host, port) = match version {
        4 => {
            let command = stream.read_u8().await?;
            let port = stream.read_u16().await?;
            let mut ip = [0; 4];
            stream.read_exact(&mut ip).await?;
            read_cstring(stream).await?; // user id is ignored, never logged.
            if command != 1 {
                socks_reply(stream, 4, false).await?;
                return Err(malformed());
            }
            let host = if ip[..3] == [0, 0, 0] && ip[3] != 0 {
                String::from_utf8(read_cstring(stream).await?).map_err(|_| malformed())?
            } else {
                Ipv4Addr::from(ip).to_string()
            };
            (host, port)
        }
        5 => {
            let count = stream.read_u8().await?;
            let mut methods = vec![0; usize::from(count)];
            stream.read_exact(&mut methods).await?;
            if !methods.contains(&0) {
                stream.write_all(&[5, 255]).await?;
                return Err(malformed());
            }
            stream.write_all(&[5, 0]).await?;
            let mut header = [0; 4];
            stream.read_exact(&mut header).await?;
            if header[0] != 5 || header[1] != 1 || header[2] != 0 {
                stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                return Err(malformed());
            }
            let host = match header[3] {
                1 => {
                    let mut ip = [0; 4];
                    stream.read_exact(&mut ip).await?;
                    Ipv4Addr::from(ip).to_string()
                }
                3 => {
                    let length = stream.read_u8().await?;
                    let mut bytes = vec![0; usize::from(length)];
                    stream.read_exact(&mut bytes).await?;
                    String::from_utf8(bytes).map_err(|_| malformed())?
                }
                4 => {
                    let mut ip = [0; 16];
                    stream.read_exact(&mut ip).await?;
                    Ipv6Addr::from(ip).to_string()
                }
                _ => {
                    stream.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                    return Err(malformed());
                }
            };
            (host, stream.read_u16().await?)
        }
        _ => return Err(malformed()),
    };
    if host.is_empty() || host.contains('\0') || port == 0 {
        socks_reply(stream, version, false).await?;
        return Err(malformed());
    }
    Ok(SocksRequest {
        version,
        target: (host, port),
    })
}

async fn read_cstring<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    for _ in 0..256 {
        let byte = stream.read_u8().await?;
        if byte == 0 {
            return Ok(bytes);
        }
        bytes.push(byte);
    }
    Err(malformed())
}

async fn socks_reply<S: AsyncWrite + Unpin>(
    stream: &mut S,
    version: u8,
    success: bool,
) -> io::Result<()> {
    if version == 4 {
        stream
            .write_all(&[0, if success { 90 } else { 91 }, 0, 0, 0, 0, 0, 0])
            .await
    } else {
        stream
            .write_all(&[5, if success { 0 } else { 1 }, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server;
    use std::{
        collections::HashMap,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct TestClient(mpsc::Sender<ForwardedTcpip>);
    impl client::Handler for TestClient {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _: &russh::keys::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn server_channel_open_forwarded_tcpip(
            &mut self,
            channel: Channel<client::Msg>,
            address: &str,
            port: u32,
            _: &str,
            _: u32,
            _: &mut client::Session,
        ) -> Result<(), Self::Error> {
            let _ = self.0.try_send(ForwardedTcpip {
                channel,
                connected_address: address.to_owned(),
                connected_port: port,
            });
            Ok(())
        }
    }

    struct TestServer {
        tasks: JoinSet<()>,
        forwards: HashMap<(String, u32), tokio::task::AbortHandle>,
        canceled: Arc<AtomicUsize>,
    }

    impl server::Handler for TestServer {
        type Error = russh::Error;
        async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
            Ok(server::Auth::Accept)
        }
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<server::Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            _: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            let Ok(socket) = TcpStream::connect((host, port as u16)).await else {
                return Ok(false);
            };
            self.tasks.spawn(async move {
                let _ = relay(socket, channel.into_stream()).await;
            });
            Ok(true)
        }
        async fn tcpip_forward(
            &mut self,
            address: &str,
            port: &mut u32,
            session: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            let Ok(listener) = TcpListener::bind((address, *port as u16)).await else {
                return Ok(false);
            };
            let handle = session.handle();
            let address = address.to_owned();
            let remote_port = *port;
            let route = (address.clone(), remote_port);
            let abort = self.tasks.spawn(async move {
                let mut connections = JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let Ok((socket,origin)) = accepted else { break; };
                            let handle = handle.clone(); let address = address.clone();
                            connections.spawn(async move {
                                if let Ok(channel) = handle.channel_open_forwarded_tcpip(address, remote_port, origin.ip().to_string(), u32::from(origin.port())).await {
                                    let _ = relay(socket, channel.into_stream()).await;
                                }
                            });
                        }
                        _ = connections.join_next(), if !connections.is_empty() => {}
                    }
                }
            });
            self.forwards.insert(route, abort);
            Ok(true)
        }
        async fn cancel_tcpip_forward(
            &mut self,
            address: &str,
            port: u32,
            _: &mut server::Session,
        ) -> Result<bool, Self::Error> {
            if let Some(task) = self.forwards.remove(&(address.to_owned(), port)) {
                task.abort();
                self.canceled.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }

    struct Fixture {
        handle: Arc<client::Handle<TestClient>>,
        receiver: Option<mpsc::Receiver<ForwardedTcpip>>,
        canceled: Arc<AtomicUsize>,
        tasks: JoinSet<()>,
        target_port: u16,
    }

    async fn fixture() -> Fixture {
        // Deterministic, test-only host key; never reads the user's credentials.
        let pair = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[7; 32]);
        let key = russh::keys::PrivateKey::new(pair.into(), "loopback test").unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let canceled = Arc::new(AtomicUsize::new(0));
        let handler = TestServer {
            tasks: JoinSet::new(),
            forwards: HashMap::new(),
            canceled: Arc::clone(&canceled),
        };
        let mut tasks = JoinSet::new();
        tasks.spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let session = server::run_stream(config, socket, handler).await.unwrap();
            let _ = session.await;
        });
        let (sender, receiver) = mpsc::channel(256);
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            address,
            TestClient(sender),
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_none("loopback")
            .await
            .unwrap()
            .success());
        let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target_port = target.local_addr().unwrap().port();
        tasks.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = target.accept() => {
                        let (mut socket,_) = accepted.unwrap();
                        connections.spawn(async move {
                            let mut bytes = Vec::new();
                            socket.read_to_end(&mut bytes).await.unwrap();
                            socket.write_all(&bytes).await.unwrap();
                            socket.shutdown().await.unwrap();
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Fixture {
            handle: Arc::new(handle),
            receiver: Some(receiver),
            canceled,
            tasks,
            target_port,
        }
    }

    async fn available_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn config(kind: SshTunnelKind, port: u16, target_port: u16) -> SshTunnel {
        SshTunnel {
            mode: None,
            name: None,
            kind,
            auto_open: true,
            bind_address: Some("127.0.0.1".to_owned()),
            local_port: Some(port),
            remote_host: Some("127.0.0.1".to_owned()),
            remote_port: Some(target_port),
        }
    }

    async fn roundtrip(port: u16, socks: bool, target_port: u16) {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        if socks {
            socket.write_all(&[5, 1, 0]).await.unwrap();
            let mut method = [0; 2];
            socket.read_exact(&mut method).await.unwrap();
            assert_eq!(method, [5, 0]);
            let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
            request.extend(target_port.to_be_bytes());
            socket.write_all(&request).await.unwrap();
            let mut response = [0; 10];
            socket.read_exact(&mut response).await.unwrap();
            assert_eq!(response[1], 0);
        }
        let bytes: Vec<u8> = (0..=255).cycle().take(32768).collect();
        socket.write_all(&bytes).await.unwrap();
        socket.shutdown().await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        assert_eq!(response, bytes);
    }

    #[tokio::test]
    async fn loopback_all_four_tunnel_kinds_transfer_binary_and_shutdown() {
        timeout(Duration::from_secs(20), async {
            let mut fixture = fixture().await;
            let mut configs = Vec::new();
            for kind in [
                SshTunnelKind::Local,
                SshTunnelKind::Remote,
                SshTunnelKind::Dynamic,
                SshTunnelKind::RemoteDynamic,
            ] {
                configs.push(config(kind, available_port().await, fixture.target_port));
            }
            let mut tunnels = NativeTunnels::start(
                Arc::clone(&fixture.handle),
                &configs,
                fixture.receiver.take().unwrap(),
            )
            .await
            .unwrap();
            for config in &configs {
                roundtrip(
                    config.local_port.unwrap(),
                    matches!(
                        config.kind,
                        SshTunnelKind::Dynamic | SshTunnelKind::RemoteDynamic
                    ),
                    fixture.target_port,
                )
                .await;
            }
            tunnels.shutdown().await;
            assert_eq!(fixture.canceled.load(Ordering::SeqCst), 2);
            for config in configs {
                assert!(TcpListener::bind(("127.0.0.1", config.local_port.unwrap()))
                    .await
                    .is_ok());
            }
            fixture
                .handle
                .disconnect(russh::Disconnect::ByApplication, "test completed", "")
                .await
                .unwrap();
            fixture.tasks.abort_all();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn loopback_partial_start_failure_rolls_back_remote_and_local_listeners() {
        timeout(Duration::from_secs(20), async {
            let mut fixture = fixture().await;
            let remote_port = available_port().await;
            let local_port = available_port().await;
            let occupied = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let occupied_port = occupied.local_addr().unwrap().port();
            let configs = [
                config(SshTunnelKind::Remote, remote_port, fixture.target_port),
                config(SshTunnelKind::Local, local_port, fixture.target_port),
                config(SshTunnelKind::Dynamic, occupied_port, fixture.target_port),
            ];
            assert!(NativeTunnels::start(
                Arc::clone(&fixture.handle),
                &configs,
                fixture.receiver.take().unwrap()
            )
            .await
            .is_err());
            assert_eq!(fixture.canceled.load(Ordering::SeqCst), 1);
            assert!(TcpListener::bind(("127.0.0.1", remote_port)).await.is_ok());
            assert!(TcpListener::bind(("127.0.0.1", local_port)).await.is_ok());
            fixture
                .handle
                .disconnect(russh::Disconnect::ByApplication, "test completed", "")
                .await
                .unwrap();
            fixture.tasks.abort_all();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn loopback_remote_denial_and_disabled_tunnel_are_explicit() {
        timeout(Duration::from_secs(20), async {
            let mut fixture = fixture().await;
            let occupied = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = occupied.local_addr().unwrap().port();
            let denied = config(SshTunnelKind::Remote, port, fixture.target_port);
            let error = NativeTunnels::start(
                Arc::clone(&fixture.handle),
                &[denied],
                fixture.receiver.take().unwrap(),
            )
            .await
            .err()
            .unwrap();
            assert!(error.to_string().contains("服务器拒绝"));
            fixture
                .handle
                .disconnect(russh::Disconnect::ByApplication, "test completed", "")
                .await
                .unwrap();
            fixture.tasks.abort_all();

            let mut fixture = self::fixture().await;
            let mut disabled = config(SshTunnelKind::Remote, port, fixture.target_port);
            disabled.auto_open = false;
            disabled.local_port = None;
            let mut tunnels = NativeTunnels::start(
                Arc::clone(&fixture.handle),
                &[disabled],
                fixture.receiver.take().unwrap(),
            )
            .await
            .unwrap();
            tunnels.shutdown().await;
            assert_eq!(fixture.canceled.load(Ordering::SeqCst), 0);
            fixture
                .handle
                .disconnect(russh::Disconnect::ByApplication, "test completed", "")
                .await
                .unwrap();
            fixture.tasks.abort_all();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn loopback_failed_socks_connect_returns_failure_and_allows_next_connection() {
        timeout(Duration::from_secs(20), async {
            let mut fixture = fixture().await;
            let closed_port = available_port().await;
            let port = available_port().await;
            let tunnel = config(SshTunnelKind::Dynamic, port, fixture.target_port);
            let mut tunnels = NativeTunnels::start(
                Arc::clone(&fixture.handle),
                &[tunnel],
                fixture.receiver.take().unwrap(),
            )
            .await
            .unwrap();
            let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            socket.write_all(&[5, 1, 0]).await.unwrap();
            let mut method = [0; 2];
            socket.read_exact(&mut method).await.unwrap();
            let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
            request.extend(closed_port.to_be_bytes());
            socket.write_all(&request).await.unwrap();
            let mut response = [0; 10];
            socket.read_exact(&mut response).await.unwrap();
            assert_eq!(response[0], 5);
            assert_ne!(response[1], 0);
            let mut byte = [0; 1];
            assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
            roundtrip(port, true, fixture.target_port).await;
            tunnels.shutdown().await;
            fixture
                .handle
                .disconnect(russh::Disconnect::ByApplication, "test completed", "")
                .await
                .unwrap();
            fixture.tasks.abort_all();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn relay_preserves_every_byte_and_half_close() {
        let (mut caller, left) = tokio::io::duplex(1024);
        let (right, mut target) = tokio::io::duplex(1024);
        let relay_task = tokio::spawn(relay(left, right));
        let expected: Vec<u8> = (0..=255).cycle().take(32768).collect();
        let received = expected.clone();
        let target_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            target.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, received);
            target
                .write_all(b"response after EOF\x18\x03\xff")
                .await
                .unwrap();
            target.shutdown().await.unwrap();
        });
        caller.write_all(&expected).await.unwrap();
        caller.shutdown().await.unwrap();
        let mut response = Vec::new();
        caller.read_to_end(&mut response).await.unwrap();
        assert_eq!(response, b"response after EOF\x18\x03\xff");
        target_task.await.unwrap();
        relay_task.await.unwrap().unwrap();
    }

    async fn parse(bytes: &[u8]) -> io::Result<SocksRequest> {
        let (mut sender, mut receiver) = tokio::io::duplex(2048);
        sender.write_all(bytes).await.unwrap();
        sender.shutdown().await.unwrap();
        socks_request(&mut receiver).await
    }

    #[tokio::test]
    async fn socks_versions_and_malformed_requests() {
        assert_eq!(
            parse(&[4, 1, 0, 80, 127, 0, 0, 1, 0]).await.unwrap().target,
            ("127.0.0.1".into(), 80)
        );
        assert_eq!(
            parse(b"\x04\x01\x00\x50\x00\x00\x00\x01user\x00example.org\x00")
                .await
                .unwrap()
                .target,
            ("example.org".into(), 80)
        );
        assert_eq!(
            parse(b"\x05\x01\x00\x05\x01\x00\x03\x0bexample.org\x01\xbb")
                .await
                .unwrap()
                .target,
            ("example.org".into(), 443)
        );
        for bytes in [
            &[5, 1, 2][..],
            &[4, 2, 0, 80, 127, 0, 0, 1, 0],
            &[5, 1, 0, 5, 3, 0, 1],
            &[5, 1, 0, 5, 1, 0, 9],
            &[4, 1, 0, 0, 127, 0, 0, 1, 0],
            &[5, 1, 0, 5, 1, 0, 3, 0, 0, 80],
            &[6],
            &[5, 1],
        ] {
            assert!(parse(bytes).await.is_err());
        }
        let mut unterminated = vec![4, 1, 0, 80, 127, 0, 0, 1];
        unterminated.extend([b'a'; 256]);
        assert!(parse(&unterminated).await.is_err());
    }

    #[tokio::test]
    async fn socks_ipv6_and_pipelined_binary_payload() {
        let (mut sender, mut receiver) = tokio::io::duplex(2048);
        let mut bytes = vec![5, 1, 0, 5, 1, 0, 4];
        bytes.extend(Ipv6Addr::LOCALHOST.octets());
        bytes.extend([0, 80]);
        bytes.extend([0, 3, 24, 255]);
        sender.write_all(&bytes).await.unwrap();
        let request = socks_request(&mut receiver).await.unwrap();
        assert_eq!(request.target, ("::1".to_owned(), 80));
        let mut payload = [0; 4];
        receiver.read_exact(&mut payload).await.unwrap();
        assert_eq!(payload, [0, 3, 24, 255]);
        assert_eq!(
            parse(&[4, 1, 0, 80, 127, 0, 0, 1, 255, 0])
                .await
                .unwrap()
                .target
                .1,
            80
        );
    }

    #[tokio::test]
    async fn dropping_supervisor_releases_nested_listener_and_connection() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut supervisors = JoinSet::new();
        supervisors.spawn(async move {
            let mut connections = JoinSet::new();
            let (socket, _) = listener.accept().await.unwrap();
            connections.spawn(async move {
                let _socket = socket;
                std::future::pending::<()>().await;
            });
            ready_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let mut caller = TcpStream::connect(address).await.unwrap();
        ready_rx.await.unwrap();
        supervisors.abort_all();
        while supervisors.join_next().await.is_some() {}
        let mut byte = [0; 1];
        assert_eq!(
            timeout(SETUP_TIMEOUT, caller.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(TcpListener::bind(address).await.is_ok());
    }

    #[test]
    fn invalid_config_is_not_silently_skipped_and_disabled_config_is_distinct() {
        let mut tunnel = SshTunnel {
            mode: None,
            name: None,
            kind: SshTunnelKind::Local,
            auto_open: false,
            bind_address: None,
            local_port: Some(12345),
            remote_host: None,
            remote_port: None,
        };
        assert!(parse_forward(&tunnel).is_err());
        tunnel.kind = SshTunnelKind::Dynamic;
        assert!(parse_forward(&tunnel).is_ok());
        tunnel.local_port = Some(0);
        assert!(parse_forward(&tunnel).is_err());
    }
}
