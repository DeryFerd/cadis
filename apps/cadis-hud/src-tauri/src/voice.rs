use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::Value;

#[derive(Default)]
pub(crate) struct TtsPlaybackState {
    pub active_pid: Mutex<Option<u32>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalSttResult {
    pub text: String,
    pub latency_ms: u128,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceDoctorCheck {
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceDoctorReport {
    pub summary: String,
    pub checks: Vec<VoiceDoctorCheck>,
}

pub(crate) fn voice_doctor_preflight_blocking(renderer_mic: VoiceDoctorCheck) -> VoiceDoctorReport {
    let mut checks = vec![renderer_mic];
    checks.push(whisper_binary_check());
    checks.push(whisper_model_check());
    checks.push(node_helper_check());
    checks.push(audio_player_check());
    let failures = checks.iter().filter(|c| c.status == "fail").count();
    let warnings = checks.iter().filter(|c| c.status == "warn").count();
    let summary = if failures > 0 {
        format!("{failures} blocking issue{}", plural(failures))
    } else if warnings > 0 {
        format!("{warnings} warning{}", plural(warnings))
    } else {
        "ready".to_owned()
    };
    VoiceDoctorReport { summary, checks }
}

pub(crate) fn edge_tts_speak_blocking(
    state: &Arc<TtsPlaybackState>,
    text: String,
    provider: Option<String>,
    voice_id: String,
    rate: String,
    pitch: String,
    volume: String,
) -> Result<(), String> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err("empty TTS text".to_owned());
    }
    if text.chars().count() > 8_000 {
        return Err("TTS text is too long".to_owned());
    }
    stop_active_tts(state)?;
    let provider = effective_tts_provider(provider.as_deref());
    let path = temp_audio_path(
        if provider == "elevenlabs" {
            "cadis-elevenlabs-tts"
        } else {
            "cadis-edge-tts"
        },
        "mp3",
    )?;
    let synth_result = if provider == "elevenlabs" {
        synthesize_elevenlabs_tts(&path, &text, &voice_id)
    } else {
        synthesize_edge_tts(&path, &text, &voice_id, &rate, &pitch, &volume)
    };
    if let Err(error) = synth_result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    let playback_result = play_audio_file(state, &path);
    let _ = fs::remove_file(&path);
    playback_result
}

fn effective_tts_provider(provider: Option<&str>) -> &'static str {
    match provider.map(str::trim) {
        Some("elevenlabs") => "elevenlabs",
        _ => "edge",
    }
}

