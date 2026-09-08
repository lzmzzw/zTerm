// Author: Liz
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useActiveAgentTerminalSync } from "./useActiveAgentTerminalSync";

const cleanupFns: Array<() => void> = [];

describe("useActiveAgentTerminalSync", () => {
  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) cleanup();
  });

  it("serializes target changes so an older request cannot overtake the latest runtime", async () => {
    let resolveFirst: (() => void) | undefined;
    const setActiveTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const harness = renderHarness("runtime-1", setActiveTerminal);

    await act(async () => undefined);

    harness.rerender("runtime-2");
    expect(setActiveTerminal).toHaveBeenCalledTimes(1);
    expect(setActiveTerminal).toHaveBeenLastCalledWith("runtime-1");

    await act(async () => resolveFirst?.());

    expect(setActiveTerminal).toHaveBeenCalledTimes(2);
    expect(setActiveTerminal).toHaveBeenLastCalledWith("runtime-2");
  });

  it("clears the active target after the latest synchronization fails", async () => {
    const setActiveTerminal = vi.fn().mockRejectedValueOnce(new Error("runtime unavailable")).mockResolvedValue(undefined);
    renderHarness("runtime-1", setActiveTerminal);

    await act(async () => undefined);

    expect(setActiveTerminal.mock.calls).toEqual([["runtime-1"], [null]]);
  });

  it("clears the backend target when the owner unmounts", async () => {
    const setActiveTerminal = vi.fn().mockResolvedValue(undefined);
    const harness = renderHarness("runtime-1", setActiveTerminal);

    await act(async () => undefined);
    harness.unmount();
    await act(async () => undefined);

    expect(setActiveTerminal.mock.calls).toEqual([["runtime-1"], [null]]);
  });
});

function renderHarness(runtimeSessionId: string | null, setActiveTerminal: (runtimeSessionId: string | null) => Promise<void>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  function render(nextRuntimeSessionId: string | null) {
    act(() => {
      root.render(<Harness runtimeSessionId={nextRuntimeSessionId} setActiveTerminal={setActiveTerminal} />);
    });
  }

  render(runtimeSessionId);
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  cleanupFns.push(unmount);
  return { rerender: render, unmount };
}

function Harness({
  runtimeSessionId,
  setActiveTerminal,
}: {
  runtimeSessionId: string | null;
  setActiveTerminal: (runtimeSessionId: string | null) => Promise<void>;
}) {
  useActiveAgentTerminalSync(runtimeSessionId, setActiveTerminal);
  return null;
}
