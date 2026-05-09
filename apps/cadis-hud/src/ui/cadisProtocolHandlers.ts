import {
  normalizeAvatarStyle,
  useHud,
  type VoiceDiagnosticCheck,
} from "./hudState.js";
import type { VoicePrefs } from "../lib/voice/voices.js";
import {
  normalizeModels,
  normalizeAgentStatus,
  normalizeAgentSessionStatus,
  normalizeWorkerStatus,
  normalizeVoiceStatus,
  normalizeVoiceCheck,
  voiceDoctorSummary,
  defaultWorkerStatus,
  defaultAgentSessionStatus,
  agentStatusFromSession,
  agentTaskVerbFromSession,
  agentSessionDetail,
  nextWorkerLogTail,
  readWorkerWorktree,
  readWorkerArtifacts,
  readAgentSpecialist,
  readSessionId,
  upsertDaemonAgent,
  agentDisplayName,
  ensureKnownAgent,
  pushSystem,
  asRecord,
  stringFrom,
  numberFrom,
  isThemeKey,
  FALLBACK_MAIN_MODEL,
} from "./cadisNormalizers.js";

type CadisEnvelope = {
  type?: unknown;
  payload?: unknown;
  session_id?: unknown;
  event_id?: unknown;
};

type CadisFrame = {
  frame?: unknown;
  payload?: unknown;
  type?: unknown;
};

/** Module-level streaming state shared with connection layer via setter. */
let streamingBySession: Map<string, { id: string; text: string }>;

export function _setStreamingBySession(map: Map<string, { id: string; text: string }>): void {
  streamingBySession = map;
}

/** Module-level lastEventId shared with connection layer via getter/setter. */
let lastEventId: string | null = null;
const processedEventIds = new Set<string>();
const processedEventOrder: string[] = [];
const MAX_PROCESSED_EVENT_IDS = 2_048;

export function _getLastEventId(): string | null {
  return lastEventId;
}

export function _setLastEventId(value: string | null): void {
  lastEventId = value;
}

export function _resetProcessedEventIds(): void {
  processedEventIds.clear();
  processedEventOrder.length = 0;
}

export function handleFrames(frames: CadisFrame[]): void {
  for (const frame of frames) handleFrame(frame);
}

export function handleCadisFrameForTest(frame: CadisFrame): void {
  handleFrame(frame);
}

export function handleFrame(frame: CadisFrame): void {
  const envelope = unwrapEnvelope(frame);
  if (!envelope || typeof envelope.type !== "string") return;
  if (typeof envelope.event_id === "string" && envelope.event_id) {
    if (processedEventIds.has(envelope.event_id)) return;
    rememberProcessedEventId(envelope.event_id);
    lastEventId = envelope.event_id;
  }
  handleMessage(envelope.type, envelope.payload, readSessionId(envelope));
}

function rememberProcessedEventId(eventId: string): void {
  processedEventIds.add(eventId);
  processedEventOrder.push(eventId);
  while (processedEventOrder.length > MAX_PROCESSED_EVENT_IDS) {
    const stale = processedEventOrder.shift();
    if (stale) processedEventIds.delete(stale);
  }
}

export function unwrapEnvelope(frame: CadisFrame): CadisEnvelope | null {
  if (frame && typeof frame === "object" && typeof frame.type === "string") {
    return frame as CadisEnvelope;
  }
  const payload = frame.payload;
  if (payload && typeof payload === "object") return payload as CadisEnvelope;
  return null;
}

