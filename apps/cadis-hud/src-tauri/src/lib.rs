mod daemon_transport;
mod voice;

use std::env;
use std::io::{self, Write};
use std::net::Shutdown;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::Value;
use tauri::{Emitter, Manager};

use daemon_transport::{
    connect_daemon, discover_transport, read_subscription_frames, send_cadis_request,
    DaemonStream, DaemonTransport,
};
use voice::{
    edge_tts_speak_blocking, local_stt_transcribe_blocking, stop_active_tts,
    voice_doctor_preflight_blocking, TtsPlaybackState, VoiceDoctorCheck, VoiceDoctorReport,
};

const CADIS_FRAME_EVENT: &str = "cadis-frame";
const CADIS_SUBSCRIPTION_CLOSED_EVENT: &str = "cadis-subscription-closed";

#[derive(Default)]
struct CadisSubscriptionState {
    generation: AtomicU64,
    stream: Mutex<Option<DaemonStream>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CadisSubscriptionClosed {
    generation: u64,
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
async fn cadis_request(request: Value, socket_path: Option<String>) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let transport = discover_transport(socket_path)?;
        send_cadis_request(&transport, request).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("CADIS request worker failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn cadis_events_subscribe(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<CadisSubscriptionState>>,
    request: Value,
    socket_path: Option<String>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let transport = discover_transport(socket_path)?;
        start_cadis_event_subscription(app, state, &transport, request)
    })
    .await
    .map_err(|error| format!("CADIS subscription worker failed: {error}"))?
}

#[tauri::command]
fn cadis_events_unsubscribe(
    state: tauri::State<'_, Arc<CadisSubscriptionState>>,
) -> Result<(), String> {
    state.inner().close_active_subscription()
}

#[tauri::command]
fn window_start_dragging(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
async fn edge_tts_speak(
    state: tauri::State<'_, Arc<TtsPlaybackState>>,
    text: String, voice_id: String, rate: String, pitch: String, volume: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        edge_tts_speak_blocking(&state, text, voice_id, rate, pitch, volume)
    })
    .await
    .map_err(|error| format!("TTS worker failed: {error}"))?
}

#[tauri::command]
fn edge_tts_stop(state: tauri::State<'_, Arc<TtsPlaybackState>>) -> Result<(), String> {
    stop_active_tts(state.inner())
}

#[tauri::command(rename_all = "camelCase")]
async fn local_stt_transcribe(audio_base64: String, language: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || local_stt_transcribe_blocking(audio_base64, language))
        .await
        .map_err(|error| format!("STT worker failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn voice_doctor_preflight(renderer_mic: VoiceDoctorCheck) -> Result<VoiceDoctorReport, String> {
    tauri::async_runtime::spawn_blocking(move || voice_doctor_preflight_blocking(renderer_mic))
        .await
        .map_err(|error| format!("voice doctor worker failed: {error}"))
}

#[tauri::command]
fn voice_tts_speak(_text: String, _voice_id: Option<String>) -> Result<(), String> { Ok(()) }

#[tauri::command]
fn voice_tts_stop() -> Result<(), String> { Ok(()) }

#[tauri::command]
fn voice_stt_start() -> Result<(), String> { Ok(()) }

#[tauri::command]
fn voice_stt_stop() -> Result<(), String> { Ok(()) }

#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    // Desktop convenience: open a CADIS-owned worktree in the user's editor.
    // Validate the canonical path contains a .cadis/worktrees/ segment.
    let canonical =
        std::fs::canonicalize(&path).map_err(|e| format!("cannot resolve path: {e}"))?;
    let canonical_str = canonical.to_string_lossy();
    if !canonical_str.contains("/.cadis/worktrees/")
        && !canonical_str.contains("\\.cadis\\worktrees\\")
    {
        return Err("path is not inside a CADIS-owned worktree".to_owned());
    }
    launch_editor_with_fallback(&canonical)
}

