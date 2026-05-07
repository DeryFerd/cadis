import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { defaultSpecialistForRole } from "../../lib/agent-specialists.js";
import { useHud, type AgentLive } from "../hudState.js";
import { AgentWidget } from "./AgentWidget.js";

const AGENT: AgentLive = {
  spec: { id: "codex", name: "Codex", role: "Coding", icon: "◇", hue: 200, tasks: [] },
  status: "working",
  currentTask: { verb: "Editing", target: "main.ts", detail: "refactor" },
  specialist: defaultSpecialistForRole("Coding"),
  uptimeSeconds: 42,
};

beforeEach(() => {
  useHud.setState({ workers: [], agentSessions: [], selectedWorkerId: null });
});

describe("AgentWidget", () => {
  it("renders agent name, status, and current task", () => {
    render(<AgentWidget agent={AGENT} xPct={50} yPct={50} />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("Editing")).toBeInTheDocument();
    expect(screen.getByText("main.ts")).toBeInTheDocument();
  });
});