export function handleMessage(type: string, payload: unknown, sessionId?: string): void {
  if (type === "request.accepted") return;
  if (type === "request.rejected") {
    handleRequestRejected(payload);
    return;
  }
  if (type === "daemon.status.response" || type === "daemon.status") {
    handleDaemonStatus(payload);
    return;
  }
  if (type === "models.list.response") {
    handleModelsList(payload);
    return;
  }
  if (type === "ui.preferences.updated") {
    handlePreferences(payload);
    return;
  }
  if (type === "session.started") {
    handleSessionStarted(payload, sessionId);
    return;
  }
  if (type === "voice.status.updated") {
    handleVoiceStatus(payload);
    return;
  }
  if (type === "voice.doctor.response" || type === "voice.preflight.response") {
    handleVoiceDoctor(payload);
    return;
  }
  if (type === "voice.preview.started" || type === "voice.started") {
    useHud.getState().setVoiceState("speaking");
    return;
  }
  if (
    type === "voice.preview.completed" ||
    type === "voice.preview.failed" ||
    type === "voice.completed" ||
    type === "voice.failed"
  ) {
    useHud.getState().setVoiceState("idle");
    return;
  }
  if (type === "message.delta") {
    handleMessageDelta(payload, sessionId);
    return;
  }
  if (type === "message.completed") {
    handleMessageCompleted(payload, sessionId);
    return;
  }
  if (type === "agent.list.response") {
    handleAgentList(payload);
    return;
  }
  if (type === "agent.spawned") {
    handleAgentSpawned(payload);
    return;
  }
  if (type === "agent.renamed") {
    handleAgentRenamed(payload);
    return;
  }
  if (type === "agent.model.changed") {
    handleAgentModelChanged(payload);
    return;
  }
  if (type === "agent.specialist.changed") {
    handleAgentSpecialistChanged(payload);
    return;
  }
  if (type === "agent.status.changed") {
    handleAgentStatusChanged(payload);
    return;
  }
  if (
    type === "agent.session.started" ||
    type === "agent.session.updated" ||
    type === "agent.session.completed" ||
    type === "agent.session.failed" ||
    type === "agent.session.cancelled"
  ) {
    handleAgentSessionEvent(type, payload, sessionId);
    return;
  }
  if (type === "approval.requested") {
    handleApprovalRequested(payload);
    return;
  }
  if (type === "approval.resolved") {
    handleApprovalResolved(payload);
    return;
  }
  if (type === "orchestrator.route") {
    handleOrchestratorRoute(payload);
    return;
  }
  if (
    type === "worker.started" ||
    type === "worker.log.delta" ||
    type === "worker.completed" ||
    type === "worker.failed" ||
    type === "worker.cancelled" ||
    type === "worker.event"
  ) {
    handleWorkerEvent(type, payload);
    return;
  }
  if (type === "patch.created") {
    handlePatchCreated(payload);
    return;
  }
  if (type === "test.result") {
    handleTestResult(payload);
    return;
  }
}

export function handleDaemonStatus(payload: unknown): void {
  const p = asRecord(payload);
  const modelProvider = stringFrom(p.model_provider);
  const uptimeSeconds = numberFrom(p.uptime_seconds) ?? 0;
  useHud.getState().setAgentTask("main", {
    verb: "ready",
    target: "CADIS daemon",
    detail: modelProvider ? `provider ${modelProvider}` : "connected",
  });
  useHud.setState((state) => ({
    agents: state.agents.map((agent) =>
      agent.spec.id === "main" ? { ...agent, status: "idle", uptimeSeconds } : agent,
    ),
  }));
}

export function handleModelsList(payload: unknown): void {
  const p = asRecord(payload);
  const models = Array.isArray(p.models) ? normalizeModels(p.models) : [];
  const defaultModel = models[0] ?? useHud.getState().defaultModel ?? FALLBACK_MAIN_MODEL;
  useHud.getState().setAvailableModels(models, defaultModel);
}

