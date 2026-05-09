/**
 * Curated voice catalog. Edge TTS exposes hundreds; we surface the ones most
 * useful for an Indonesian/English bilingual user.
 */
export type VoiceOption = {
  id: string;
  label: string;
  locale: "id-ID" | "en-US" | "en-GB" | "ms-MY";
  gender: "Female" | "Male" | "Neutral";
  provider: VoiceProvider;
};

export type VoiceProvider = "edge" | "elevenlabs";

export const EDGE_DEFAULT_VOICE_ID = "id-ID-GadisNeural";
export const ELEVENLABS_DEFAULT_VOICE_ID = "kSzQ9oZF2iytkgNNztpH";

export const VOICE_PROVIDER_OPTIONS: { id: VoiceProvider; label: string }[] = [
  { id: "edge", label: "Edge TTS" },
  { id: "elevenlabs", label: "ElevenLabs" },
];

export const VOICES: VoiceOption[] = [
  // ElevenLabs
  { id: ELEVENLABS_DEFAULT_VOICE_ID, label: "ElevenLabs Default", locale: "id-ID", gender: "Neutral", provider: "elevenlabs" },
  // Indonesian
  { id: "id-ID-ArdiNeural",   label: "Ardi (Indonesian, Male)",   locale: "id-ID", gender: "Male", provider: "edge" },
  { id: "id-ID-GadisNeural",  label: "Gadis (Indonesian, Female)", locale: "id-ID", gender: "Female", provider: "edge" },
  // Malay (close fallback)
  { id: "ms-MY-OsmanNeural",  label: "Osman (Malay, Male)",        locale: "ms-MY", gender: "Male", provider: "edge" },
  { id: "ms-MY-YasminNeural", label: "Yasmin (Malay, Female)",     locale: "ms-MY", gender: "Female", provider: "edge" },
  // English (US)
  { id: "en-US-AvaNeural",    label: "Ava (US, Female)",           locale: "en-US", gender: "Female", provider: "edge" },
  { id: "en-US-AndrewNeural", label: "Andrew (US, Male)",          locale: "en-US", gender: "Male", provider: "edge" },
  { id: "en-US-EmmaNeural",   label: "Emma (US, Female)",          locale: "en-US", gender: "Female", provider: "edge" },
  { id: "en-US-BrianNeural",  label: "Brian (US, Male)",           locale: "en-US", gender: "Male", provider: "edge" },
  // English (GB)
  { id: "en-GB-SoniaNeural",  label: "Sonia (GB, Female)",         locale: "en-GB", gender: "Female", provider: "edge" },
  { id: "en-GB-RyanNeural",   label: "Ryan (GB, Male)",            locale: "en-GB", gender: "Male", provider: "edge" },
];

export type VoicePrefs = {
  /** Master switch for daemon-owned voice output. */
  enabled: boolean;
  provider: VoiceProvider;
  voiceId: string;
  /** -100 .. +100 (% adjustment) */
  rate: number;
  /** -50 .. +50 (Hz adjustment) */
  pitch: number;
  /** -100 .. +100 (% adjustment) */
  volume: number;
  /** Auto-speak CADIS chat replies. */
  autoSpeak: boolean;
  /** When true, attempt Edge TTS (cloud) before falling back to local synth. */
  useCloudTts: boolean;
};

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  enabled: false,
  provider: "edge",
  voiceId: EDGE_DEFAULT_VOICE_ID,
  rate: 0,
  pitch: 0,
  volume: 0,
  autoSpeak: false,
  /** Cloud Edge TTS is the default — local webkit2gtk often lacks speechSynthesis. */
  useCloudTts: true,
};

export function fmtPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n}%`;
}

export function fmtHz(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n}Hz`;
}

export function voiceOptionForId(voiceId: string): VoiceOption | undefined {
  return VOICES.find((voice) => voice.id === voiceId);
}

export function defaultVoiceIdForProvider(provider: VoiceProvider): string {
  return provider === "elevenlabs" ? ELEVENLABS_DEFAULT_VOICE_ID : EDGE_DEFAULT_VOICE_ID;
}
