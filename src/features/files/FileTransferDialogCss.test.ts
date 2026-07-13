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

  it("keeps file lists and the transfer dock in their flexible grid rows when status messages are absent", () => {
    expect(css).toContain(".zt-file-transfer-operation-status");
    expect(css).toContain(".zt-file-transfer-pane-status");
    expect(ruleBody(".zt-file-transfer-pane")).toContain("grid-template-rows: 36px 34px auto minmax(0, 1fr)");
  });

  it("centers a compact endpoint selector across the header without a visible side label", () => {
    expect(ruleBody(".zt-file-transfer-pane-header")).toContain("display: flex");
    expect(ruleBody(".zt-file-transfer-pane-header")).toContain("align-items: center");
    expect(css).toContain(".zt-file-transfer-pane-header .zt-select-trigger");
    expect(css).toContain("box-sizing: border-box");
    expect(css).toContain("min-height: 28px");
  });

  it("renders the pointer drag preview above the dialog without intercepting the pointer", () => {
    const preview = ruleBody(".zt-file-transfer-drag-preview");

    expect(preview).toContain("position: fixed");
    expect(preview).toContain("pointer-events: none");
    expect(css).toContain(".zt-file-transfer-drag-preview-icon");
  });

  it("uses an explicit local-endpoint selector rule for the drive picker", () => {
    const selector = '.zt-file-transfer-pane[data-local="true"] .zt-file-transfer-path';
    const ruleStart = css.indexOf(selector);
    const localPathRule = css.slice(ruleStart, css.indexOf("}", ruleStart));

    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(css).toContain(".zt-file-transfer-root-select.zt-select-trigger");
    expect(localPathRule).toContain(
      "grid-template-columns: 72px minmax(0, 1fr) repeat(3, 26px)",
    );
    const rootSelectRule = css.slice(
      css.indexOf(".zt-file-transfer-dialog .zt-file-transfer-path .zt-file-transfer-root-select.zt-select-trigger"),
      css.indexOf("}", css.indexOf(".zt-file-transfer-dialog .zt-file-transfer-path .zt-file-transfer-root-select.zt-select-trigger")),
    );
    expect(rootSelectRule).toContain("width: 72px");
    expect(rootSelectRule).toContain("min-width: 72px");
    expect(css).not.toContain(".zt-file-transfer-path:has(.zt-file-transfer-root-select)");
  });
});
