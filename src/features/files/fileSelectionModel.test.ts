// Author: Liz
import { describe, expect, it } from "vitest";

import { nextSelectedFilePaths, selectedFileEntries } from "./fileSelectionModel";
import type { FileEntry } from "./fileStore";

const entries: FileEntry[] = [
  file("/var/log/a.log"),
  file("/var/log/b.log"),
  file("/var/log/c.log"),
  file("/var/log/d.log"),
];

describe("fileSelectionModel", () => {
  it("replaces selection on a plain click", () => {
    expect(nextSelectedFilePaths(entries, ["/var/log/a.log"], "/var/log/a.log", "/var/log/c.log")).toEqual([
      "/var/log/c.log",
    ]);
  });

  it("toggles entries with ctrl or meta without losing list order", () => {
    expect(
      nextSelectedFilePaths(entries, ["/var/log/a.log", "/var/log/c.log"], "/var/log/a.log", "/var/log/b.log", {
        ctrlKey: true,
      }),
    ).toEqual(["/var/log/a.log", "/var/log/b.log", "/var/log/c.log"]);
    expect(
      nextSelectedFilePaths(entries, ["/var/log/a.log", "/var/log/b.log"], "/var/log/a.log", "/var/log/a.log", {
        metaKey: true,
      }),
    ).toEqual(["/var/log/b.log"]);
  });

  it("selects a shift range from the anchor to the clicked entry", () => {
    expect(
      nextSelectedFilePaths(entries, ["/var/log/a.log"], "/var/log/a.log", "/var/log/c.log", {
        shiftKey: true,
      }),
    ).toEqual(["/var/log/a.log", "/var/log/b.log", "/var/log/c.log"]);
  });

  it("maps selected paths back to current visible entries", () => {
    expect(selectedFileEntries(entries, ["/var/log/d.log", "/missing", "/var/log/b.log"]).map((entry) => entry.path)).toEqual([
      "/var/log/b.log",
      "/var/log/d.log",
    ]);
  });
});

function file(path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind: "file",
    size: 1,
    modified_at_ms: null,
    permissions: null,
  };
}
