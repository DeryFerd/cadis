import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_PREFS } from "./voices.js";
import { speak, testAudio } from "./tts.js";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("TTS provider selection", () => {
  it("routes arbitrary voice IDs through the explicit ElevenLabs provider", async () => {
    await speak("Halo.", {
      ...DEFAULT_VOICE_PREFS,
      provider: "elevenlabs",
      voiceId: "userVoice123",
    });

    expect(invokeMock).toHaveBeenCalledWith("edge_tts_speak", expect.objectContaining({
      provider: "elevenlabs",
      voiceId: "userVoice123",
    }));
  });

  it("keeps Edge routing when the provider is Edge even with an unknown voice ID", async () => {
    await speak("Halo.", {
      ...DEFAULT_VOICE_PREFS,
      provider: "edge",
      voiceId: "userVoice123",
    });

    expect(invokeMock).toHaveBeenCalledWith("edge_tts_speak", expect.objectContaining({
      provider: "edge",
      voiceId: "userVoice123",
    }));
  });

  it("reports ElevenLabs for audio test when ElevenLabs is selected", async () => {
    const engine = await testAudio({
      ...DEFAULT_VOICE_PREFS,
      provider: "elevenlabs",
      voiceId: "userVoice123",
    });

    expect(engine).toBe("elevenlabs");
    expect(invokeMock).toHaveBeenCalledWith("edge_tts_speak", expect.objectContaining({
      provider: "elevenlabs",
    }));
  });
});