export function handlePreferences(payload: unknown): void {
  const envelope = asRecord(payload);
  const preferences = asRecord(envelope.preferences ?? payload);
  const hud = asRecord(preferences.hud);
  const voice = asRecord(preferences.voice);
  const chat = asRecord(preferences.chat);

  const theme = stringFrom(hud.theme);
  if (isThemeKey(theme)) useHud.getState().setTheme(theme);

  const avatarStyle = normalizeAvatarStyle(stringFrom(hud.avatar_style));
  if (avatarStyle) useHud.getState().setAvatarStyle(avatarStyle);

  const opacity = numberFrom(hud.background_opacity);
  if (opacity !== undefined) useHud.getState().setBackgroundOpacity(opacity);

  const voicePatch: Partial<VoicePrefs> = {};
  if (typeof voice.enabled === "boolean") voicePatch.enabled = voice.enabled;
  const provider = stringFrom(voice.provider);
  if (provider === "edge" || provider === "elevenlabs") voicePatch.provider = provider;
  const voiceId = stringFrom(voice.voice_id);
  if (voiceId) voicePatch.voiceId = voiceId;
  const rate = numberFrom(voice.rate);
  const pitch = numberFrom(voice.pitch);
  const volume = numberFrom(voice.volume);
  if (rate !== undefined) voicePatch.rate = rate;
  if (pitch !== undefined) voicePatch.pitch = pitch;
  if (volume !== undefined) voicePatch.volume = volume;
  if (typeof voice.auto_speak === "boolean") voicePatch.autoSpeak = voice.auto_speak;
  if (Object.keys(voicePatch).length) useHud.getState().updateVoicePrefs(voicePatch);

  const chatPatch: { thinking?: boolean; fast?: boolean } = {};
  if (typeof chat.thinking === "boolean") chatPatch.thinking = chat.thinking;
  if (typeof chat.fast === "boolean") chatPatch.fast = chat.fast;
  if (Object.keys(chatPatch).length) useHud.getState().setChatPreferences(chatPatch);
}

export function handleSessionStarted(payload: unknown, sessionId?: string): void {
  const p = asRecord(payload);
  const sid = stringFrom(p.session_id) ?? sessionId;
  const title = stringFrom(p.title);
  const label = title ?? sid;
  if (!label) return;
  useHud.getState().upsertChat({
    id: `session-${sid ?? label}`,
    who: "system",
    text: `(session started: ${label})`,
    ts: Date.now(),
    final: true,
  });
}

export function handleVoiceStatus(payload: unknown): void {
  const status = normalizeVoiceStatus(payload);
  if (status) useHud.getState().setVoiceStatus(status);
}

export function handleVoiceDoctor(payload: unknown): void {
  const p = asRecord(payload);
  const status = normalizeVoiceStatus(p.status);
  if (status) useHud.getState().setVoiceStatus(status);

  const checks = Array.isArray(p.checks)
    ? p.checks
        .map(normalizeVoiceCheck)
        .filter((check): check is VoiceDiagnosticCheck => Boolean(check))
    : [];
  useHud.getState().setVoiceDoctor({
    summary: voiceDoctorSummary(checks),
    checks,
  });
}

export function handleMessageDelta(payload: unknown, sessionId?: string): void {
  const p = asRecord(payload);
  const delta = stringFrom(p.delta);
  if (!delta) return;
  const sid = sessionId ?? "main";
  const stream = streamingBySession.get(sid) ?? { id: `m-${Date.now()}-${sid}`, text: "" };
  stream.text += delta;
  streamingBySession.set(sid, stream);
  useHud.getState().upsertChat({
    id: stream.id,
    who: "cadis",
    text: stream.text,
    ts: Date.now(),
    final: false,
    agentId: stringFrom(p.agent_id),
    agentName: stringFrom(p.agent_name),
  });
}

export function handleMessageCompleted(payload: unknown, sessionId?: string): void {
  const p = asRecord(payload);
  const sid = sessionId ?? "main";
  const stream = streamingBySession.get(sid);
  const finalText = stringFrom(p.content) ?? stringFrom(p.text) ?? stream?.text;
  if (!finalText) return;
  useHud.getState().upsertChat({
    id: stream?.id ?? `m-${Date.now()}-${sid}`,
    who: "cadis",
    text: finalText,
    ts: Date.now(),
    final: true,
    agentId: stringFrom(p.agent_id),
    agentName: stringFrom(p.agent_name),
  });
  useHud.getState().setVoiceState("idle");
  streamingBySession.delete(sid);
}

export function handleAgentList(payload: unknown): void {
  const p = asRecord(payload);
  const agents = Array.isArray(p.agents) ? p.agents : [];
  for (const agent of agents) handleAgentSpawned(agent);
}

export function handleAgentSpawned(payload: unknown): void {
  const p = asRecord(payload);
  const agentId = stringFrom(p.agent_id) ?? stringFrom(p.id);
  if (!agentId) return;

  const model = stringFrom(p.model);
  const displayName = stringFrom(p.display_name) ?? stringFrom(p.name);
  const role = stringFrom(p.role);
  const parentAgentId = stringFrom(p.parent_agent_id);
  const status = normalizeAgentStatus(stringFrom(p.status)) ?? "idle";
  const specialist = readAgentSpecialist(p as Record<string, unknown>, role);

  upsertDaemonAgent({ agentId, displayName, role, parentAgentId, model, status, specialist });
  if (model) useHud.getState().setAgentModel(agentId, model);
}

