// Author: Liz
import { describe, expect, it } from "vitest";

import { buildAiTerminalContext } from "./aiTerminalContextModel";

describe("buildAiTerminalContext", () => {
  it("maps the active terminal fields into the AI terminal context wire shape", () => {
    expect(
      buildAiTerminalContext({
        runtimeSessionId: "runtime-1",
        savedSessionId: "session-1",
        paneId: "pane-1",
        title: "开发机 A",
        cwd: "/srv/app",
        recentOutput: "tail output",
        activeTool: "agent",
      }),
    ).toEqual({
      runtime_session_id: "runtime-1",
      saved_session_id: "session-1",
      pane_id: "pane-1",
      title: "开发机 A",
      cwd: "/srv/app",
      recent_output_tail: "tail output",
      recent_output: "tail output",
      selected_text: null,
      input_buffer: null,
      active_tool: "agent",
    });
  });

  it("returns null when there is no active runtime to bind", () => {
    expect(
      buildAiTerminalContext({
        runtimeSessionId: null,
        savedSessionId: null,
        paneId: "pane-empty",
        title: "新建终端",
        cwd: null,
        recentOutput: "line 1\nline 2",
        activeTool: "history",
      }),
    ).toBe(null);
  });

  it("keeps recent output and recent output tail in sync", () => {
    const context = buildAiTerminalContext({
      runtimeSessionId: "runtime-1",
      savedSessionId: null,
      paneId: "pane-1",
      title: "PowerShell",
      cwd: null,
      recentOutput: "line 1\nline 2",
      activeTool: "history",
    });

    expect(context?.recent_output).toBe("line 1\nline 2");
    expect(context?.recent_output_tail).toBe(context?.recent_output);
  });

  it("uses null for unavailable optional terminal fields on a bound runtime", () => {
    expect(
      buildAiTerminalContext({
        runtimeSessionId: "runtime-1",
        savedSessionId: null,
        paneId: null,
        title: null,
        cwd: null,
        recentOutput: "",
        activeTool: null,
      }),
    ).toEqual({
      runtime_session_id: "runtime-1",
      saved_session_id: null,
      pane_id: null,
      title: null,
      cwd: null,
      recent_output_tail: "",
      recent_output: "",
      selected_text: null,
      input_buffer: null,
      active_tool: null,
    });
  });
});