fn launch_editor_with_fallback(path: &Path) -> Result<(), String> {
    let editor_env = env::var("EDITOR").ok();
    let mut errors = Vec::new();

    for (program, args) in editor_launch_plan(editor_env.as_deref()) {
        let mut command = Command::new(&program);
        command.args(&args).arg(path);
        match command.spawn() {
            Ok(_) => return Ok(()),
            Err(error) => {
                errors.push(format!(
                    "{} ({error})",
                    format_editor_command(&program, &args)
                ));
            }
        }
    }

    match open_with_system_default(path) {
        Ok(()) => Ok(()),
        Err(error) => {
            errors.push(format!("system default opener ({error})"));
            Err(format!(
                "failed to open editor for '{}': {}",
                path.display(),
                errors.join("; ")
            ))
        }
    }
}

fn editor_launch_plan(editor_env: Option<&str>) -> Vec<(String, Vec<String>)> {
    let mut plan: Vec<(String, Vec<String>)> = Vec::new();
    if let Some((program, args)) = parse_editor_command(editor_env) {
        push_editor_candidate(&mut plan, program, args);
    }
    for program in default_editor_candidates() {
        push_editor_candidate(&mut plan, (*program).to_owned(), Vec::new());
    }
    plan
}

fn parse_editor_command(editor_env: Option<&str>) -> Option<(String, Vec<String>)> {
    let value = editor_env?.trim();
    if value.is_empty() {
        return None;
    }
    let mut parts = split_editor_command(value).into_iter();
    let program = parts.next()?;
    if program.trim().is_empty() {
        return None;
    }
    let args = parts.collect::<Vec<_>>();
    Some((program, args))
}

fn split_editor_command(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    let mut quote = None;
    let mut in_token = false;

    while let Some(ch) = chars.next() {
        match quote {
            Some(active_quote) if ch == active_quote => {
                quote = None;
                in_token = true;
            }
            Some(_) if ch == '\\' => {
                if should_escape_editor_char(chars.peek().copied(), true) {
                    let next = chars.next().unwrap_or(ch);
                    current.push(next);
                } else {
                    current.push(ch);
                }
                in_token = true;
            }
            Some(_) => {
                current.push(ch);
                in_token = true;
            }
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                in_token = true;
            }
            None if ch == '\\' => {
                if should_escape_editor_char(chars.peek().copied(), false) {
                    let next = chars.next().unwrap_or(ch);
                    current.push(next);
                } else {
                    current.push(ch);
                }
                in_token = true;
            }
            None if ch.is_whitespace() => {
                if in_token {
                    parts.push(std::mem::take(&mut current));
                    in_token = false;
                }
            }
            None => {
                current.push(ch);
                in_token = true;
            }
        }
    }

    if in_token {
        parts.push(current);
    }
    parts
}

fn should_escape_editor_char(next: Option<char>, in_quote: bool) -> bool {
    match next {
        Some('\\' | '\'' | '"') => true,
        Some(ch) if !in_quote && ch.is_whitespace() => true,
        _ => false,
    }
}

fn push_editor_candidate(
    plan: &mut Vec<(String, Vec<String>)>,
    program: String,
    args: Vec<String>,
) {
    if plan.iter().any(|(existing_program, existing_args)| {
        existing_program == &program && existing_args == &args
    }) {
        return;
    }
    plan.push((program, args));
}

fn format_editor_command(program: &str, args: &[String]) -> String {
    if args.is_empty() {
        return program.to_owned();
    }
    format!("{} {}", program, args.join(" "))
}

fn default_editor_candidates() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["code", "cursor", "codium", "notepad++"]
    }
    #[cfg(target_os = "macos")]
    {
        &["code", "cursor", "codium"]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        &["code", "cursor", "codium"]
    }
}

fn open_with_system_default(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(path).spawn().map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn().map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn().map(|_| ())
    }
}