export function handleAgentRenamed(payload: unknown): void {
  const p = asRecord(payload);
  const agentId = stringFrom(p.agent_id);
  const displayName = stringFrom(p.display_name);
  if (agentId && displayName) useHud.getState().renameAgent(agentId, displayName);
}

export function handleAgentModelChanged(payload: unknown): void {
  const p = asRecord(payload);
  const agentId = stringFrom(p.agent_id);
  const model = stringFrom(p.model);
  if (agentId && model) useHud.getState().setAgentModel(agentId, model);
}

export function handleAgentSpecialistChanged(payload: unknown): void {
  const p = asRecord(payload);
  const agentId = stringFrom(p.agent_id);
  if (!agentId) return;
  const existing = useHud.getState().agents.find((agent) => agent.spec.id === agentId);
  const specialist = readAgentSpecialist(p as Record<string, unknown>, existing?.spec.role);
  if (specialist) useHud.getState().setAgentSpecialist(agentId, specialist);
}

export function handleAgentStatusChanged(payload: unknown): void {
  const p = asRecord(payload);
  const agentId = stringFrom(p.agent_id);
  if (!agentId) return;

  const status = normalizeAgentStatus(stringFrom(p.status));
  if (status) useHud.getState().setAgentStatus(agentId, status);

  const task = stringFrom(p.task);
  if (task) {
    useHud.getState().setAgentTask(agentId, {
      verb: status === "working" ? "working" : "ready",
      target: agentId === "main" ? "session" : `${agentId} agent`,
      detail: task,
    });
  }
}

export function handleAgentSessionEvent(type: string, payload: unknown, sessionId?: string): void {
  const p = asRecord(payload);
  const sessionRecordId = stringFrom(p.agent_session_id) ?? stringFrom(p.id);
  const agentId = stringFrom(p.agent_id);
  if (!sessionRecordId || !agentId) return;

  const existing = useHud
    .getState()
    .agentSessions.find((candidate) => candidate.id === sessionRecordId);
  const status =
    normalizeAgentSessionStatus(stringFrom(p.status)) ?? defaultAgentSessionStatus(type);
  const task = stringFrom(p.task) ?? existing?.task ?? "agent session";
  const budgetSteps = numberFrom(p.budget_steps) ?? existing?.budgetSteps ?? 0;
  const stepsUsed = numberFrom(p.steps_used) ?? existing?.stepsUsed ?? 0;
  const result = stringFrom(p.result);
  const error = stringFrom(p.error) ?? stringFrom(p.error_code);
  const parentAgentId = stringFrom(p.parent_agent_id) ?? existing?.parentAgentId;

  ensureKnownAgent(agentId);
  useHud.getState().upsertAgentSession({
    id: sessionRecordId,
    sessionId: stringFrom(p.session_id) ?? sessionId ?? existing?.sessionId ?? "main",
    routeId: stringFrom(p.route_id) ?? existing?.routeId ?? "",
    agentId,
    parentAgentId,
    task,
    status,
    timeoutAt: stringFrom(p.timeout_at) ?? existing?.timeoutAt,
    budgetSteps,
    stepsUsed,
    result,
    error,
    updatedAt: Date.now(),
  });

  useHud.getState().setAgentStatus(agentId, agentStatusFromSession(status));
  useHud.getState().setAgentTask(agentId, {
    verb: agentTaskVerbFromSession(status),
    target: task,
    detail: agentSessionDetail({ status, budgetSteps, stepsUsed, result, error }),
  });
}

