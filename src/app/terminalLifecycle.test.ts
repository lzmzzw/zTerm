// Author: Liz
import { describe, expect, it, vi } from "vitest";

import { closeTerminalRuntimes } from "./terminalLifecycle";

describe("terminalLifecycle", () => {
  it("closes every unique runtime associated with a removed pane", async () => {
    const closeTerminal = vi.fn().mockResolvedValue(undefined);

    const result = await closeTerminalRuntimes(
      ["runtime-a", "runtime-b", "runtime-a"],
      closeTerminal,
    );

    expect(closeTerminal).toHaveBeenCalledTimes(2);
    expect(closeTerminal).toHaveBeenCalledWith("runtime-a");
    expect(closeTerminal).toHaveBeenCalledWith("runtime-b");
    expect(result).toEqual({
      closedRuntimeSessionIds: ["runtime-a", "runtime-b"],
      failedReason: null,
    });
  });

  it("reports a partial close failure without hiding successfully closed runtimes", async () => {
    const closeTerminal = vi.fn(async (runtimeSessionId: string) => {
      if (runtimeSessionId === "runtime-b") throw new Error("close failed");
    });

    const result = await closeTerminalRuntimes(["runtime-a", "runtime-b"], closeTerminal);

    expect(result.closedRuntimeSessionIds).toEqual(["runtime-a"]);
    expect(result.failedReason).toEqual(new Error("close failed"));
  });
});
