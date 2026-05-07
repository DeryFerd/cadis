import { useState, useRef } from "react";
import type { VoicePrefs } from "../../lib/voice/voices.js";
import { VOICES } from "../../lib/voice/voices.js";
import {
  available as sttAvailable,
  startListening,
  type SttDebugSnapshot,
  type SttSession,
} from "../../lib/voice/stt.js";
import { stopSpeaking } from "../../lib/voice/tts.js";

export function emptyMicDebug(language = "auto"): SttDebugSnapshot {
  return {
    stage: "idle",
    message: "idle",
    language,
    elapsedMs: 0,
    level: 0,
    rms: 0,
    peak: 0,
    samples: [],
    voiceDetected: false,
    silentMs: 0,
    chunks: 0,
    bytes: 0,
    pcmFrames: 0,
    pcmBytes: 0,
    captureSource: "",
    permissionState: "",
    deviceCount: 0,
    deviceLabels: "",
    selectedDeviceId: "",
    selectedDeviceLabel: "",
    streamActive: false,
    streamId: "",
    trackLabel: "",
    trackEnabled: false,
    trackMuted: false,
    trackReadyState: "",
    trackDeviceId: "",
    trackGroupId: "",
    trackSampleRate: 0,
    trackChannelCount: 0,
    recorderState: "",
    mimeType: "",
    audioContextState: "",
    sampleRate: 0,
    analyserFftSize: 0,
    analyserFrames: 0,
    silenceReason: "",
    stopReason: "",
    transcript: "",
    error: "",
  };
}

export interface VoiceControlsState {
  listening: boolean;
  partial: string;
  audioLevel: number;
  audioSamples: number[];
  micDebugOpen: boolean;
  micDebugCapture: boolean;
  micDebug: SttDebugSnapshot;
}

export interface UseVoiceControlsOptions {
  voicePrefs: VoicePrefs;
  voiceState: "idle" | "listening" | "thinking" | "speaking";
  setVoiceState: (state: "idle" | "listening" | "thinking" | "speaking") => void;
  pushMessage: (msg: { id: string; who: "user" | "cadis" | "system"; text: string; ts: number }) => void;
  onTranscript: (text: string) => void;
}

export function useVoiceControls({
  voicePrefs,
  setVoiceState,
  pushMessage,
  onTranscript,
}: UseVoiceControlsOptions) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioSamples, setAudioSamples] = useState<number[]>([]);
  const [micDebugOpen, setMicDebugOpen] = useState(false);
  const [micDebugCapture, setMicDebugCapture] = useState(false);
  const sttLang = VOICES.find((x) => x.id === voicePrefs.voiceId)?.locale ?? "en-US";
  const [micDebug, setMicDebug] = useState<SttDebugSnapshot>(() => emptyMicDebug(sttLang));
  const sttRef = useRef<SttSession | null>(null);
  const voiceSubmittedRef = useRef(false);

  const stopMicCapture = () => {
    sttRef.current?.stop();
    sttRef.current = null;
    voiceSubmittedRef.current = false;
    setListening(false);
    setMicDebugCapture(false);
    setVoiceState("idle");
    setPartial("");
    setAudioLevel(0);
    setAudioSamples([]);
  };

  const beginMicCapture = async (debugOnly: boolean) => {
    if (listening) {
      stopMicCapture();
      return;
    }
    if (!sttAvailable()) {
      pushMessage({
        id: `m-${Date.now()}-stt`,
        who: "system",
        text: "(stt error: microphone capture is not available in this webview)",
        ts: Date.now(),
      });
      return;
    }
    await stopSpeaking();
    setVoiceState("listening");
    setListening(true);
    setMicDebugCapture(debugOnly);
    setAudioLevel(0);
    setAudioSamples([]);
    setMicDebugOpen((open) => open || debugOnly);
    setMicDebug(emptyMicDebug(sttLang));
    voiceSubmittedRef.current = false;
    sttRef.current = startListening(sttLang, {
      onDebug: setMicDebug,
      onLevel: ({ level, samples }) => {
        setAudioLevel(level);
        setAudioSamples(samples);
      },
      onPartial: setPartial,
      onFinal: (t) => {
        setPartial("");
        setAudioLevel(0);
        setAudioSamples([]);
        setListening(false);
        setMicDebugCapture(false);
        sttRef.current = null;
        voiceSubmittedRef.current = true;
        onTranscript(t);
      },
      onEmpty: ({ message, audioHeard }) => {
        setPartial("");
        setAudioLevel(0);
        setAudioSamples([]);
        setListening(false);
        setMicDebugCapture(false);
        sttRef.current = null;
        voiceSubmittedRef.current = false;
        setVoiceState("idle");
        if (audioHeard || debugOnly) setMicDebugOpen(true);
        if (!debugOnly || !audioHeard) {
          pushMessage({
            id: `m-${Date.now()}-stt-empty`,
            who: "system",
            text: debugOnly ? `(mic debug: ${message})` : `(stt status: ${message})`,
            ts: Date.now(),
          });
        }
      },
      onError: (msg) => {
        setAudioLevel(0);
        setAudioSamples([]);
        voiceSubmittedRef.current = false;
        setListening(false);
        setMicDebugCapture(false);
        sttRef.current = null;
        setVoiceState("idle");
        setMicDebugOpen(true);
        pushMessage({
          id: `m-${Date.now()}-stterr`,
          who: "system",
          text: `(stt error: ${msg})`,
          ts: Date.now(),
        });
      },
      onEnd: () => {
        setAudioLevel(0);
        setAudioSamples([]);
        setListening(false);
        setMicDebugCapture(false);
        sttRef.current = null;
        if (voiceSubmittedRef.current) {
          voiceSubmittedRef.current = false;
          return;
        }
        setVoiceState("idle");
      },
    }, { debugOnly });
  };

  const toggleMic = () => {
    void beginMicCapture(false);
  };

  const resetDebug = () => {
    setPartial("");
    setMicDebugOpen(false);
    setMicDebug(emptyMicDebug(sttLang));
  };

  const showMicDebug = listening || micDebugOpen || micDebug.stage === "error";

  return {
    listening,
    partial,
    audioLevel,
    audioSamples,
    micDebugOpen,
    micDebugCapture,
    micDebug,
    showMicDebug,
    toggleMic,
    resetDebug,
  };
}
