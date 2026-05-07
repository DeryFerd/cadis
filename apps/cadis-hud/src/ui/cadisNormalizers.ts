import {
  THEMES,
  normalizeAgentName,
  useHud,
  type AgentLive,
  type AgentSessionRecord,
  type AgentSessionStatus,
  type ThemeKey,
  type VoiceDaemonStatus,
  type VoiceDiagnosticCheck,
  type WorkerArtifactInfo,
  type WorkerRecord,
  type WorkerStatus,
  type WorkerWorktreeInfo,
} from "./hudState.js";
import { AGENT_ROSTER } from "../lib/agents-roster.js";
import {
  defaultSpecialistForRole,
  normalizeSpecialistProfile,
  type AgentSpecialistProfile,
} from "../lib/agent-specialists.js";

const FALLBACK_MAIN_MODEL = "openai/gpt-5.5";
const AGENT_ROSTER_BY_ID = new Map(AGENT_ROSTER.map((agent) => [agent.id, agent]));

type RawModelDescriptor = {
  provider?: unknown;
  model?: unknown;
  provider_id?: unknown;
  model_id?: unknown;
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
};

export { FALLBACK_MAIN_MODEL, AGENT_ROSTER_BY_ID };

export function normalizeModels(models: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const normalized = coerceModel(model);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function coerceModel(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const v = value as RawModelDescriptor;
  if (typeof v.provider === "string" && typeof v.model === "string") return joinModel(v.provider, v.model);
  if (typeof v.provider_id === "string" && typeof v.model_id === "string") {
    return joinModel(v.provider_id, v.model_id);
  }
  if (typeof v.id === "string") return v.id;
  if (typeof v.model === "string") return v.model;
  if (typeof v.model_id === "string") return v.model_id;
  if (typeof v.name === "string") return v.name;
  if (typeof v.display_name === "string") return v.display_name;
  return null;
}

export function joinModel(provider: string, model: string): string {
  const cleanProvider = provider.trim();
  const cleanModel = model.trim();
  if (!cleanProvider) return cleanModel;
  if (!cleanModel) return cleanProvider;
  return cleanModel.includes("/") ? cleanModel : `${cleanProvider}/${cleanModel}`;
}

export function normalizeAgentStatus(status: string | undefined): AgentLive["status"] | null {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (normalized === "spawning" || normalized === "starting" || normalized === "started") {
    return "waiting";
  }
  if (normalized === "running" || normalized === "working") return "working";
  if (normalized === "waitingapproval" || normalized === "waiting_approval" || normalized === "waiting") {
    return "waiting";
  }
  if (normalized === "idle" || normalized === "completed") return "idle";
  if (normalized === "failed" || normalized === "error" || normalized === "timed_out") return "idle";
  if (normalized === "cancelled" || normalized === "canceled") return "idle";
  return null;
}

export function normalizeAgentSessionStatus(status: string | undefined): AgentSessionStatus | null {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (normalized === "started" || normalized === "starting") return "started";
  if (normalized === "running" || normalized === "working") return "running";
  if (normalized === "completed" || normalized === "complete" || normalized === "succeeded") {
    return "completed";
  }
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "timed_out" || normalized === "timeout") return "timed_out";
  if (normalized === "budget_exceeded" || normalized === "budgetexceeded") {
    return "budget_exceeded";
  }
  return null;
}

export function normalizeWorkerStatus(status: string | undefined): WorkerStatus | null {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (normalized === "spawning" || normalized === "starting" || normalized === "started") {
    return "spawning";
  }
  if (normalized === "running" || normalized === "working") return "running";
  if (normalized === "completed" || normalized === "complete" || normalized === "succeeded") {
    return "completed";
  }
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return null;
}

export function normalizeVoiceStatus(payload: unknown): VoiceDaemonStatus | null {
  const p = asRecord(payload);
  const provider = stringFrom(p.provider) ?? "edge";
  const voiceId = stringFrom(p.voice_id) ?? "id-ID-GadisNeural";
  const sttLanguage = stringFrom(p.stt_language) ?? "auto";
  const maxSpokenChars = numberFrom(p.max_spoken_chars) ?? 800;
  const bridge = stringFrom(p.bridge) ?? "hud-local";
  const state = normalizeVoiceState(stringFrom(p.state));
  const lastPreflight = asRecord(p.last_preflight);
  const surface = stringFrom(lastPreflight.surface);
  const checkedAt = stringFrom(lastPreflight.checked_at);
  const summary = stringFrom(lastPreflight.summary);
  const preflightStatus = stringFrom(lastPreflight.status);

  return {
    enabled: p.enabled === true,
    state,
    provider,
    voiceId,
    sttLanguage,
    maxSpokenChars,
    bridge,
    ...(surface && checkedAt && summary && preflightStatus
      ? {
          lastPreflight: {
            surface,
            checkedAt,
            summary,
            status: preflightStatus,
          },
        }
      : {}),
  };
}

