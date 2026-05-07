/**
 * cadisActions — public API barrel.
 *
 * Connection management lives in cadisConnection.ts, protocol handlers in
 * cadisProtocolHandlers.ts, and normalizers in cadisNormalizers.ts.
 * This file re-exports the full public surface so existing imports are unchanged.
 */

import type { AgentSpecialistProfile } from "../lib/agent-specialists.js";
import type { VoicePrefs } from "../lib/voice/voices.js";
import type { VoiceDoctorReport } from "./hudState.js";
import {
  connect,
  disconnect,
  callCadis,
  computeBackoffMs,
  isConnected,
  scheduleReconnect,
  _resetCadisActionsForTest,
  _emitCadisSubscriptionFrameForTest,
} from "./cadisConnection.js";
import { handleCadisFrameForTest } from "./cadisProtocolHandlers.js";
import {
  parseMentionTargetAgentId,
  pushSystem,
  protocolVoiceCheckStatus,
  ensureKnownAgent,
} from "./cadisNormalizers.js";

// ── Re-exports from sub-modules ──────────────────────────────────────────────

export {
  // cadisConnection
  connect,
  disconnect,
  computeBackoffMs,
  _resetCadisActionsForTest,
  _emitCadisSubscriptionFrameForTest,
  // cadisProtocolHandlers
  handleCadisFrameForTest,
  // cadisNormalizers
  ensureKnownAgent,
};

// ── Send / persist actions (public API layer) ────────────────────────────────

export function sendUserMessage(text: string, _model?: string): boolean {
  if (!isConnected()) return false;
  const targetAgentId = parseMentionTargetAgentId(text);
  const payload: Record<string, unknown> = {
    session_id: null,
    content: text,
    content_kind: "chat",
  };
  if (targetAgentId) payload.target_agent_id = targetAgentId;
  void callCadis("message.send", payload).then((ok) => {
    if (!ok) {
      pushSystem("(CADIS request failed - message could not be delivered)");
      scheduleReconnect();
    }
  });
  return true;
}

export function sendAgentModelUpdate(agentId: string, model: string): boolean {
  if (!isConnected()) return false;
  void callCadis("agent.model.set", {
    agent_id: agentId,
    model,
  }).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function sendAgentSpecialistUpdate(
  agentId: string,
  specialist: AgentSpecialistProfile,
): boolean {
  if (!isConnected()) return false;
  void callCadis("agent.specialist.set", {
    agent_id: agentId,
    specialist_id: specialist.id,
    specialist_label: specialist.label,
    persona: specialist.persona,
  }).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function sendAgentRename(agentId: string, name: string): boolean {
  if (!isConnected()) return false;
  void callCadis("agent.rename", {
    agent_id: agentId,
    display_name: name,
  }).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function sendApprovalResponse(id: string, verdict: "approve" | "deny"): boolean {
  if (!isConnected()) return false;
  void callCadis("approval.respond", {
    approval_id: id,
    decision: verdict === "approve" ? "approved" : "denied",
    reason: "",
  }).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function sendUiPreferencesPatch(patch: Record<string, unknown>): boolean {
  if (!isConnected()) return false;
  void callCadis("ui.preferences.set", { patch }).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function persistThemePreference(theme: string): void {
  sendUiPreferencesPatch({ hud: { theme } });
}

export function persistBackgroundOpacityPreference(backgroundOpacity: number): void {
  sendUiPreferencesPatch({ hud: { background_opacity: backgroundOpacity } });
}

export function persistAvatarStylePreference(avatarStyle: string): void {
  sendUiPreferencesPatch({ hud: { avatar_style: avatarStyle } });
}

export function persistAlwaysOnTopPreference(alwaysOnTop: boolean): void {
  sendUiPreferencesPatch({ hud: { always_on_top: alwaysOnTop } });
}

export function persistVoicePreferences(prefs: VoicePrefs): void {
  sendUiPreferencesPatch({
    voice: {
      enabled: true,
      voice_id: prefs.voiceId,
      rate: prefs.rate,
      pitch: prefs.pitch,
      volume: prefs.volume,
      auto_speak: prefs.autoSpeak,
    },
  });
}

export function persistChatPreferences(prefs: { thinking: boolean; fast: boolean }): void {
  sendUiPreferencesPatch({ chat: prefs });
}

export function requestVoiceDoctor(): boolean {
  if (!isConnected()) return false;
  void callCadis("voice.doctor", { include_bridge: true }).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function sendVoicePreflight(report: VoiceDoctorReport, surface = "cadis-hud"): boolean {
  if (!isConnected()) return false;
  void callCadis("voice.preflight", {
    surface,
    summary: report.summary,
    checks: report.checks.map((check) => ({
      name: check.name,
      status: protocolVoiceCheckStatus(check.status),
      message: check.detail,
    })),
  }).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function sendWorkerApply(workerId: string, worktreePath?: string): boolean {
  if (!isConnected()) return false;
  const payload: Record<string, unknown> = { worker_id: workerId };
  if (worktreePath) payload.worktree_path = worktreePath;
  void callCadis("worker.apply", payload).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}

export function sendWorkerCleanup(workerId: string, worktreePath?: string): boolean {
  if (!isConnected()) return false;
  const payload: Record<string, unknown> = { worker_id: workerId };
  if (worktreePath) payload.worktree_path = worktreePath;
  void callCadis("worker.cleanup", payload).then((ok) => {
    if (!ok) scheduleReconnect();
  });
  return true;
}
