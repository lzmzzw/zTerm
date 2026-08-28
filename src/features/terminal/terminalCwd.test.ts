// Author: Liz
import { describe, expect, it } from "vitest";

import { parseOsc7Cwd, parseSimpleCdTarget } from "./terminalCwd";

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