export function normalizeVoiceState(state: string | undefined): VoiceDaemonStatus["state"] {
  if (
    state === "disabled" ||
    state === "ready" ||
    state === "degraded" ||
    state === "blocked" ||
    state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

export function normalizeVoiceCheck(value: unknown): VoiceDiagnosticCheck | null {
  const p = asRecord(value);
  const name = stringFrom(p.name);
  if (!name) return null;
  return {
    name,
    status: hudVoiceCheckStatus(stringFrom(p.status)),
    detail: stringFrom(p.message) ?? stringFrom(p.detail) ?? "",
  };
}

export function hudVoiceCheckStatus(status: string | undefined): VoiceDiagnosticCheck["status"] {
  const normalized = status?.toLowerCase();
  if (normalized === "ok" || normalized === "pass" || normalized === "ready") return "pass";
  if (normalized === "error" || normalized === "fail" || normalized === "blocked") return "fail";
  return "warn";
}

export function protocolVoiceCheckStatus(status: VoiceDiagnosticCheck["status"]): string {
  if (status === "pass") return "ok";
  if (status === "fail") return "error";
  return "warn";
}

export function voiceDoctorSummary(checks: VoiceDiagnosticCheck[]): string {
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  if (failures) return `${failures} blocking issue${failures === 1 ? "" : "s"}`;
  if (warnings) return `${warnings} warning${warnings === 1 ? "" : "s"}`;
  return checks.length ? "ready" : "not run";
}

export function defaultWorkerStatus(type: string): WorkerStatus {
  if (type === "worker.started") return "spawning";
  if (type === "worker.completed") return "completed";
  if (type === "worker.failed") return "failed";
  if (type === "worker.cancelled") return "cancelled";
  return "running";
}

export function defaultAgentSessionStatus(type: string): AgentSessionStatus {
  if (type === "agent.session.started") return "started";
  if (type === "agent.session.completed") return "completed";
  if (type === "agent.session.failed") return "failed";
  if (type === "agent.session.cancelled") return "cancelled";
  return "running";
}

export function agentStatusFromSession(status: AgentSessionStatus): AgentLive["status"] {
  if (status === "started" || status === "running") return "working";
  return "idle";
}

export function agentTaskVerbFromSession(status: AgentSessionStatus): string {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "timed_out" || status === "budget_exceeded") return "failed";
  if (status === "cancelled") return "cancelled";
  return "working";
}

export function agentSessionDetail({
  status,
  budgetSteps,
  stepsUsed,
  result,
  error,
}: Pick<AgentSessionRecord, "status" | "budgetSteps" | "stepsUsed" | "result" | "error">): string {
  if (status === "completed" && result) return result;
  if ((status === "failed" || status === "timed_out" || status === "budget_exceeded") && error) {
    return error;
  }
  if (budgetSteps > 0) return `step ${Math.min(stepsUsed, budgetSteps)}/${budgetSteps}`;
  return status.replace("_", " ");
}

export function nextWorkerLogTail(existing: WorkerRecord | undefined, delta: string | undefined): string[] {
  if (!delta) return existing?.logTail ?? [];
  return [...(existing?.logTail ?? []), delta].slice(-3);
}

export function readWorkerWorktree(value: unknown): WorkerWorktreeInfo | undefined {
  const worktree = asRecord(value);
  const state = stringFrom(worktree.state);
  const branchName = stringFrom(worktree.branch_name);
  const worktreePath = stringFrom(worktree.worktree_path);
  const cleanupPolicy = stringFrom(worktree.cleanup_policy);
  if (!state && !branchName && !worktreePath && !cleanupPolicy) return undefined;
  return { state, branchName, worktreePath, cleanupPolicy };
}

export function readWorkerArtifacts(value: unknown): WorkerArtifactInfo | undefined {
  const artifacts = asRecord(value);
  const summary = stringFrom(artifacts.summary);
  const patch = stringFrom(artifacts.patch);
  const testReport = stringFrom(artifacts.test_report);
  const testReportStatus =
    stringFrom(artifacts.test_report_status) ??
    stringFrom(artifacts.test_status) ??
    stringFrom(artifacts.tests_status);
  const changedFiles = stringFrom(artifacts.changed_files);
  if (!summary && !patch && !testReport && !testReportStatus && !changedFiles) return undefined;
  return { summary, patch, testReport, testReportStatus, changedFiles };
}

export function readAgentSpecialist(
  payload: Record<string, unknown>,
  role: string | undefined,
): AgentSpecialistProfile | undefined {
  const fallback = defaultSpecialistForRole(role ?? "Generalist");
  const specialistId = stringFrom(payload.specialist_id);
  const specialistLabel = stringFrom(payload.specialist_label);
  const persona = stringFrom(payload.persona);
  if (!specialistId && !specialistLabel && !persona) return undefined;
  return normalizeSpecialistProfile(
    {
      id: specialistId,
      label: specialistLabel,
      persona,
    },
    fallback,
  );
}

export function readSessionId(envelope: { session_id?: unknown; payload?: unknown }): string | undefined {
  if (typeof envelope.session_id === "string" && envelope.session_id) return envelope.session_id;
  const payload = asRecord(envelope.payload);
  return stringFrom(payload.session_id);
}

export function upsertDaemonAgent({
  agentId,
  displayName,
  role,
  parentAgentId,
  model,
  status,
  specialist,
}: {
  agentId: string;
  displayName?: string;
  role?: string;
  parentAgentId?: string;
  model?: string;
  status: AgentLive["status"];
  specialist?: AgentSpecialistProfile;
}): void {
  const existing = useHud.getState().agents.find((agent) => agent.spec.id === agentId);
  const rosterSpec = AGENT_ROSTER_BY_ID.get(agentId);
  const baseSpec = existing?.spec ?? rosterSpec ?? {
    id: agentId,
    name: agentId,
    role: "Agent",
    icon: "◈",
    hue: deterministicHue(agentId),
    tasks: [],
  };
  const name = normalizeAgentName(displayName ?? baseSpec.name, baseSpec.name);
  const nextRole = normalizeAgentName(role ?? baseSpec.role, baseSpec.role);
  const nextSpecialist = normalizeSpecialistProfile(
    specialist ?? existing?.specialist,
    defaultSpecialistForRole(nextRole),
  );
  upsertAgent({
    spec: {
      ...baseSpec,
      id: agentId,
      name,
      role: nextRole,
    },
    status,
    currentTask: {
      verb: status === "working" ? "working" : "ready",
      target: parentAgentId ? `child of ${parentAgentId}` : `${name} agent`,
      detail: model ?? existing?.currentTask.detail ?? FALLBACK_MAIN_MODEL,
    },
    specialist: nextSpecialist,
    uptimeSeconds: existing?.uptimeSeconds ?? 0,
    parentAgentId,
  });
}

export function upsertAgent(agent: AgentLive): void {
  useHud.setState((state) => {
    const index = state.agents.findIndex((candidate) => candidate.spec.id === agent.spec.id);
    if (index === -1) return { agents: [...state.agents, agent] };
    const next = [...state.agents];
    next[index] = { ...next[index]!, ...agent };
    return { agents: next };
  });
}

export function agentDisplayName(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  return useHud.getState().agents.find((agent) => agent.spec.id === agentId)?.spec.name;
}

export function deterministicHue(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function parseMentionTargetAgentId(text: string): string | undefined {
  const match = text.match(/^@([A-Za-z0-9._-]+)(?:\s+|$)/);
  const token = match?.[1];
  if (!token) return undefined;
  return resolveMentionTargetAgentId(token);
}

export function resolveMentionTargetAgentId(token: string): string {
  const target = normalizeMentionToken(token);
  const known = useHud.getState().agents.find((agent) => {
    const names = [agent.spec.id, agent.spec.name, agent.spec.role];
    if (agent.specialist?.label) names.push(agent.specialist.label);
    return names.some((name) => normalizeMentionToken(name) === target);
  });
  return known?.spec.id ?? token;
}

export function normalizeMentionToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function pushSystem(text: string): void {
  useHud.getState().pushChat({
    id: `m-${Date.now()}-system`,
    who: "system",
    text,
    ts: Date.now(),
  });
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function isThemeKey(value: string | undefined): value is ThemeKey {
  return Boolean(value && value in THEMES);
}

export function ensureKnownAgent(agentId: string, model?: string): void {
  if (useHud.getState().agents.some((agent) => agent.spec.id === agentId)) return;
  upsertDaemonAgent({ agentId, model, status: "idle" });
}
