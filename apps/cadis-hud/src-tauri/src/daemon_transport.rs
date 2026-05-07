use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use serde_json::Value;

pub(crate) const CADIS_CONFIG_RELATIVE_PATH: &str = ".cadis/config.toml";
#[cfg(unix)]
pub(crate) const CADIS_SOCKET_RELATIVE_PATH: &str = ".cadis/run/cadisd.sock";
pub(crate) const DEFAULT_TCP_ADDRESS: &str = "127.0.0.1:7433";

/// Transport-agnostic stream that wraps either a Unix socket or a TCP connection.
pub(crate) enum DaemonStream {
    #[cfg(unix)]
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Read for DaemonStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.read(buf),
            Self::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for DaemonStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.write(buf),
            Self::Tcp(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.flush(),
            Self::Tcp(s) => s.flush(),
        }
    }
}

impl DaemonStream {
    pub(crate) fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.shutdown(how),
            Self::Tcp(s) => s.shutdown(how),
        }
    }

    pub(crate) fn try_clone(&self) -> io::Result<Self> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => s.try_clone().map(Self::Unix),
            Self::Tcp(s) => s.try_clone().map(Self::Tcp),
        }
    }
}

/// Resolved daemon transport: either a Unix socket path or a TCP address.
#[derive(Debug)]
pub(crate) enum DaemonTransport {
    #[cfg(unix)]
    Socket(PathBuf),
    Tcp(String),
}

pub(crate) fn connect_daemon(transport: &DaemonTransport) -> Result<DaemonStream, String> {
    match transport {
        #[cfg(unix)]
        DaemonTransport::Socket(path) => UnixStream::connect(path)
            .map(DaemonStream::Unix)
            .map_err(|e| format!("could not connect to cadisd at {}: {e}", path.display())),
        DaemonTransport::Tcp(addr) => TcpStream::connect(addr)
            .map(DaemonStream::Tcp)
            .map_err(|e| format!("could not connect to cadisd at tcp://{addr}: {e}")),
    }
}

pub(crate) fn discover_transport(explicit_socket: Option<String>) -> Result<DaemonTransport, String> {
    let env = DiscoveryEnv::from_process();
    discover_transport_with_env(explicit_socket, &env)
}

pub(crate) fn send_cadis_request(transport: &DaemonTransport, request: Value) -> io::Result<Vec<Value>> {
    let mut stream = connect_daemon(transport).map_err(|msg| io::Error::new(io::ErrorKind::ConnectionRefused, msg))?;
    serde_json::to_writer(&mut stream, &request)?;
    stream.write_all(b"\n")?;
    stream.shutdown(Shutdown::Write)?;
    read_json_lines(stream)
}

pub(crate) fn read_json_lines(stream: DaemonStream) -> io::Result<Vec<Value>> {
    let reader = BufReader::new(stream);
    let mut frames = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() { continue; }
        let value = serde_json::from_str::<Value>(line).map_err(|error| {
            io::Error::new(io::ErrorKind::InvalidData, format!("cadisd returned invalid JSON on line {}: {error}", index + 1))
        })?;
        frames.push(value);
    }
    Ok(frames)
}

pub(crate) fn read_subscription_frames<F>(stream: DaemonStream, mut emit: F) -> io::Result<()>
where
    F: FnMut(Value) -> io::Result<()>,
{
    let reader = BufReader::new(stream);
    for (index, line) in reader.lines().enumerate() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() { continue; }
        let value = serde_json::from_str::<Value>(line).map_err(|error| {
            io::Error::new(io::ErrorKind::InvalidData, format!("cadisd returned invalid subscription JSON on line {}: {error}", index + 1))
        })?;
        emit(value)?;
    }
    Ok(())
}

