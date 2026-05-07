/**
 * Chat panel - real round-trip to CADIS through the Tauri command adapter.
 *
 *   user types / speaks → sendUserMessage()
 *                       → CADIS routes to the active chat agent
 *                       → assistant message arrives as message delta/completed frames
 *                       → store.pushChat fires
 *                       → if voicePrefs.autoSpeak: edge-tts speaks the text
 *
 * Mic button captures local audio and sends a WAV payload to the Tauri STT command.
 */
import { useRef, useEffect } from "react";
import { useHud } from "../hudState.js";
import { sendUserMessage } from "../cadisActions.js";
import { speak } from "../../lib/voice/tts.js";
import { MessageList } from "./MessageList.js";
import { ChatComposer } from "./ChatComposer.js";
import { useVoiceControls } from "./VoiceControls.js";

// Re-export for test compatibility
export { getActiveMentionQuery, buildMentionOptions } from "./ChatComposer.js";
export type { MentionOption } from "./ChatComposer.js";

export function ChatPanel() {
  const messages = useHud((s) => s.chat);
  const push = useHud((s) => s.pushChat);
  const clearChat = useHud((s) => s.clearChat);
  const gateway = useHud((s) => s.gateway);
  const prefs = useHud((s) => s.voicePrefs);
  const voiceState = useHud((s) => s.voiceState);
  const setVoiceState = useHud((s) => s.setVoiceState);
  const openConfig = useHud((s) => s.setConfigOpen);
  const agents = useHud((s) => s.agents);
  const agentModels = useHud((s) => s.agentModels);
  const defaultModel = useHud((s) => s.defaultModel);
  const mainName = useHud((s) => s.agents.find((a) => a.spec.id === "main")?.spec.name ?? "CADIS");
  const scroll = useRef<HTMLDivElement | null>(null);
  const lastSpokenIdRef = useRef<string | null>(null);

  const submitText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const model = agentModels.main ?? defaultModel ?? undefined;
    const ok = sendUserMessage(trimmed, model);
    if (ok) setVoiceState("thinking");
    push({
      id: `m-${Date.now()}`,
      who: "user",
      text: trimmed,
      ts: Date.now(),
    });
    if (!ok) {
      push({
        id: `m-${Date.now()}-warn`,
        who: "system",
        text: "(CADIS not connected - message could not be delivered)",
        ts: Date.now(),
      });
    }
  };

  const voice = useVoiceControls({
    voicePrefs: prefs,
    voiceState,
    setVoiceState,
    pushMessage: push,
    onTranscript: submitText,
  });

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!prefs.autoSpeak && last?.who === "cadis" && last.final !== false) {
      setVoiceState("idle");
    }
  }, [messages, prefs.autoSpeak, setVoiceState]);

  // Auto-speak CADIS final replies immediately; hold back partial streams.
  const lastTextRef = useRef<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!prefs.autoSpeak) return;
    const last = messages[messages.length - 1];
    if (!last || last.who !== "cadis") return;
    if (lastSpokenIdRef.current === last.id) return;
    if (last.final === false) {
      lastTextRef.current = last.text;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    if (last.text === lastTextRef.current && last.final !== true) return;
    lastTextRef.current = last.text;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const snapshot = last.text;
    const id = last.id;
    const delay = last.final === true ? 80 : 700;
    debounceRef.current = setTimeout(() => {
      if (snapshot !== lastTextRef.current) return;
      lastSpokenIdRef.current = id;
      setVoiceState("speaking");
      speak(snapshot, prefs, {
        onEnd: () => setVoiceState("idle"),
        onError: (err) => {
          setVoiceState("idle");
          const msg = err instanceof Error ? err.message : String(err);
          push({
            id: `m-${Date.now()}-tts`,
            who: "system",
            text: `(tts error: ${msg})`,
            ts: Date.now(),
          });
        },
      }).catch((err) => {
        setVoiceState("idle");
        const msg = err instanceof Error ? err.message : String(err);
        push({
          id: `m-${Date.now()}-tts`,
          who: "system",
          text: `(tts error: ${msg})`,
          ts: Date.now(),
        });
      });
    }, delay);
  }, [messages, prefs, setVoiceState, push]);

  const clearHistory = () => {
    clearChat();
    voice.resetDebug();
  };

  const modelLabel = compactModelLabel(agentModels.main ?? defaultModel ?? "openai/codex");
  const statusLabel = voiceStatusLabel(voiceState, gateway);
  const isAwaitingReply = voiceState === "thinking" && messages[messages.length - 1]?.who === "user";
  const canClearHistory = messages.length > 0 || voice.partial || voice.showMicDebug;

  return (
    <section className="chat-panel" aria-label="CADIS chat">
      <header className="chat-panel__head">
        <div className="chat-panel__head-main">
          <span className="chat-panel__brand">▸ VOICE I/O</span>
          <span className="chat-panel__sep">·</span>
          <span className="chat-panel__meta">{mainName} · whisper.cpp · edge-tts</span>
          <span className="chat-panel__sep">·</span>
          <span className="chat-panel__meta">{modelLabel}</span>
        </div>
        <span className={`chat-panel__state chat-panel__state--${voiceState}`}>
          {statusLabel}
        </span>
      </header>
      <MessageList
        messages={messages}
        mainName={mainName}
        scrollRef={scroll}
        gateway={gateway}
        listening={voice.listening}
        micDebugCapture={voice.micDebugCapture}
        audioLevel={voice.audioLevel}
        audioSamples={voice.audioSamples}
        isAwaitingReply={isAwaitingReply}
        partial={voice.partial}
        showMicDebug={voice.showMicDebug}
        micDebug={voice.micDebug}
      />
      <div className="chat-panel__tools" aria-label="chat tools">
        {messages.length > 0 && (
          <div className="chat-panel__chips" aria-label="quick actions">
            {(["yes", "no", "cancel", "expand"] as const).map((label) => (
              <button
                key={label}
                type="button"
                className="chat-panel__chip"
                onClick={() => submitText(label)}
                disabled={gateway !== "connected"}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="chat-panel__tool"
          onClick={clearHistory}
          disabled={!canClearHistory}
          title="Clear chat history"
        >
          CLEAR CHAT
        </button>
      </div>
      <ChatComposer
        onSend={submitText}
        disabled={gateway !== "connected"}
        agents={agents}
        listening={voice.listening}
        onToggleMic={voice.toggleMic}
        onOpenVoiceSettings={() => openConfig(true, "voice")}
        onOpenModelSettings={() => openConfig(true, "models")}
        modelLabel={modelLabel}
        mainName={mainName}
      />
    </section>
  );
}

function voiceStatusLabel(
  state: "idle" | "listening" | "thinking" | "speaking",
  gateway: string,
): string {
  if (gateway !== "connected") return `○ ${gateway.toUpperCase()}`;
  if (state === "listening") return "● LISTENING";
  if (state === "speaking") return "● SPEAKING";
  if (state === "thinking") return "◌ THINKING";
  return "○ IDLE";
}

function compactModelLabel(model: string): string {
  const clean = model.replace(/^openai-codex\//, "").replace(/^openai\//, "");
  return clean.length > 22 ? `${clean.slice(0, 19)}...` : clean;
}
