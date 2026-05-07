import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useHud, type WorkerRecord } from "../hudState.js";
import { WorkerTree } from "./WorkerTree.js";

const WORKER: WorkerRecord = {
  id: "w-001",
  agentId: "codex",
  parentAgentId: "codex",
  cli: "codex",
  status: "running",
  lastText: "applying patch",
  logLineCount: 5,
  logTail: ["line1"],
  startedAt: Date.now(),
  updatedAt: Date.now(),
};

beforeEach(() => {
  useHud.setState({ workers: [WORKER], agentSessions: [], selectedWorkerId: null });
});

describe("WorkerTree", () => {
  it("renders worker entry with status and text", () => {
    render(<WorkerTree agentId="codex" />);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText(/applying patch/)).toBeInTheDocument();
  });

  it("shows worker count in toggle label", () => {
    render(<WorkerTree agentId="codex" />);
    expect(screen.getByText(/workers · 1/)).toBeInTheDocument();
  });

  it("returns null when no workers match", () => {
    const { container } = render(<WorkerTree agentId="nonexistent" />);
    expect(container.firstChild).toBeNull();
  });
});