pub(crate) fn discover_transport_with_env(
    explicit_socket: Option<String>,
    env: &DiscoveryEnv,
) -> Result<DaemonTransport, String> {
    if let Some(port) = non_empty(env.cadis_tcp_port.clone()) {
        let port: u16 = port.parse().map_err(|e| format!("CADIS_TCP_PORT is not a valid port: {e}"))?;
        return Ok(DaemonTransport::Tcp(format!("127.0.0.1:{port}")));
    }
    #[cfg(unix)]
    {
        if let Some(path) = non_empty(explicit_socket) {
            return expand_home(&path, env).map(DaemonTransport::Socket).map_err(|e| e.to_string());
        }
        if let Some(path) = non_empty(env.cadis_hud_socket.clone()) {
            return expand_home(&path, env).map(DaemonTransport::Socket).map_err(|e| e.to_string());
        }
        if let Some(path) = non_empty(env.cadis_socket.clone()) {
            return expand_home(&path, env).map(DaemonTransport::Socket).map_err(|e| e.to_string());
        }
        if let Some(path) = config_socket_path(env)? {
            return expand_home(&path, env).map(DaemonTransport::Socket).map_err(|e| e.to_string());
        }
        if let Some(runtime_dir) = non_empty(env.xdg_runtime_dir.clone()) {
            return Ok(DaemonTransport::Socket(PathBuf::from(runtime_dir).join("cadis").join("cadisd.sock")));
        }
        if let Some(home) = env.home.as_ref() {
            return Ok(DaemonTransport::Socket(home.join(CADIS_SOCKET_RELATIVE_PATH)));
        }
    }
    #[cfg(not(unix))]
    let _ = explicit_socket;
    if let Some(addr) = config_tcp_address(env)? {
        return Ok(DaemonTransport::Tcp(addr));
    }
    Ok(DaemonTransport::Tcp(DEFAULT_TCP_ADDRESS.to_owned()))
}

#[derive(Debug, Default)]
pub(crate) struct DiscoveryEnv {
    pub cadis_tcp_port: Option<String>,
    pub cadis_hud_socket: Option<String>,
    pub cadis_socket: Option<String>,
    pub home: Option<PathBuf>,
    #[cfg(unix)]
    pub xdg_runtime_dir: Option<String>,
}

impl DiscoveryEnv {
    pub fn from_process() -> Self {
        Self {
            cadis_tcp_port: env::var("CADIS_TCP_PORT").ok(),
            cadis_hud_socket: env::var("CADIS_HUD_SOCKET").ok(),
            cadis_socket: env::var("CADIS_SOCKET").ok(),
            home: env::var_os("HOME").map(PathBuf::from),
            #[cfg(unix)]
            xdg_runtime_dir: env::var("XDG_RUNTIME_DIR").ok(),
        }
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_owned()) }
    })
}

#[cfg(unix)]
fn expand_home(path: &str, env: &DiscoveryEnv) -> io::Result<PathBuf> {
    if path == "~" {
        return env.home.clone().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unset"));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = env.home.as_ref().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unset"))?;
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(path))
}

#[cfg(unix)]
fn config_socket_path(env: &DiscoveryEnv) -> Result<Option<String>, String> {
    let Some(home) = env.home.as_ref() else { return Ok(None); };
    let config_path = home.join(CADIS_CONFIG_RELATIVE_PATH);
    let contents = match fs::read_to_string(&config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read CADIS config at {}: {error}", config_path.display())),
    };
    let value = contents.parse::<toml::Value>().map_err(|error| format!("could not parse CADIS config at {}: {error}", config_path.display()))?;
    Ok(value.get("socket_path").and_then(toml::Value::as_str).map(str::to_owned).and_then(|value| non_empty(Some(value))))
}

fn config_tcp_address(env: &DiscoveryEnv) -> Result<Option<String>, String> {
    let Some(home) = env.home.as_ref() else { return Ok(None); };
    let config_path = home.join(CADIS_CONFIG_RELATIVE_PATH);
    let contents = match fs::read_to_string(&config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read CADIS config at {}: {error}", config_path.display())),
    };
    let value = contents.parse::<toml::Value>().map_err(|error| format!("could not parse CADIS config at {}: {error}", config_path.display()))?;
    Ok(value.get("tcp_address").and_then(toml::Value::as_str).map(str::to_owned).and_then(|v| non_empty(Some(v))))
}
