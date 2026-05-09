/**
 * Voice configuration modal — pick voice, tune rate/pitch/volume, test playback.
 * Persists through the CADIS daemon preference protocol when connected.
 */
import { useState } from "react";
import { useHud } from "../hudState.js";
import {
  VOICE_PROVIDER_OPTIONS,
  VOICES,
  defaultVoiceIdForProvider,
  voiceOptionForId,
  type VoiceProvider,
} from "../../lib/voice/voices.js";
import { stopSpeaking, testAudio } from "../../lib/voice/tts.js";
import { persistVoicePreferences } from "../cadisActions.js";

const CUSTOM_VOICE_VALUE = "__custom_voice_id__";

export function VoiceConfig() {
  const open = useHud((s) => s.voiceConfigOpen);
  const close = useHud((s) => s.setVoiceConfigOpen);
  const prefs = useHud((s) => s.voicePrefs);
  const update = useHud((s) => s.updateVoicePrefs);
  const setVoiceState = useHud((s) => s.setVoiceState);
  const mainName = useHud((s) => s.agents.find((a) => a.spec.id === "main")?.spec.name ?? "CADIS");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEngine, setLastEngine] = useState<string | null>(null);
  const updateVoice = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    update(patch);
    persistVoicePreferences(next);
  };
  const updateVoiceId = (voiceId: string) => {
    const selected = voiceOptionForId(voiceId);
    updateVoice({
      voiceId,
      ...(selected ? { provider: selected.provider } : {}),
    });
  };
  const updateProvider = (provider: VoiceProvider) => {
    const selected = voiceOptionForId(prefs.voiceId);
    updateVoice({
      provider,
      voiceId:
        selected && selected.provider !== provider
          ? defaultVoiceIdForProvider(provider)
          : prefs.voiceId || defaultVoiceIdForProvider(provider),
    });
  };

  if (!open) return null;

  const currentVoice = voiceOptionForId(prefs.voiceId);
  const voiceSelectValue = currentVoice?.provider === prefs.provider ? currentVoice.id : CUSTOM_VOICE_VALUE;
  const providerVoices = VOICES.filter((voice) => voice.provider === prefs.provider);

  const test = async () => {
    setError(null);
    setLastEngine(null);
    setTesting(true);
    setVoiceState("speaking");
    try {
      const engine = await testAudio(prefs, {
        onEnd: () => {
          setTesting(false);
          setVoiceState("idle");
        },
      }, mainName);
      setLastEngine(engine);
    } catch (e) {
      setTesting(false);
      setVoiceState("idle");
      setError(e instanceof Error ? e.message : "test failed");
    }
  };

  const stop = async () => {
    await stopSpeaking();
    setTesting(false);
    setVoiceState("idle");
  };

  return (
    <div className="modal-backdrop" onClick={() => close(false)}>
      <div className="voice-config" onClick={(e) => e.stopPropagation()}>
        <header className="voice-config__head">
          <span className="voice-config__brand">VOICE · CONFIG</span>
          <button
            type="button"
            className="voice-config__close"
            onClick={() => close(false)}
            aria-label="close"
          >
            ×
          </button>
        </header>

        <section className="voice-config__row">
          <label className="voice-config__label" htmlFor="voice-provider-input">Provider</label>
          <select
            id="voice-provider-input"
            className="voice-config__select"
            value={prefs.provider}
            onChange={(e) => updateProvider(e.target.value as VoiceProvider)}
          >
            {VOICE_PROVIDER_OPTIONS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </section>

        <section className="voice-config__row">
          <label className="voice-config__label" htmlFor="voice-preset-input">Voice</label>
          <select
            id="voice-preset-input"
            className="voice-config__select"
            value={voiceSelectValue}
            onChange={(e) => {
              if (e.target.value !== CUSTOM_VOICE_VALUE) updateVoiceId(e.target.value);
            }}
          >
            <option value={CUSTOM_VOICE_VALUE}>Custom voice ID</option>
            {providerVoices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </section>

        <section className="voice-config__row">
          <label className="voice-config__label" htmlFor="voice-id-input">Voice ID</label>
          <input
            id="voice-id-input"
            className="voice-config__input"
            value={prefs.voiceId}
            placeholder={defaultVoiceIdForProvider(prefs.provider)}
            spellCheck={false}
            onChange={(e) => updateVoiceId(e.target.value.trim())}
          />
        </section>

        <SliderRow
          label="Rate"
          unit="%"
          min={-50}
          max={50}
          step={5}
          value={prefs.rate}
          onChange={(v) => updateVoice({ rate: v })}
          hint="Speed of speech"
        />
        <SliderRow
          label="Pitch"
          unit="Hz"
          min={-50}
          max={50}
          step={5}
          value={prefs.pitch}
          onChange={(v) => updateVoice({ pitch: v })}
          hint="Higher / lower tone"
        />
        <SliderRow
          label="Volume"
          unit="%"
          min={-50}
          max={50}
          step={5}
          value={prefs.volume}
          onChange={(v) => updateVoice({ volume: v })}
          hint="Output gain"
        />

        <section className="voice-config__row">
          <label className="voice-config__label">
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => updateVoice({ enabled: e.target.checked })}
            />
            Enable voice output
          </label>
        </section>

        <section className="voice-config__row">
          <label className="voice-config__label">
            <input
              type="checkbox"
              disabled={!prefs.enabled}
              checked={prefs.autoSpeak}
              onChange={(e) => updateVoice({ autoSpeak: e.target.checked })}
            />
            Auto-speak CADIS chat replies
          </label>
        </section>
        <section className="voice-config__row">
          <label className="voice-config__label">
            Engine
            <span className="voice-config__value">
              {prefs.provider === "elevenlabs" ? "elevenlabs" : "edge-tts-universal"}
            </span>
          </label>
        </section>

        {error && <div className="voice-config__error">{error}</div>}
        {lastEngine && (
          <div className="voice-config__hint" style={{ color: "var(--ok)" }}>
            played via <code>{lastEngine}</code>
          </div>
        )}

        <footer className="voice-config__foot">
          <button
            type="button"
            className="voice-config__btn"
            onClick={testing ? stop : test}
          >
            {testing ? "STOP" : "TEST"}
          </button>
          <button
            type="button"
            className="voice-config__btn voice-config__btn--primary"
            onClick={() => close(false)}
          >
            DONE
          </button>
        </footer>
      </div>
    </div>
  );
}

function SliderRow(props: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  const { label, unit, min, max, step, value, onChange, hint } = props;
  const sign = value >= 0 ? "+" : "";
  return (
    <section className="voice-config__row">
      <label className="voice-config__label">
        {label}
        <span className="voice-config__value">{sign}{value}{unit}</span>
      </label>
      <input
        type="range"
        className="voice-config__slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div className="voice-config__hint">{hint}</div>}
    </section>
  );
}