fn synthesize_elevenlabs_tts(out_path: &Path, text: &str, voice_id: &str) -> Result<(), String> {
    let api_key = env::var("CADIS_ELEVENLABS_API_KEY")
        .or_else(|_| env::var("ELEVENLABS_API_KEY"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(elevenlabs_api_key_from_secret_file)
        .ok_or_else(|| "ElevenLabs API key is not configured; set CADIS_ELEVENLABS_API_KEY or ~/.cadis/secrets/elevenlabs_api_key".to_owned())?;
    let voice_id = voice_id.trim();
    if voice_id.is_empty()
        || !voice_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid ElevenLabs voice ID".to_owned());
    }
    let base_url = env::var("CADIS_ELEVENLABS_BASE_URL")
        .or_else(|_| env::var("ELEVENLABS_BASE_URL"))
        .unwrap_or_else(|_| "https://api.elevenlabs.io/v1".to_owned());
    let model_id = env::var("CADIS_ELEVENLABS_MODEL")
        .or_else(|_| env::var("ELEVENLABS_MODEL"))
        .unwrap_or_else(|_| "eleven_multilingual_v2".to_owned());
    let output_format = env::var("CADIS_ELEVENLABS_OUTPUT_FORMAT")
        .or_else(|_| env::var("ELEVENLABS_OUTPUT_FORMAT"))
        .unwrap_or_else(|_| "mp3_44100_128".to_owned());
    let url = format!(
        "{}/text-to-speech/{voice_id}?output_format={output_format}",
        base_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "text": text,
        "model_id": model_id,
    })
    .to_string();
    let curl_config = elevenlabs_curl_config(&api_key, &body);
    let mut child = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--request",
            "POST",
            &url,
            "--header",
            "Content-Type: application/json",
            "--config",
            "-",
            "--output",
            &out_path.to_string_lossy(),
            "--write-out",
            "%{http_code}",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ElevenLabs TTS process failed: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(curl_config.as_bytes())
            .map_err(|error| format!("failed to configure ElevenLabs TTS request: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("ElevenLabs TTS process failed: {error}"))?;
    let http_status = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || !http_status.starts_with('2') {
        let stderr = String::from_utf8_lossy(&output.stderr).replace(&api_key, "[REDACTED]");
        return Err(format!(
            "ElevenLabs TTS failed (HTTP {}, curl status {}): {}",
            if http_status.is_empty() {
                "unknown"
            } else {
                &http_status
            },
            output.status,
            concise_error(&stderr)
        ));
    }
    let size = fs::metadata(out_path).map(|m| m.len()).unwrap_or(0);
    if size < 16 {
        return Err("ElevenLabs TTS returned an empty audio file".to_owned());
    }
    Ok(())
}

fn elevenlabs_curl_config(api_key: &str, request_body: &str) -> String {
    format!(
        "header = \"{}\"\ndata = \"{}\"\n",
        curl_config_quoted_value(&format!("xi-api-key: {api_key}")),
        curl_config_quoted_value(request_body)
    )
}

fn curl_config_quoted_value(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\\' => "\\\\".to_owned(),
            '"' => "\\\"".to_owned(),
            '\n' | '\r' => " ".to_owned(),
            character if character.is_control() => " ".to_owned(),
            character => character.to_string(),
        })
        .collect()
}

fn elevenlabs_api_key_from_secret_file() -> Option<String> {
    let home = env::var_os("HOME").map(PathBuf::from)?;
    let value = fs::read_to_string(home.join(".cadis/secrets/elevenlabs_api_key")).ok()?;
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn stop_active_tts(state: &Arc<TtsPlaybackState>) -> Result<(), String> {
    let pid = {
        let mut active_pid = state
            .active_pid
            .lock()
            .map_err(|_| "TTS state lock was poisoned".to_owned())?;
        active_pid.take()
    };
    if let Some(pid) = pid {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
    Ok(())
}

pub(crate) fn local_stt_transcribe_blocking(
    audio_base64: String,
    language: Option<String>,
) -> Result<Value, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|error| format!("invalid STT audio payload: {error}"))?;
    if bytes.is_empty() {
        return Err("empty STT audio".to_owned());
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("STT audio is too large".to_owned());
    }
    let path = write_temp_bytes("cadis-stt", "wav", &bytes)?;
    let started = Instant::now();
    let result = run_whisper_cli(&path, language.as_deref());
    let _ = fs::remove_file(&path);
    result.map(|text| {
        serde_json::json!(LocalSttResult {
            text,
            latency_ms: started.elapsed().as_millis()
        })
    })
}

// --- Internal helpers ---

