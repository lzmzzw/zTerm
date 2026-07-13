import { describe, expect, it } from "vitest";

import css from "../../index.css?raw";

function ruleBody(selector: string) {
  const match = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("file transfer dialog styles", () => {
  it("uses an opaque surface so the terminal cannot show through", () => {
    const styles = ruleBody(".zt-file-transfer-dialog");

    expect(styles).toContain("background: var(--zt-bg-surface)");
    expect(styles).toContain("backdrop-filter: none");
    expect(styles).toContain("-webkit-backdrop-filter: none");
  });

  it("does not apply icon-button sizing to the conflict-policy select trigger", () => {
    expect(css).toContain(".zt-file-transfer-controls > button");
    expect(css).toContain(".zt-file-transfer-dialog .zt-file-transfer-controls > button");
    expect(css).not.toContain(".zt-file-transfer-dialog .zt-file-transfer-controls button,");
  });

  it("reserves one third of the panel for expanded transfer tasks and separates their header", () => {
    expect(css).toContain("grid-template-rows: auto minmax(0, 2fr) auto var(--zt-transfer-dock-height, minmax(120px, 1fr))");
    expect(css).toContain(".zt-file-transfer-panel-transfer-collapsed");
    expect(css).not.toContain(".zt-file-transfer-panel:has(.zt-transfer-dock-collapsed)");
    expect(ruleBody(".zt-transfer-dock-resizer")).toContain("cursor: ns-resize");
    expect(ruleBody(".zt-transfer-dock-header")).toContain("background: var(--zt-bg-elevated)");
  });
});