export function handleApprovalRequested(payload: unknown): void {
  const p = asRecord(payload);
  const approvalId = stringFrom(p.approval_id) ?? stringFrom(p.id);
  if (!approvalId) return;
  useHud.getState().pushApproval({
    id: approvalId,
    ruleId: stringFrom(p.risk_class) ?? stringFrom(p.rule_id) ?? "approval",
    reason: stringFrom(p.summary) ?? stringFrom(p.reason) ?? stringFrom(p.title) ?? "",
    cmd: stringFrom(p.command) ?? stringFrom(p.cmd) ?? "",
    cwd: stringFrom(p.workspace) ?? stringFrom(p.cwd) ?? "",
    agentId: stringFrom(p.agent_id) ?? "main",
    ts: Date.now(),
  });
}

export function handleApprovalResolved(payload: unknown): void {
  const p = asRecord(payload);
  const approvalId = stringFrom(p.approval_id) ?? stringFrom(p.id);
  if (approvalId) useHud.getState().removeApproval(approvalId);
}

export function handleOrchestratorRoute(payload: unknown): void {
  const p = asRecord(payload);
  const targetAgentId = stringFrom(p.target_agent_id) ?? stringFrom(p.target);
  const targetAgentName = stringFrom(p.target_agent_name) ?? agentDisplayName(targetAgentId);
  if (targetAgentId && !targetAgentName) ensureKnownAgent(targetAgentId);

  const source = stringFrom(p.source) ?? "orchestrator";
  const target = targetAgentName ?? targetAgentId ?? "agent";
  const reason = stringFrom(p.reason);
  const routeId = stringFrom(p.id) ?? `route-${Date.now()}`;
  useHud.getState().upsertChat({
    id: `route-${routeId}`,
    who: "system",
    text: reason ? `(route: ${source} -> ${target}; ${reason})` : `(route: ${source} -> ${target})`,
    ts: Date.now(),
    agentId: targetAgentId,
    agentName: targetAgentName,
    final: true,
  });
}

export function handleWorkerEvent(type: string, payload: unknown): void {
  const p = asRecord(payload);
  const workerId = stringFrom(p.worker_id) ?? stringFrom(p.id) ?? stringFrom(p.agent_id);
  if (!workerId) return;
  const existing = useHud.getState().workers.find((worker) => worker.id === workerId);
  const agentId = stringFrom(p.agent_id);
  const parentAgentId = stringFrom(p.parent_agent_id) ?? agentId ?? existing?.parentAgentId ?? "main";
  const status = normalizeWorkerStatus(stringFrom(p.status)) ?? defaultWorkerStatus(type);
  const summary = stringFrom(p.summary);
  const delta = stringFrom(p.delta);
  const text = delta ?? summary ?? stringFrom(p.text) ?? existing?.lastText;
  const logTail = nextWorkerLogTail(existing, delta);
  const logLineCount = existing ? existing.logLineCount + (delta ? 1 : 0) : delta ? 1 : 0;
  ensureKnownAgent(parentAgentId);
  useHud.getState().upsertWorker({
    id: workerId,
    agentId: agentId ?? existing?.agentId,
    parentAgentId,
    cli: stringFrom(p.cli) ?? existing?.cli,
    cwd: stringFrom(p.cwd) ?? existing?.cwd,
    status,
    lastText: text,
    summary: summary ?? existing?.summary,
    logLineCount,
    logTail,
    worktree: readWorkerWorktree(p.worktree) ?? existing?.worktree,
    artifacts: readWorkerArtifacts(p.artifacts) ?? existing?.artifacts,
    startedAt: numberFrom(p.started_at) ?? existing?.startedAt ?? Date.now(),
    updatedAt: numberFrom(p.updated_at) ?? Date.now(),
  });
}

export function handleRequestRejected(payload: unknown): void {
  const p = asRecord(payload);
  const message = stringFrom(p.message) ?? "CADIS request was rejected";
  pushSystem(`(${message})`);
}

export function handlePatchCreated(payload: unknown): void {
  const p = asRecord(payload);
  const id = stringFrom(p.patch_id) ?? `patch-${Date.now()}`;
  const summary = stringFrom(p.summary) ?? "patch created";
  useHud.getState().pushPatch({ id, summary });
}

export function handleTestResult(payload: unknown): void {
  const p = asRecord(payload);
  const status = stringFrom(p.status) ?? "unknown";
  const summary = stringFrom(p.summary) ?? status;
  useHud.getState().pushTestResult({ id: `test-${Date.now()}`, summary: `[${status}] ${summary}` });
}