fn synthesize_edge_tts(
    out_path: &Path,
    text: &str,
    voice_id: &str,
    rate: &str,
    pitch: &str,
    volume: &str,
) -> Result<(), String> {
    let input = serde_json::json!({ "outPath": out_path, "text": text, "voiceId": voice_id, "rate": rate, "pitch": pitch, "volume": volume }).to_string();
    let script = r#"
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const fs = await import('node:fs/promises');
const { EdgeTTS } = await import('edge-tts-universal');
const tts = new EdgeTTS(input.text, input.voiceId, { rate: input.rate, pitch: input.pitch, volume: input.volume });
const result = await tts.synthesize();
const audio = Buffer.from(await result.audio.arrayBuffer());
await fs.writeFile(input.outPath, audio);
"#;
    let project_root = project_root()?;
    let mut last_error = String::new();
    for node in node_candidates() {
        let mut child = match Command::new(&node)
            .arg("--input-type=module")
            .arg("-e")
            .arg(script)
            .current_dir(&project_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                last_error = format!("{}: {error}", node.display());
                continue;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(input.as_bytes())
                .map_err(|error| format!("failed to send TTS request to node: {error}"))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("edge tts process failed: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        last_error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if last_error.is_empty() {
            last_error = format!("node exited with status {}", output.status);
        }
    }
    Err(format!("edge tts failed ({last_error})"))
}

fn play_audio_file(state: &Arc<TtsPlaybackState>, path: &Path) -> Result<(), String> {
    let player = audio_player_command(path)?;
    let mut child = Command::new(&player.program)
        .args(&player.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start audio player '{}': {error}", player.program))?;
    let pid = child.id();
    {
        let mut active_pid = state
            .active_pid
            .lock()
            .map_err(|_| "TTS state lock was poisoned".to_owned())?;
        *active_pid = Some(pid);
    }
    let status = child
        .wait()
        .map_err(|error| format!("audio player failed: {error}"))?;
    let was_cancelled = {
        let mut active_pid = state
            .active_pid
            .lock()
            .map_err(|_| "TTS state lock was poisoned".to_owned())?;
        if *active_pid == Some(pid) {
            *active_pid = None;
            false
        } else {
            true
        }
    };
    if status.success() || was_cancelled {
        Ok(())
    } else {
        Err(format!("audio player exited with status {status}"))
    }
}

fn run_whisper_cli(path: &Path, language: Option<&str>) -> Result<String, String> {
    let model = whisper_model_path()?;
    let language = whisper_language(language, &model);
    let library_path = whisper_library_path_env();
    let mut last_error = String::new();
    for binary in whisper_cli_candidates() {
        let mut command = Command::new(&binary);
        command
            .arg("-m")
            .arg(&model)
            .arg("-f")
            .arg(path)
            .arg("-l")
            .arg(&language)
            .arg("-nt")
            .arg("-np")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(library_path) = &library_path {
            command.env("LD_LIBRARY_PATH", library_path);
        }
        let output = match command.output() {
            Ok(output) => output,
            Err(error) => {
                last_error = format!("{}: {error}", binary.display());
                continue;
            }
        };
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        last_error = if stderr.is_empty() {
            format!("{} exited with status {}", binary.display(), output.status)
        } else {
            format!("{}: {stderr}", binary.display())
        };
    }
    Err(format!(
        "whisper-cli not available ({})",
        explain_whisper_error(&last_error)
    ))
}

fn whisper_model_path() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    push_env_path(&mut candidates, "CADIS_WHISPER_MODEL");
    push_env_path(&mut candidates, "WHISPER_MODEL");
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/share/cadis/whisper-models/ggml-base.bin"));
        candidates.push(home.join(".local/share/cadis/whisper-models/ggml-base.en.bin"));
    }
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    let searched = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!("whisper model not found; set CADIS_WHISPER_MODEL or install ggml-base.bin under ~/.local/share/cadis/whisper-models ({searched})"))
}

fn whisper_language(language: Option<&str>, model: &Path) -> String {
    let requested = env::var("CADIS_WHISPER_LANGUAGE")
        .ok()
        .or_else(|| env::var("WHISPER_LANGUAGE").ok())
        .or_else(|| language.map(str::to_owned))
        .and_then(|v| normalize_whisper_language(&v))
        .unwrap_or_else(|| "auto".to_owned());
    if is_english_only_whisper_model(model) && requested != "en" {
        "en".to_owned()
    } else {
        requested
    }
}

