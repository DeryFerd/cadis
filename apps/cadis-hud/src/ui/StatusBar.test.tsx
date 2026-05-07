import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AGENT_ROSTER } from "../lib/agents-roster.js";
import { defaultSpecialistForRole } from "../lib/agent-specialists.js";
import { useHud, type AgentLive } from "./hudState.js";
import { StatusBar } from "./StatusBar.js";

const AGENTS: AgentLive[] = AGENT_ROSTER.map((a) => ({
  spec: a,
  status: a.id === "main" ? "working" : "idle",
  currentTask: { verb: "ready", target: a.name, detail: "" },
  specialist: defaultSpecialistForRole(a.role),
  uptimeSeconds: 0,
}));

beforeEach(() => {
  useHud.setState({
    gateway: "connected",
    agents: AGENTS,
    defaultModel: "openai/gpt-5.5",
    agentModels: { main: "openai/gpt-5.5" },
  });
});

describe("StatusBar", () => {
  it("renders gateway status and model info", () => {
    render(<StatusBar />);
    expect(screen.getByText(/cadis · connected/)).toBeInTheDocument();
    expect(screen.getByText(/model · openai\/gpt-5\.5/)).toBeInTheDocument();
  });

  it("renders agent counts", () => {
    render(<StatusBar />);
    expect(screen.getByText(/1 ACTIVE/)).toBeInTheDocument();
    expect(screen.getByText(/IDLE/)).toBeInTheDocument();
  });
});
