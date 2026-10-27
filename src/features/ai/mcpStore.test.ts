// Author: Liz
import { beforeEach, expect, it, vi } from "vitest";

import { setMcpAffectedDomainsHandler, useMcpStore, type McpToolPendingInvocation } from "./mcpStore";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/tauriClient", () => ({ invokeTauri: invokeMock }));

const pending: McpToolPendingInvocation = {
  id: "pending-test", tool_id: "ssh.execute", tool_title: "执行命令", risk_level: "high",
  arguments_summary: "systemctl restart test", requires_confirmation: true, status: "pending",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  invokeMock.mockReset();
  setMcpAffectedDomainsHandler(null);
  useMcpStore.setState({ pendingInvocations: [pending], loading: false, error: null });
});

it("deduplicates an in-flight decision and finishes its UI state before domain refresh completes", async () => {
  const confirmation = deferred<{ affected_domains: string[] }>();
  const refresh = deferred<void>();
  const handler = vi.fn(() => refresh.promise);
  setMcpAffectedDomainsHandler(handler);
  invokeMock.mockImplementation((command: string) => command === "mcp_tool_confirm" ? confirmation.promise : Promise.resolve([]));

  const first = useMcpStore.getState().confirmTool(pending.id, true);
  await useMcpStore.getState().confirmTool(pending.id, false);
  expect(invokeMock).toHaveBeenCalledTimes(1);
  expect(useMcpStore.getState().loading).toBe(true);

  confirmation.resolve({ affected_domains: ["sessions", "sessions"] });
  await first;
  expect(useMcpStore.getState().loading).toBe(false);
  expect(useMcpStore.getState().pendingInvocations).toEqual([]);
  expect(handler).toHaveBeenCalledWith(["sessions"]);
  refresh.resolve();
});

it("retains the pending operation and allows retry when the confirmation IPC fails", async () => {
  invokeMock.mockRejectedValueOnce(new Error("confirmation unavailable"));
  await useMcpStore.getState().confirmTool(pending.id, false);
  expect(useMcpStore.getState().pendingInvocations).toEqual([pending]);
  expect(useMcpStore.getState().loading).toBe(false);
  expect(useMcpStore.getState().error).toContain("confirmation unavailable");

  invokeMock.mockImplementation((command: string) => Promise.resolve(command === "mcp_tool_confirm" ? {} : []));
  await useMcpStore.getState().confirmTool(pending.id, false);
  expect(useMcpStore.getState().pendingInvocations).toEqual([]);
});

it("does not restore a completed approval from an older pending snapshot", async () => {
  const oldSnapshot = deferred<McpToolPendingInvocation[]>();
  const freshSnapshot = deferred<McpToolPendingInvocation[]>();
  invokeMock.mockReturnValueOnce(oldSnapshot.promise);
  const oldLoad = useMcpStore.getState().loadPendingInvocations();
  invokeMock.mockResolvedValueOnce({}).mockReturnValueOnce(freshSnapshot.promise);
  await useMcpStore.getState().confirmTool(pending.id, true);
  expect(useMcpStore.getState().pendingInvocations).toEqual([]);

  oldSnapshot.resolve([pending]);
  await oldLoad;
  expect(useMcpStore.getState().pendingInvocations).toEqual([]);
  freshSnapshot.resolve([]);
  await freshSnapshot.promise;
});