fn normalize_whisper_language(language: &str) -> Option<String> {
    let normalized = language.trim().to_lowercase().replace('_', "-");
    if normalized.is_empty() {
        return None;
    }
    if normalized == "auto" {
        return Some(normalized);
    }
    let base = normalized.split('-').next().unwrap_or(&normalized);
    if base == "in" {
        return Some("id".to_owned());
    }
    if base.len() >= 2 {
        return Some(base.to_owned());
    }
    None
}

fn is_english_only_whisper_model(model: &Path) -> bool {
    model
        .file_name()
        .and_then(|f| f.to_str())
        .map(|f| f.contains(".en."))
        .unwrap_or(false)
}

fn whisper_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    push_env_path(&mut candidates, "CADIS_WHISPER_CLI");
    push_env_path(&mut candidates, "WHISPER_CLI");
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/bin/whisper-cli"));
    }
    candidates.push(PathBuf::from("whisper-cli"));
    candidates
}

fn whisper_library_path_env() -> Option<String> {
    let mut paths = Vec::new();
    if let Ok(existing) = env::var("LD_LIBRARY_PATH") {
        if !existing.trim().is_empty() {
            paths.push(existing);
        }
    }
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        for path in [
            home.join(".local/lib"),
            home.join(".local/lib64"),
            home.join(".local/share/cadis/lib"),
            home.join(".local/share/whisper.cpp"),
        ] {
            if path.exists() {
                paths.push(path.display().to_string());
            }
        }
    }
    if paths.is_empty() {
        None
    } else {
        Some(paths.join(":"))
    }
}

fn explain_whisper_error(error: &str) -> String {
    if error.contains("libwhisper.so") {
        format!("{error}; libwhisper.so.1 is missing from the dynamic linker path. Reinstall whisper.cpp or launch CADIS HUD with LD_LIBRARY_PATH pointing to the directory that contains libwhisper.so.1")
    } else {
        error.to_owned()
    }
}

fn whisper_binary_check() -> VoiceDoctorCheck {
    for candidate in whisper_cli_candidates() {
        if let Some(path) = resolve_candidate_path(&candidate) {
            return doctor_check(
                "whisper binary",
                "pass",
                format!("found {}", path.display()),
            );
        }
    }
    let searched = whisper_cli_candidates()
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    doctor_check("whisper binary", "fail", format!("not found ({searched})"))
}

fn whisper_model_check() -> VoiceDoctorCheck {
    match whisper_model_path() {
        Ok(path) => doctor_check("whisper model", "pass", format!("found {}", path.display())),
        Err(error) => doctor_check("whisper model", "fail", error),
    }
}

