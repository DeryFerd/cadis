import { useEffect, type MutableRefObject } from "react";
import type { ChatMessage } from "../hudState.js";
import type { SttDebugSnapshot } from "../../lib/voice/stt.js";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ChatLine({ m }: { m: ChatMessage }) {
  const whoLabel =
    m.who === "user"
      ? "you ›"
      : m.who === "cadis"
        ? `${(m.agentName ?? "cadis").toLowerCase()} ›`
        : "sys ›";
  return (
    <div className={`chat-line chat-line--${m.who}`}>
      <span className="chat-line__ts">{fmtTime(m.ts)}</span>
      <span className="chat-line__who">{whoLabel}</span>
      <span className="chat-line__text">{m.text}</span>
    </div>
  );
}

export interface MessageListProps {
  messages: ChatMessage[];
  mainName: string;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  gateway: string;
  listening: boolean;
  micDebugCapture: boolean;
  audioLevel: number;
  audioSamples: number[];
  isAwaitingReply: boolean;
  partial: string;
  showMicDebug: boolean;
  micDebug: SttDebugSnapshot;
}

const WAVE_BARS = Array.from({ length: 48 }, (_, i) => i);

function WaveformLine({ level, samples }: { level: number; samples: number[] }) {
  const normalized = Math.max(0, Math.min(1, level));
  const gain = Math.pow(normalized, 0.72);
  const values = samples.length === WAVE_BARS.length ? samples : WAVE_BARS.map(() => gain);
  return (
    <span
      className="chat-wave"
      data-signal={normalized > 0.08 ? "active" : "quiet"}
      aria-hidden="true"
    >
      {WAVE_BARS.map((i) => (
        <span
          key={i}
          className="chat-wave__bar"
          style={{
            height: `${3 + Math.max(gain * 0.35, values[i] ?? 0) * 20}px`,
            opacity: `${0.32 + Math.max(gain, values[i] ?? 0) * 0.62}`,
          }}
        />
      ))}
    </span>
  );
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function DebugCell({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <span className={`chat-mic-debug__cell${wide ? " chat-mic-debug__cell--wide" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function MicDebugPanel({
  debug,
  level,
  listening,
  debugCapture,
}: {
  debug: SttDebugSnapshot;
  level: number;
  listening: boolean;
  debugCapture: boolean;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, level || debug.level)) * 100);
  const selectedDevice = debug.selectedDeviceLabel || debug.trackLabel || "-";
  const streamState = debug.streamActive ? "active" : debug.streamId ? "inactive" : "-";
  return (
    <div className="chat-mic-debug">
      <div className="chat-mic-debug__head">
        <span>{debugCapture ? "mic debug capture" : "mic debug"}</span>
        <span className={`chat-mic-debug__pill chat-mic-debug__pill--${debug.stage}`}>
          {listening ? debug.stage : "standby"}
        </span>
      </div>
      <div className="chat-mic-debug__meter" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="chat-mic-debug__grid">
        <DebugCell label="level" value={`${pct}%`} />
        <DebugCell label="rms" value={debug.rms.toFixed(5)} />
        <DebugCell label="peak" value={debug.peak.toFixed(5)} />
        <DebugCell label="voice" value={debug.voiceDetected ? "yes" : "no"} />
        <DebugCell label="permission" value={debug.permissionState || "-"} />
        <DebugCell label="inputs" value={debug.deviceCount ? `${debug.deviceCount}` : "-"} />
        <DebugCell label="elapsed" value={formatMs(debug.elapsedMs)} />
        <DebugCell label="silent" value={formatMs(debug.silentMs)} />
        <DebugCell label="chunks" value={`${debug.chunks}`} />
        <DebugCell label="bytes" value={formatBytes(debug.bytes)} />
        <DebugCell label="capture" value={debug.captureSource || "-"} />
        <DebugCell label="pcm" value={debug.pcmFrames ? `${debug.pcmFrames} frames / ${formatBytes(debug.pcmBytes)}` : "-"} />
        <DebugCell label="stop" value={debug.stopReason || "-"} />
        <DebugCell label="selected" value={selectedDevice} wide />
        <DebugCell label="devices" value={debug.deviceLabels || "-"} wide />
        <DebugCell label="stream" value={streamState} />
        <DebugCell
          label="track state"
          value={`${debug.trackReadyState || "-"} / ${debug.trackMuted ? "muted" : "unmuted"}`}
        />
        <DebugCell
          label="track fmt"
          value={[
            debug.trackChannelCount ? `${debug.trackChannelCount}ch` : "",
            debug.trackSampleRate ? `${debug.trackSampleRate}Hz` : "",
            debug.trackDeviceId ? `id ${debug.trackDeviceId}` : "",
          ].filter(Boolean).join(" ") || "-"}
        />
        <DebugCell label="recorder" value={debug.recorderState || "-"} />
        <DebugCell label="mime" value={debug.mimeType || "-"} wide />
        <DebugCell
          label="audio ctx"
          value={`${debug.audioContextState || "-"} ${debug.sampleRate ? `${debug.sampleRate}Hz` : ""}`}
        />
        <DebugCell label="analyser" value={debug.analyserFrames ? `${debug.analyserFrames} frames` : "-"} />
        <DebugCell label="silence" value={debug.silenceReason || "-"} wide />
        <DebugCell label="lang" value={debug.language || "-"} />
        <DebugCell label="message" value={debug.message || "-"} wide />
        {debug.transcript && <DebugCell label="transcript" value={debug.transcript} wide />}
        {debug.error && <DebugCell label="error" value={debug.error} wide />}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  mainName,
  scrollRef,
  gateway,
  listening,
  micDebugCapture,
  audioLevel,
  audioSamples,
  isAwaitingReply,
  partial,
  showMicDebug,
  micDebug,
}: MessageListProps) {
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, scrollRef]);

  return (
    <div ref={scrollRef} className="chat-panel__log">
      {messages.length === 0 && gateway === "connected" && (
        <div className="chat-panel__placeholder">{mainName.toLowerCase()} › ready. linked to CADIS.</div>
      )}
      {messages.length === 0 && gateway !== "connected" && (
        <div className="chat-panel__placeholder">
          cadis › {gateway}. waiting for CADIS daemon.
        </div>
      )}
      {messages.map((m) => <ChatLine key={m.id} m={m} />)}
      {listening && !partial && (
        <div className="chat-line chat-line--user chat-line--listening">
          <span className="chat-line__ts">...</span>
          <span className="chat-line__who">{micDebugCapture ? "mic ›" : "you ›"}</span>
          <WaveformLine level={audioLevel} samples={audioSamples} />
        </div>
      )}
      {isAwaitingReply && (
        <div className="chat-line chat-line--cadis chat-line--thinking">
          <span className="chat-line__ts">...</span>
          <span className="chat-line__who">{mainName.toLowerCase()} ›</span>
          <span className="chat-line__text">
            consulting CADIS<span className="chat-line__cursor">▌</span>
          </span>
        </div>
      )}
      {partial && (
        <div className="chat-line chat-line--user chat-line--partial">
          <span className="chat-line__ts">...</span>
          <span className="chat-line__who">you ›</span>
          <span className="chat-line__text">{partial}</span>
        </div>
      )}
      {showMicDebug && (
        <MicDebugPanel
          debug={micDebug}
          level={audioLevel}
          listening={listening}
          debugCapture={micDebugCapture}
        />
      )}
    </div>
  );
}