// ---------------------------------------------------------------------------
// Subscription state
// ---------------------------------------------------------------------------

impl CadisSubscriptionState {
    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn replace_active_subscription(&self, stream: DaemonStream) -> Result<(), String> {
        let mut active = self.stream.lock().map_err(|_| "CADIS subscription state lock was poisoned".to_owned())?;
        if let Some(existing) = active.take() { let _ = existing.shutdown(Shutdown::Both); }
        *active = Some(stream);
        Ok(())
    }

    fn close_active_subscription(&self) -> Result<(), String> {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let stream = self.stream.lock().map_err(|_| "CADIS subscription state lock was poisoned".to_owned())?.take();
        if let Some(stream) = stream { let _ = stream.shutdown(Shutdown::Both); }
        Ok(())
    }

    fn clear_active_subscription_if_current(&self, generation: u64) {
        if !self.is_current(generation) { return; }
        if let Ok(mut active) = self.stream.lock() { active.take(); }
    }
}

fn start_cadis_event_subscription(
    app: tauri::AppHandle, state: Arc<CadisSubscriptionState>,
    transport: &DaemonTransport, request: Value,
) -> Result<(), String> {
    let mut stream = connect_daemon(transport)?;
    serde_json::to_writer(&mut stream, &request)
        .map_err(|error| format!("could not encode CADIS subscription request: {error}"))?;
    stream.write_all(b"\n").map_err(|error| format!("could not send CADIS subscription request: {error}"))?;
    let active_stream = stream.try_clone().map_err(|error| format!("could not track CADIS subscription socket: {error}"))?;
    let generation = state.next_generation();
    state.replace_active_subscription(active_stream)?;
    thread::spawn(move || {
        let result = read_subscription_frames(stream, |frame| {
            app.emit(CADIS_FRAME_EVENT, frame).map_err(|error| io::Error::other(error.to_string()))
        });
        if state.is_current(generation) {
            state.clear_active_subscription_if_current(generation);
            let error = result.err().map(|error| error.to_string());
            let _ = app.emit(CADIS_SUBSCRIPTION_CLOSED_EVENT, CadisSubscriptionClosed { generation, error });
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Window setup
// ---------------------------------------------------------------------------

fn set_cadis_window_icon(window: &tauri::WebviewWindow) -> Result<(), String> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
        .map_err(|error| format!("could not load CADIS icon: {error}"))?;
    window.set_icon(icon).map_err(|error| format!("could not set CADIS window icon: {error}"))
}

#[cfg(target_os = "linux")]
fn install_microphone_permission_handler(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::glib::prelude::Cast;
        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};
        let inner = webview.inner();
        if let Some(settings) = inner.settings() { settings.set_enable_media_stream(true); }
        inner.connect_permission_request(|_, request| {
            let Some(user_media) = request.dynamic_cast_ref::<UserMediaPermissionRequest>() else { return false; };
            if user_media.is_for_audio_device() && !user_media.is_for_video_device() { user_media.allow(); return true; }
            false
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn install_microphone_permission_handler(_window: &tauri::WebviewWindow) {}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(TtsPlaybackState::default()))
        .manage(Arc::new(CadisSubscriptionState::default()))
        .invoke_handler(tauri::generate_handler![
            cadis_request,
            cadis_events_subscribe,
            cadis_events_unsubscribe,
            window_start_dragging,
            edge_tts_speak,
            edge_tts_stop,
            local_stt_transcribe,
            voice_doctor_preflight,
            voice_tts_speak,
            voice_tts_stop,
            voice_stt_start,
            voice_stt_stop,
            open_in_editor
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = set_cadis_window_icon(&window);
                install_microphone_permission_handler(&window);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.center();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run CADIS HUD");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::daemon_transport::*;
    use std::env;
    use std::fs;
    #[cfg(unix)]
    use std::io::{BufRead, BufReader, Write};
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    #[test]
    fn discovery_prefers_explicit_socket_path() {
        let env = DiscoveryEnv {
            cadis_tcp_port: None, cadis_hud_socket: Some("/tmp/hud.sock".to_owned()),
            cadis_socket: Some("/tmp/cadis.sock".to_owned()), home: Some(PathBuf::from("/home/cadis")),
            xdg_runtime_dir: Some("/run/user/1000".to_owned()),
        };
        let transport = discover_transport_with_env(Some("~/explicit.sock".to_owned()), &env).unwrap();
        match transport { DaemonTransport::Socket(path) => assert_eq!(path, PathBuf::from("/home/cadis/explicit.sock")), _ => panic!("expected Socket transport") }
    }

    #[cfg(unix)]
    #[test]
    fn discovery_prefers_hud_env_over_generic_env() {
        let env = DiscoveryEnv {
            cadis_tcp_port: None, cadis_hud_socket: Some("/tmp/hud.sock".to_owned()),
            cadis_socket: Some("/tmp/cadis.sock".to_owned()), home: Some(PathBuf::from("/home/cadis")),
            xdg_runtime_dir: None,
        };
        let transport = discover_transport_with_env(None, &env).unwrap();
        match transport { DaemonTransport::Socket(path) => assert_eq!(path, PathBuf::from("/tmp/hud.sock")), _ => panic!("expected Socket transport") }
    }

    #[cfg(unix)]
    #[test]
    fn discovery_uses_config_before_runtime_default() {
        let home = unique_temp_dir();
        fs::create_dir_all(home.join(".cadis")).unwrap();
        fs::write(home.join(CADIS_CONFIG_RELATIVE_PATH), "socket_path = \"~/.cadis/custom.sock\"\n").unwrap();
        let env = DiscoveryEnv { cadis_tcp_port: None, home: Some(home.clone()), xdg_runtime_dir: Some("/run/user/1000".to_owned()), ..DiscoveryEnv::default() };
        let transport = discover_transport_with_env(None, &env).unwrap();
        match transport { DaemonTransport::Socket(path) => assert_eq!(path, home.join(".cadis/custom.sock")), _ => panic!("expected Socket transport") }
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn discovery_uses_xdg_runtime_dir_before_home_default() {
        let env = DiscoveryEnv { cadis_tcp_port: None, home: Some(PathBuf::from("/home/cadis")), xdg_runtime_dir: Some("/run/user/1000".to_owned()), ..DiscoveryEnv::default() };
        let transport = discover_transport_with_env(None, &env).unwrap();
        match transport { DaemonTransport::Socket(path) => assert_eq!(path, PathBuf::from("/run/user/1000/cadis/cadisd.sock")), _ => panic!("expected Socket transport") }
    }

    #[test]
    fn discovery_tcp_port_env_takes_priority() {
        let env = DiscoveryEnv {
            cadis_tcp_port: Some("9999".to_owned()), cadis_hud_socket: Some("/tmp/hud.sock".to_owned()),
            cadis_socket: Some("/tmp/cadis.sock".to_owned()), home: Some(PathBuf::from("/home/cadis")),
            #[cfg(unix)] xdg_runtime_dir: Some("/run/user/1000".to_owned()),
        };
        let transport = discover_transport_with_env(None, &env).unwrap();
        match transport { DaemonTransport::Tcp(addr) => assert_eq!(addr, "127.0.0.1:9999"), #[cfg(unix)] _ => panic!("expected Tcp transport") }
    }

    #[cfg(not(unix))]
    #[test]
    fn discovery_defaults_to_tcp_on_non_unix() {
        let env = DiscoveryEnv { cadis_tcp_port: None, cadis_hud_socket: None, cadis_socket: None, home: None };
        let transport = discover_transport_with_env(None, &env).unwrap();
        match transport { DaemonTransport::Tcp(addr) => assert_eq!(addr, DEFAULT_TCP_ADDRESS) }
    }

    #[cfg(unix)]
    #[test]
    fn cadis_request_writes_one_json_line_and_reads_frames() {
        let dir = unique_temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let socket_path = dir.join("cadisd.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
            assert_eq!(line.trim(), r#"{"type":"daemon.status"}"#);
            stream.write_all(b"{\"type\":\"request.accepted\"}\n\n{\"type\":\"daemon.status.response\",\"payload\":{\"status\":\"ok\"}}\n").unwrap();
        });
        let transport = DaemonTransport::Socket(socket_path);
        let frames = send_cadis_request(&transport, serde_json::json!({"type": "daemon.status"})).unwrap();
        server.join().unwrap();
        assert_eq!(frames, vec![serde_json::json!({"type": "request.accepted"}), serde_json::json!({"type": "daemon.status.response", "payload": {"status": "ok"}})]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn subscription_reader_emits_each_json_line() {
        use std::os::unix::net::UnixStream;
        let (mut writer, reader) = UnixStream::pair().unwrap();
        let server = thread::spawn(move || {
            writer.write_all(b"{\"frame\":\"response\",\"payload\":{\"type\":\"request.accepted\"}}\n\n{\"frame\":\"event\",\"payload\":{\"event_id\":\"evt_1\",\"type\":\"agent.list.response\",\"payload\":{\"agents\":[]}}}\n").unwrap();
        });
        let mut frames = Vec::new();
        read_subscription_frames(DaemonStream::Unix(reader), |frame| { frames.push(frame); Ok(()) }).unwrap();
        server.join().unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["frame"], "response");
        assert_eq!(frames[1]["payload"]["event_id"], "evt_1");
    }

    #[test]
    fn parse_editor_command_handles_empty_and_args() {
        assert_eq!(parse_editor_command(None), None);
        assert_eq!(parse_editor_command(Some("   ")), None);
        assert_eq!(
            parse_editor_command(Some("code --reuse-window --wait")),
            Some((
                "code".to_owned(),
                vec!["--reuse-window".to_owned(), "--wait".to_owned()]
            ))
        );
    }

    #[test]
    fn parse_editor_command_handles_quoted_program_path() {
        assert_eq!(
            parse_editor_command(Some("\"/opt/Visual Studio Code/code\" --reuse-window")),
            Some((
                "/opt/Visual Studio Code/code".to_owned(),
                vec!["--reuse-window".to_owned()]
            ))
        );
    }

    #[test]
    fn parse_editor_command_handles_quoted_and_escaped_args() {
        assert_eq!(
            parse_editor_command(Some("code '--profile CADIS Work' --goto src\\ main.rs:10")),
            Some((
                "code".to_owned(),
                vec![
                    "--profile CADIS Work".to_owned(),
                    "--goto".to_owned(),
                    "src main.rs:10".to_owned()
                ]
            ))
        );
    }

    #[test]
    fn parse_editor_command_preserves_unescaped_windows_backslashes() {
        assert_eq!(
            parse_editor_command(Some(r#"C:\Tools\editor.exe --reuse-window"#)),
            Some((
                r#"C:\Tools\editor.exe"#.to_owned(),
                vec!["--reuse-window".to_owned()]
            ))
        );
    }

    #[test]
    fn editor_launch_plan_prefers_editor_env_and_deduplicates() {
        let plan = editor_launch_plan(Some("code --reuse-window"));
        assert_eq!(plan.first().map(|item| item.0.as_str()), Some("code"));
        assert_eq!(
            plan.first().map(|item| item.1.clone()),
            Some(vec!["--reuse-window".to_owned()])
        );

        let duplicates = plan
            .iter()
            .filter(|(program, args)| program == "code" && args.is_empty())
            .count();
        assert_eq!(duplicates, 1);
    }

    fn unique_temp_dir() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        env::temp_dir().join(format!("cadis-hud-test-{}-{nanos}", std::process::id()))
    }
}
