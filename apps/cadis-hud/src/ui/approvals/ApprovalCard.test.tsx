import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useHud, type ApprovalRecord } from "../hudState.js";
import { ApprovalCard } from "./ApprovalCard.js";

vi.mock("../cadisActions.js", () => ({
  sendApprovalResponse: vi.fn(() => true),
}));

const APPROVAL: ApprovalRecord = {
  id: "apr-1",
  ruleId: "shell.exec",
  reason: "shell command requires approval",
  cmd: "rm -rf /tmp/test",
  cwd: "/home/user",
  agentId: "codex",
  ts: Date.now(),
};

beforeEach(() => {
  useHud.setState({ gateway: "connected" });
});

describe("ApprovalCard", () => {
  it("renders rule, agent, command, and cwd", () => {
    render(<ApprovalCard approval={APPROVAL} onRespond={vi.fn()} />);
    expect(screen.getByText("shell.exec")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("rm -rf /tmp/test")).toBeInTheDocument();
    expect(screen.getByText(/cwd · \/home\/user/)).toBeInTheDocument();
  });

  it("renders approve and deny buttons", () => {
    render(<ApprovalCard approval={APPROVAL} onRespond={vi.fn()} />);
    expect(screen.getByRole("button", { name: "OK" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "DENY" })).toBeEnabled();
  });

  it("disables buttons when gateway is disconnected", () => {
    useHud.setState({ gateway: "disconnected" });
    render(<ApprovalCard approval={APPROVAL} onRespond={vi.fn()} />);
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "DENY" })).toBeDisabled();
  });
});
