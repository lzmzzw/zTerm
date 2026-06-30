// Author: Liz
import { describe, expect, it } from "vitest";

import capability from "../../src-tauri/capabilities/default.json";

describe("Tauri window capability", () => {
  it("allows custom titlebar drag and window action commands for the main window", () => {
    expect(capability.windows).toContain("main");
    expect(capability.permissions).toEqual(
      expect.arrayContaining([
        "core:default",
        "core:window:allow-start-dragging",
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-close",
      ]),
    );
  });
});
