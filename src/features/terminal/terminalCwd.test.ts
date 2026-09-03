// Author: Liz
import { describe, expect, it } from "vitest";

import { parseOsc7Cwd, parseSimpleCdTarget, trackTerminalInput } from "./terminalCwd";

describe("parseOsc7Cwd", () => {
  it("accepts and decodes absolute file URLs", () => {
    expect(parseOsc7Cwd("file://server/srv/My%20Files")).toBe("/srv/My Files");
    expect(parseOsc7Cwd("file:///C:/Users/Liz/My%20Files")).toBe("C:\\Users\\Liz\\My Files");
  });

  it("rejects non-file, relative, and malformed values", () => {
    expect(parseOsc7Cwd("https://example.test/tmp")).toBeNull();
    expect(parseOsc7Cwd("tmp/files")).toBeNull();
    expect(parseOsc7Cwd("file:///tmp/%ZZ")).toBeNull();
    expect(parseOsc7Cwd("file:///tmp/bad%0Apath")).toBeNull();
  });
});

describe("parseSimpleCdTarget", () => {
  it("accepts literal relative, quoted, home and absolute targets", () => {
    expect(parseSimpleCdTarget("cd logs")).toEqual({ target: "logs" });
    expect(parseSimpleCdTarget("cd ../logs")).toEqual({ target: "../logs" });
    expect(parseSimpleCdTarget("cd 'My Files'")).toEqual({ target: "My Files" });
    expect(parseSimpleCdTarget("cd")).toEqual({ target: null });
    expect(parseSimpleCdTarget("cd ~/logs")).toEqual({ target: "~/logs" });
    expect(parseSimpleCdTarget("cd /var/log")).toEqual({ target: "/var/log" });
  });

  it("does not guess for shell expressions or compound commands", () => {
    expect(parseSimpleCdTarget("cd $HOME")).toBeNull();
    expect(parseSimpleCdTarget("cd $(pwd)")).toBeNull();
    expect(parseSimpleCdTarget("cd logs && ls")).toBeNull();
    expect(parseSimpleCdTarget("cd logs; pwd")).toBeNull();
  });
});

describe("trackTerminalInput", () => {
  it("tracks character-by-character and whole-command submissions", () => {
    expect(trackTerminalInput("cd log", "s\r")).toEqual({
      buffer: "",
      submittedCommands: ["cd logs"],
    });
    expect(trackTerminalInput("", "cd /srv/app\r")).toEqual({
      buffer: "",
      submittedCommands: ["cd /srv/app"],
    });
  });

  it("handles backspace, cancellation, and CRLF without duplicate submissions", () => {
    expect(trackTerminalInput("cd logx", "\x7fs\r\n")).toEqual({
      buffer: "",
      submittedCommands: ["cd logs"],
    });
    expect(trackTerminalInput("cd unsafe", "\x03")).toEqual({
      buffer: "",
      submittedCommands: [],
    });
  });
});
