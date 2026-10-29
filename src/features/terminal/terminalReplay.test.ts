// Author: Liz
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

import { TerminalReplayBuffer } from "./terminalReplay";

describe("TerminalReplayBuffer", () => {
  it("restores Vim mouse tracking and its negotiated encoding across tab replay", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    const restored = new Terminal({ allowProposedApi: true, cols: 60, rows: 6 });
    try {
      await replay.append("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?1hvim");
      const output = await replay.replay("");
      await writeTerminal(restored, output.data);
      expect(restored.modes.mouseTrackingMode).toBe("drag");
      expect(restored.modes.applicationCursorKeysMode).toBe(true);
      expect(output.data).toContain("\x1b[?1006h");
      await replay.append("\x1b[?1006l\x1b[?1002l\x1b[?1049l\x1b[?1l");
      const shell = await replay.replay("");
      await writeTerminal(restored, shell.data);
      expect(restored.modes.mouseTrackingMode).toBe("none");
      expect(restored.modes.applicationCursorKeysMode).toBe(false);
      expect(shell.data).not.toContain("\x1b[?1006h");
    } finally {
      replay.dispose();
      restored.dispose();
    }
  });

  it.each([47, 1047, 1049])("restores both screens so exiting a replayed editor (mode %s) reveals the shell", async (mode) => {
    const replay = new TerminalReplayBuffer(60, 6);
    const restored = new Terminal({ allowProposedApi: true, cols: 60, rows: 6 });
    try {
      await replay.append("shell history\r\nuser@host:~$ vim sample.txt");
      await replay.append(`\x1b[?${mode}h\x1b[2J\x1b[Heditor file contents\r\nsecond file line`);
      // Switching to another tab and back rebuilds the visible terminal from replay.
      const output = await replay.replay("truncated raw output");
      await writeTerminal(restored, output.data);
      expect(restored.buffer.active.type).toBe("alternate");
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("editor file contents");
      // A later visit can replay into a terminal that is already in alternate mode.
      await replay.append("\x1b[2;1Hupdated editor line");
      await writeTerminal(restored, (await replay.replay("truncated raw output")).data);
      expect(restored.buffer.active.type).toBe("alternate");
      expect(restored.buffer.active.getLine(1)?.translateToString(true)).toBe("updated editor line");
      await writeTerminal(restored, `\x1b[?${mode}l\r\nuser@host:~$ `);
      expect(restored.buffer.active.type).toBe("normal");
      const screen = Array.from({ length: restored.rows }, (_, row) => restored.buffer.active.getLine(row)?.translateToString(true)).join("\n");
      expect(screen).toContain("shell history");
      expect(screen).toContain("user@host:~$ ");
      expect(screen).not.toContain("editor file contents");
      expect(screen).not.toContain("second file line");
      expect(screen).not.toContain("updated editor line");
    } finally {
      restored.dispose();
      replay.dispose();
    }
  });

  it("recognizes alternate-screen entry split across output chunks without a redraw", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    try {
      const writes = [replay.append("shell\x1b[?10"), replay.append("49heditor")];
      const output = await replay.replay("truncated raw output");
      await Promise.all(writes);
      expect(output.kind).toBe("screen");
      expect(output.data).toContain("editor");
    } finally {
      replay.dispose();
    }
  });

  it("replays the shell when the editor exits while its tab is inactive", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    const restored = new Terminal({ allowProposedApi: true, cols: 60, rows: 6 });
    try {
      await replay.append("shell history\r\nuser@host:~$ vim sample.txt");
      await replay.append("\x1b[?1049h\x1b[2J\x1b[Heditor file contents");
      await writeTerminal(restored, (await replay.replay("")).data);
      await replay.append("\x1b[?1049l\r\nuser@host:~$ ");
      await writeTerminal(restored, (await replay.replay("")).data);
      expect(restored.buffer.active.type).toBe("normal");
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("shell history");
      expect(restored.buffer.active.getLine(2)?.translateToString(true)).toBe("user@host:~$ ");
    } finally {
      restored.dispose();
      replay.dispose();
    }
  });

  it("serializes a Docker-style multi-line redraw as a complete screen", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    await Promise.all([
      replay.append("layer-a: Downloading [====>                    ] 17MB/105MB\r\nlayer-b: Waiting\r\nlayer-c: Waiting\r\n"),
      replay.append("\x1b[3A\x1b[2K\rlayer-a: Downloading [=======>                 ] 28MB/105MB\r\n\x1b[2K\rlayer-b: Downloading [==>                     ] 5MB/68MB\r\n\x1b[2K\rlayer-c: Waiting\r\n"),
    ]);

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
    await replay.append("download 20%\rdownload 40%\r");

    expect(await replay.replay("download 20%\rdownload 40%\r")).toEqual({
      data: "download 20%\rdownload 40%\r",
      kind: "raw",
    });
    replay.dispose();
  });

  it("keeps plain download logs on the raw replay path", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    await replay.append("Fetching model shard 1\r\nFetching model shard 2\r\n");

    expect((await replay.replay("Fetching model shard 1\r\nFetching model shard 2\r\n")).kind).toBe("raw");
    replay.dispose();
  });

  it("uses the same screen snapshot path for hf-style multi-progress updates", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    await Promise.all([
      replay.append("model-00001: 20%\r\nmodel-00002: 10%\r\n"),
      replay.append("\x1b[2A\rmodel-00001: 40%\r\nmodel-00002: 30%\r\n"),
    ]);

    expect((await replay.replay("truncated raw output")).kind).toBe("screen");
    replay.dispose();
  });

  it("settles queued replay work when its runtime is disposed", async () => {
    const replay = new TerminalReplayBuffer(60, 6);
    const pending = replay.append("output that may still be parsing");

    replay.dispose();
    await expect(pending).resolves.toBeUndefined();
  });
});

function writeTerminal(terminal: Terminal, data: string) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}
