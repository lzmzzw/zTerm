import { describe, expect, it } from "vitest";

import { resolveContextMenuPosition } from "./contextMenuPosition";

describe("resolveContextMenuPosition", () => {
  it("keeps a bottom-right context menu inside the viewport", () => {
    expect(
      resolveContextMenuPosition({
        anchor: { x: 990, y: 790 },
        menu: { width: 180, height: 120 },
        viewport: { width: 1000, height: 800 },
      }),
    ).toEqual({ left: 812, top: 672 });
  });

  it("keeps the menu inset when the pointer is outside the top-left edge", () => {
    expect(
      resolveContextMenuPosition({
        anchor: { x: -20, y: -10 },
        menu: { width: 180, height: 120 },
        viewport: { width: 1000, height: 800 },
      }),
    ).toEqual({ left: 8, top: 8 });
  });

  it("pins oversized menus to the viewport gutter", () => {
    expect(
      resolveContextMenuPosition({
        anchor: { x: 320, y: 240 },
        menu: { width: 1200, height: 900 },
        viewport: { width: 1000, height: 800 },
      }),
    ).toEqual({ left: 8, top: 8 });
  });
});