fn node_helper_check() -> VoiceDoctorCheck {
    let project_root = match project_root() {
        Ok(path) => path,
        Err(error) => return doctor_check("node helper", "fail", error),
    };
    let script = "await import('edge-tts-universal')";
    let mut found_node = None;
    let mut last_error = String::new();
    for node in node_candidates() {
        let Some(path) = resolve_candidate_path(&node) else {
            continue;
        };
        found_node = Some(path.clone());
        match Command::new(&path)
            .arg("--input-type=module")
            .arg("-e")
            .arg(script)
            .current_dir(&project_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(output) if output.status.success() => {
                return doctor_check("node helper", "pass", format!("node {}", path.display()))
            }
            Ok(output) => {
                last_error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                if last_error.is_empty() {
                    last_error = format!("node exited with status {}", output.status);
                }
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
    }
    if let Some(path) = found_node {
        doctor_check(
            "node helper",
            "fail",
            format!(
                "{} cannot load edge-tts-universal ({})",
                path.display(),
                concise_error(&last_error)
            ),
        )
    } else {
        doctor_check("node helper", "fail", "node not found".to_owned())
    }
}

fn audio_player_check() -> VoiceDoctorCheck {
    let mut players = Vec::new();
    for program in ["ffplay", "mpv"] {
        if let Some(path) = resolve_program_path(program) {
            players.push(format!("{program}: {}", path.display()));
        }
    }
    if players.is_empty() {
        doctor_check(
            "audio player",
            "fail",
            "install ffmpeg/ffplay or mpv".to_owned(),
        )
    } else {
        doctor_check("audio player", "pass", players.join("; "))
    }
}

struct AudioPlayerCommand {
    program: String,
    args: Vec<String>,
}

fn audio_player_command(path: &Path) -> Result<AudioPlayerCommand, String> {
    let path = path.display().to_string();
    if command_exists("ffplay") {
        return Ok(AudioPlayerCommand {
            program: "ffplay".to_owned(),
            args: vec![
                "-nodisp".to_owned(),
                "-autoexit".to_owned(),
                "-loglevel".to_owned(),
                "error".to_owned(),
                path,
            ],
        });
    }
    if command_exists("mpv") {
        return Ok(AudioPlayerCommand {
            program: "mpv".to_owned(),
            args: vec![
                "--no-terminal".to_owned(),
                "--really-quiet".to_owned(),
                path,
            ],
        });
    }
    Err("no supported audio player found; install ffmpeg/ffplay or mpv".to_owned())
}

fn command_exists(program: &str) -> bool {
    resolve_program_path(program).is_some()
}

fn resolve_candidate_path(candidate: &Path) -> Option<PathBuf> {
    if candidate.components().count() > 1 {
        if candidate.exists() {
            return Some(candidate.to_path_buf());
        }
        return None;
    }
    candidate.to_str().and_then(resolve_program_path)
}

fn resolve_program_path(program: &str) -> Option<PathBuf> {
    let output = Command::new("sh")
        .arg("-c")
        .arg("command -v \"$1\"")
        .arg("sh")
        .arg(program)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn project_root() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "cannot resolve CADIS HUD project root".to_owned())
}

fn node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    push_env_path(&mut candidates, "CADIS_HUD_NODE");
    push_env_path(&mut candidates, "NODE");
    if let Ok(nvm_bin) = env::var("NVM_BIN") {
        if !nvm_bin.trim().is_empty() {
            candidates.push(PathBuf::from(nvm_bin).join("node"));
        }
    }
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".nvm/versions/node/v24.15.0/bin/node"));
    }
    candidates.push(PathBuf::from("node"));
    candidates
}

fn push_env_path(candidates: &mut Vec<PathBuf>, key: &str) {
    if let Ok(value) = env::var(key) {
        let value = value.trim();
        if !value.is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
}

fn temp_audio_path(prefix: &str, ext: &str) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    Ok(env::temp_dir().join(format!("{prefix}-{}-{stamp}.{ext}", std::process::id())))
}

fn write_temp_bytes(prefix: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = temp_audio_path(prefix, ext)?;
    fs::write(&path, bytes).map_err(|error| format!("cannot write temporary audio: {error}"))?;
    Ok(path)
}

fn doctor_check(name: &str, status: &str, detail: String) -> VoiceDoctorCheck {
    VoiceDoctorCheck {
        name: name.to_owned(),
        status: status.to_owned(),
        detail,
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

fn concise_error(error: &str) -> String {
    let compact = error.lines().next().unwrap_or(error).trim();
    if compact.chars().count() > 180 {
        let prefix = compact.chars().take(177).collect::<String>();
        format!("{prefix}...")
    } else if compact.is_empty() {
        "unknown error".to_owned()
    } else {
        compact.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::effective_tts_provider;

    #[test]
    fn explicit_elevenlabs_provider_routes_any_voice_id_to_elevenlabs() {
        assert_eq!(effective_tts_provider(Some("elevenlabs")), "elevenlabs");
    }

    #[test]
    fn edge_voice_uses_edge_when_provider_is_missing() {
        assert_eq!(effective_tts_provider(None), "edge");
    }

    #[test]
    fn edge_provider_does_not_infer_from_custom_voice_id() {
        assert_eq!(effective_tts_provider(Some("edge")), "edge");
    }
}
