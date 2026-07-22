// Author: Liz
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

import { TerminalReplayBuffer } from "./terminalReplay";

describe("TerminalReplayBuffer", () => {
  it("serializes a Docker-style multi-line redraw as a complete screen", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    replay.append("layer-a: Downloading [====>                    ] 17MB/105MB\r\nlayer-b: Waiting\r\nlayer-c: Waiting\r\n");
    replay.append("\x1b[3A\x1b[2K\rlayer-a: Downloading [=======>                 ] 28MB/105MB\r\n\x1b[2K\rlayer-b: Downloading [==>                     ] 5MB/68MB\r\n\x1b[2K\rlayer-c: Waiting\r\n");

    await waitForTerminalParse();

    const output = await replay.replay("truncated raw output");
    expect(output.kind).toBe("screen");
    expect(output.data).toContain("layer-a: Downloading");
    expect(output.data).toContain("layer-b: Downloading");
    expect(output.data).toContain("\x1b[2J\x1b[H");

    const restored = new Terminal({ allowProposedApi: true, cols: 60, rows: 6 });
    await writeTerminal(restored, output.data);
    expect(restored.buffer.active.getLine(0)?.translateToString(true)).toContain("layer-a: Downloading");
    expect(restored.buffer.active.getLine(1)?.translateToString(true)).toContain("layer-b: Downloading");
    restored.dispose();
    replay.dispose();
  });

  it("keeps wget-style carriage-return progress on the raw replay path", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    replay.append("download 20%\rdownload 40%\r");

    await waitForTerminalParse();

    expect(await replay.replay("download 20%\rdownload 40%\r")).toEqual({
      data: "download 20%\rdownload 40%\r",
      kind: "raw",
    });
    replay.dispose();
  });

  it("keeps plain download logs on the raw replay path", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    replay.append("Fetching model shard 1\r\nFetching model shard 2\r\n");

    await waitForTerminalParse();

    expect((await replay.replay("Fetching model shard 1\r\nFetching model shard 2\r\n")).kind).toBe("raw");
    replay.dispose();
  });

  it("uses the same screen snapshot path for hf-style multi-progress updates", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    replay.append("model-00001: 20%\r\nmodel-00002: 10%\r\n");
    replay.append("\x1b[2A\rmodel-00001: 40%\r\nmodel-00002: 30%\r\n");

    await waitForTerminalParse();

    expect((await replay.replay("truncated raw output")).kind).toBe("screen");
    replay.dispose();
  });
});

async function waitForTerminalParse() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function writeTerminal(terminal: Terminal, data: string) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}
