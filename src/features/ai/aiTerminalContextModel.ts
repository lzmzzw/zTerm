// Author: Liz
import type { AiTerminalContextSnapshot } from "./aiStore";

interface AiTerminalContextInput {
  runtimeSessionId: string | null;
  savedSessionId: string | null;
  paneId: string | null;
  title: string | null;
  cwd: string | null;
  recentOutput: string;
  activeTool: string | null;
}

export function buildAiTerminalContext(input: AiTerminalContextInput): AiTerminalContextSnapshot {
  return {
    runtime_session_id: input.runtimeSessionId,
    saved_session_id: input.savedSessionId,
    pane_id: input.paneId,
    title: input.title,
    cwd: input.cwd,
    recent_output_tail: input.recentOutput,
    recent_output: input.recentOutput,
    selected_text: null,
    input_buffer: null,
    active_tool: input.activeTool,
  };
}
