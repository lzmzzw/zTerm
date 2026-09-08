// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeTauriMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/tauriClient", () => ({
  invokeTauri: invokeTauriMock,
}));

import {
  acknowledgeTerminalOutputFlow,
  beginTerminalOutputRender,
  markTerminalOutputRendered,
  openTerminalOutputFlow,
  resetTerminalOutputFlowForTest,
  waitForTerminalOutputRender,
} from "./terminalOutputFlow";

const event = {
  runtimeSessionId: "runtime-1",
  generation: 1,
  sequence: 4,
};

describe("terminalOutputFlow", () => {
  beforeEach(() => {
    invokeTauriMock.mockReset();
    invokeTauriMock.mockResolvedValue({ generation: 1 });
    resetTerminalOutputFlowForTest();
  });

  it("does not wait for a hidden terminal pane", async () => {
    await expect(waitForTerminalOutputRender(event)).resolves.toBeUndefined();
  });

  it("waits for the matching xterm write callback while a pane is mounted", async () => {
    const release = beginTerminalOutputRender(event.runtimeSessionId);
    let resolved = false;
    const waiting = waitForTerminalOutputRender(event).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    markTerminalOutputRendered({ ...event, sequence: 3 });
    await Promise.resolve();
    expect(resolved).toBe(false);
    markTerminalOutputRendered(event);
    await waiting;
    release();
  });

  it("releases pending render waits when the last pane unmounts", async () => {
    const release = beginTerminalOutputRender(event.runtimeSessionId);
    const waiting = waitForTerminalOutputRender(event);
    release();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("acknowledges only the active runtime lease", async () => {
    const release = await openTerminalOutputFlow(event.runtimeSessionId);
    await acknowledgeTerminalOutputFlow(event);
    expect(invokeTauriMock).toHaveBeenLastCalledWith("terminal_output_flow_ack", {
      runtimeSessionId: event.runtimeSessionId,
      generation: event.generation,
      sequence: event.sequence,
    });
    release();
    expect(invokeTauriMock).toHaveBeenLastCalledWith("terminal_output_flow_close", {
      runtimeSessionId: event.runtimeSessionId,
      generation: event.generation,
    });
  });
});
