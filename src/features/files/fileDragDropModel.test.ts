// Author: Liz
import { describe, expect, it } from "vitest";

import { resolveFileDragDropEvent } from "./fileDragDropModel";

describe("fileDragDropModel", () => {
  it("marks the drop zone active while local files hover inside it", () => {
    const zone = dropZone();

    expect(resolveFileDragDropEvent({ type: "enter", paths: ["C:/tmp/a.txt"], position: { x: 50, y: 60 } }, zone)).toEqual({
      active: true,
      kind: "hover",
    });
  });

  it("returns upload paths when files are dropped inside the panel", () => {
    const zone = dropZone();

    expect(
      resolveFileDragDropEvent({ type: "drop", paths: ["C:/tmp/a.txt", "C:/tmp/folder"], position: { x: 50, y: 60 } }, zone),
    ).toEqual({
      kind: "upload",
      paths: ["C:/tmp/a.txt", "C:/tmp/folder"],
    });
  });

  it("clears hover state on leave and ignores drops outside", () => {
    const zone = dropZone();

    expect(resolveFileDragDropEvent({ type: "leave" }, zone)).toEqual({ kind: "clear" });
    expect(resolveFileDragDropEvent({ type: "drop", paths: ["C:/tmp/a.txt"], position: { x: 500, y: 600 } }, zone)).toEqual({
      kind: "ignore",
    });
  });
});

function dropZone(): HTMLElement {
  const zone = document.createElement("div");
  zone.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 10,
      right: 110,
      bottom: 110,
      width: 100,
      height: 100,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    }) as DOMRect;
  return zone;
}
