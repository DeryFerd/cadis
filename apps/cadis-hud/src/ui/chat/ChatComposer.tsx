import { useState, useRef, useEffect, useMemo } from "react";
import type { KeyboardEvent } from "react";
import type { AgentLive } from "../hudState.js";

const MAX_MENTION_OPTIONS = 8;

export type MentionOption = {
  id: string;
  name: string;
  role: string;
  status: string;
};

export function getActiveMentionQuery(value: string): string | null {
  const match = value.match(/^@([A-Za-z0-9._-]*)$/);
  return match ? (match[1] ?? "") : null;
}

export function buildMentionOptions(agents: AgentLive[], query: string): MentionOption[] {
  const normalizedQuery = normalizeMentionSearch(query);
  return agents
    .map((agent) => ({
      id: agent.spec.id,
      name: agent.spec.name,
      role: agent.spec.role,
      status: agent.status,
    }))
    .filter((option) => {
      if (!normalizedQuery) return true;
      return [option.id, option.name, option.role].some((value) =>
        normalizeMentionSearch(value).includes(normalizedQuery),
      );
    })
    .sort((left, right) => mentionSortScore(left, normalizedQuery) - mentionSortScore(right, normalizedQuery))
    .slice(0, MAX_MENTION_OPTIONS);
}

function mentionSortScore(option: MentionOption, normalizedQuery: string): number {
  if (!normalizedQuery) return option.id === "main" ? -1 : 0;
  const id = normalizeMentionSearch(option.id);
  const name = normalizeMentionSearch(option.name);
  if (id === normalizedQuery || name === normalizedQuery) return 0;
  if (id.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) return 1;
  return 2;
}

function normalizeMentionSearch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg className="chat-panel__icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3Z" />
      <path d="M6.5 10.5v1.1a5.5 5.5 0 0 0 11 0v-1.1" />
      <path d="M12 17.2v3.3" />
      <path d="M8.6 20.5h6.8" />
      {active && <path d="M18.5 7.2c1 1.3 1.5 2.9 1.5 4.8s-.5 3.5-1.5 4.8" />}
    </svg>
  );
}

function VoiceSettingsIcon() {
  return (
    <svg className="chat-panel__icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h2.8l3.4-4.2v8.4L6.8 12H4Z" />
      <path d="M14 8.5c1.1 1 1.6 2.1 1.6 3.5S15.1 14.5 14 15.5" />
      <path d="M17 5.8c1.9 1.7 2.8 3.8 2.8 6.2s-.9 4.5-2.8 6.2" />
    </svg>
  );
}

function ModelSettingsIcon() {
  return (
    <svg className="chat-panel__icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9.5 9.5h5v5h-5Z" />
      <path d="M9 3.5v2.5M15 3.5v2.5M9 18v2.5M15 18v2.5M3.5 9h2.5M3.5 15h2.5M18 9h2.5M18 15h2.5" />
    </svg>
  );
}

export interface ChatComposerProps {
  onSend: (text: string) => void;
  disabled: boolean;
  agents: AgentLive[];
  listening: boolean;
  onToggleMic: () => void;
  onOpenVoiceSettings: () => void;
  onOpenModelSettings: () => void;
  modelLabel: string;
  mainName: string;
}

export function ChatComposer({
  onSend,
  disabled,
  agents,
  listening,
  onToggleMic,
  onOpenVoiceSettings,
  onOpenModelSettings,
  modelLabel,
  mainName,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedMentionDraft, setDismissedMentionDraft] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const mentionQuery = getActiveMentionQuery(draft);
  const mentionOptions = useMemo(
    () => (mentionQuery === null ? [] : buildMentionOptions(agents, mentionQuery)),
    [agents, mentionQuery],
  );
  const showMentionMenu =
    !disabled &&
    mentionQuery !== null &&
    dismissedMentionDraft !== draft &&
    mentionOptions.length > 0;

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery, mentionOptions.length]);

  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft("");
  };

  const applyMention = (option: MentionOption) => {
    const next = `@${option.id} `;
    setDraft(next);
    setDismissedMentionDraft(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionMenu) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((index) => (index - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        applyMention(mentionOptions[mentionIndex] ?? mentionOptions[0]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMentionDraft(draft);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-panel__compose-wrap">
      {showMentionMenu && (
        <div
          id="agent-mention-list"
          className="chat-panel__mentions"
          role="listbox"
          aria-label="agent mentions"
        >
          {mentionOptions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === mentionIndex}
              className={`chat-panel__mention${index === mentionIndex ? " chat-panel__mention--active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setMentionIndex(index)}
              onClick={() => applyMention(option)}
            >
              <span className="chat-panel__mention-handle">@{option.id}</span>
              <span className="chat-panel__mention-name">{option.name}</span>
              <span className="chat-panel__mention-role">{option.role}</span>
              <span className={`chat-panel__mention-status chat-panel__mention-status--${option.status}`}>
                {option.status}
              </span>
            </button>
          ))}
        </div>
      )}
      <form
        className="chat-panel__compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={disabled ? { opacity: 0.45 } : undefined}
        title={disabled ? "Daemon disconnected" : undefined}
      >
        <button
          type="button"
          className={`chat-panel__icon-btn${listening ? " chat-panel__icon-btn--active" : ""}`}
          onClick={onToggleMic}
          title={listening ? "Stop listening" : `Talk to ${mainName}`}
          aria-label="microphone"
        >
          <MicIcon active={listening} />
        </button>
        <button
          type="button"
          className="chat-panel__icon-btn"
          onClick={onOpenVoiceSettings}
          title="Voice settings"
          aria-label="voice settings"
        >
          <VoiceSettingsIcon />
        </button>
        <button
          type="button"
          className="chat-panel__icon-btn chat-panel__icon-btn--model"
          onClick={onOpenModelSettings}
          title={`Model settings: ${modelLabel}`}
          aria-label={`model settings: ${modelLabel}`}
        >
          <ModelSettingsIcon />
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDismissedMentionDraft(null);
          }}
          onKeyDown={handleDraftKeyDown}
          aria-autocomplete="list"
          aria-controls={showMentionMenu ? "agent-mention-list" : undefined}
          aria-expanded={showMentionMenu}
          placeholder={
            !disabled
              ? "or type a command..."
              : "waiting for CADIS..."
          }
          disabled={disabled}
        />
        <button type="submit" disabled={!draft.trim() || disabled}>
          SEND
        </button>
      </form>
    </div>
  );
}
