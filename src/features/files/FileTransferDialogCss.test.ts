import { describe, expect, it } from "vitest";

import css from "../../index.css?raw";

function ruleBody(selector: string) {
  const match = css.replace(/\r\n/g, "\n").match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("file transfer dialog styles", () => {
  it("scales with the application viewport while preserving safe margins", () => {
    const styles = ruleBody(".zt-file-transfer-dialog");

    expect(styles).toContain("width: min(82vw, calc(100vw - 96px))");
    expect(styles).toContain("height: min(87vh, calc(100vh - 96px))");
    expect(styles).not.toContain("1180px");
    expect(styles).not.toContain("780px");
  });

  it("uses an opaque surface so the terminal cannot show through", () => {
    const styles = ruleBody(".zt-file-transfer-dialog");

    expect(styles).toContain("background: var(--zt-bg-surface)");
    expect(styles).toContain("backdrop-filter: none");
    expect(styles).toContain("-webkit-backdrop-filter: none");
  });

  it("presents the conflict policy as a cohesive title-bar control", () => {
    const header = ruleBody(".zt-file-transfer-dialog .zt-dialog-header");
    const title = ruleBody(".zt-file-transfer-dialog-title");
    const control = ruleBody(".zt-file-transfer-policy");
    const label = ruleBody(".zt-file-transfer-policy-label");
    const selector = ruleBody(".zt-file-transfer-policy .zt-select-trigger");

    expect(header).toContain("min-height: var(--zt-dialog-header-height)");
    expect(title).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(title).toContain("align-items: center");
    expect(control).toContain("justify-self: end");
    expect(control).not.toContain("position: absolute");
    expect(control).toContain("height: 30px");
    expect(control).toContain("border: 1px solid var(--zt-border)");
    expect(control).toContain("background: var(--zt-bg-input)");
    expect(label).toContain("border-right: 1px solid var(--zt-border-subtle)");
    expect(label).toContain("color: var(--zt-text-primary)");
    expect(label).toContain("font-weight: 500");
    expect(selector).toContain("width: 128px");
    expect(selector).toContain("border: 0");
  });

  it("reserves one third of the panel for expanded transfer tasks and separates their header", () => {
    expect(css).toContain("grid-template-rows: minmax(0, 2fr) auto var(--zt-transfer-dock-height, minmax(120px, 1fr))");
    expect(css).toContain(".zt-file-transfer-panel-transfer-collapsed");
    expect(css).not.toContain(".zt-file-transfer-panel:has(.zt-transfer-dock-collapsed)");
    expect(ruleBody(".zt-transfer-dock-resizer")).toContain("cursor: ns-resize");
    expect(ruleBody(".zt-transfer-dock-header")).toContain("background: var(--zt-bg-elevated)");
  });

  it("scrolls the transfer task list vertically when it exceeds the dock", () => {
    const ruleStart = css.lastIndexOf("\n.zt-transfer-list {");
    const styles = css.slice(ruleStart, css.indexOf("}", ruleStart));
    const groupStyles = ruleBody(".zt-transfer-group");

    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(styles).toContain("display: flex");
    expect(styles).toContain("flex-direction: column");
    expect(styles).toContain("min-height: 0");
    expect(styles).toContain("overflow-x: hidden");
    expect(styles).toContain("overflow-y: auto");
    expect(styles).toContain("scrollbar-gutter: stable");
    expect(groupStyles).toContain("flex: 0 0 auto");
    expect(ruleBody(".zt-transfer-list > .zt-transfer-row")).toContain("flex: 0 0 auto");
  });

  it("keeps file lists and the transfer dock in their flexible grid rows when status messages are absent", () => {
    expect(css).toContain(".zt-file-transfer-operation-status");
    expect(css).toContain(".zt-file-transfer-pane-status");
    expect(ruleBody(".zt-file-transfer-pane")).toContain("grid-template-rows: 36px 34px auto 30px minmax(0, 1fr)");
  });

  it("aligns resizable file headers and rows with shared column proportions", () => {
    const pane = ruleBody(".zt-file-transfer-pane");
    const header = ruleBody(".zt-file-transfer-list-header");
    const row = ruleBody(".zt-file-transfer-dialog .zt-file-transfer-list button");
    const resizer = ruleBody(".zt-file-transfer-column-resizer");

    expect(pane).toContain("--zt-file-name-fr: 70");
    expect(pane).toContain("--zt-file-size-fr: 15");
    expect(pane).toContain("--zt-file-modified-fr: 15");
    expect(header).toContain("grid-template-columns: var(--zt-file-transfer-columns)");
    expect(row).toContain("grid-template-columns: var(--zt-file-transfer-columns)");
    expect(resizer).toContain("cursor: col-resize");
    expect(resizer).toContain("touch-action: none");
  });

  it("uses one pane inset for endpoint, path, header, and file row edges", () => {
    const pane = ruleBody(".zt-file-transfer-pane");
    const endpoint = ruleBody(".zt-file-transfer-pane-header");
    const path = ruleBody(".zt-file-transfer-path");
    const list = ruleBody(".zt-file-transfer-list");
    const header = ruleBody(".zt-file-transfer-list-header");
    const row = ruleBody(".zt-file-transfer-dialog .zt-file-transfer-list button");

    expect(pane).toContain("--zt-file-transfer-pane-inset: var(--zt-dialog-inline-inset)");
    expect(endpoint).toContain("padding: 4px var(--zt-file-transfer-pane-inset)");
    expect(path).toContain("padding: 4px var(--zt-file-transfer-pane-inset)");
    expect(list).toContain("padding: 6px var(--zt-file-transfer-pane-inset)");
    expect(header).toContain("margin: 0 var(--zt-file-transfer-pane-inset)");
    expect(header).toContain("padding: 0");
    expect(row).toContain("padding: 0");
  });

  it("left-aligns file columns and clips long values within their own grid tracks", () => {
    const sortButton = ruleBody(".zt-file-transfer-sort-button");
    const values = ruleBody(".zt-file-transfer-dialog .zt-file-transfer-list strong,\n.zt-file-transfer-dialog .zt-file-transfer-list small");

    expect(sortButton).toContain("justify-content: flex-start");
    expect(css).not.toContain(".zt-file-transfer-column-header.is-numeric .zt-file-transfer-sort-button");
    expect(values).toContain("justify-self: stretch");
    expect(values).toContain("min-width: 0");
    expect(values).toContain("max-width: 100%");
    expect(values).toContain("overflow: hidden");
    expect(values).toContain("text-overflow: ellipsis");
    expect(values).toContain("text-align: left");
  });

  it("keeps transfer errors in the dialog flow instead of overlaying adjacent content", () => {
    const styles = ruleBody(".zt-inline-error");

    expect(styles).toContain("display: grid");
    expect(styles).toContain("position: static");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).not.toContain("position: absolute");
    expect(ruleBody(".zt-file-transfer-error")).toContain("max-height: 72px");
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

  it("aligns the compact drive picker with file icons", () => {
    const selector = ".zt-file-transfer-path-with-root";
    const ruleStart = css.indexOf(selector);
    const localPathRule = css.slice(ruleStart, css.indexOf("}", ruleStart));

    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(css).toContain(".zt-file-transfer-root-select.zt-select-trigger");
    expect(localPathRule).toContain(
      "grid-template-columns: 48px minmax(0, 1fr) repeat(3, 26px)",
    );
    expect(localPathRule).not.toContain("padding-left:");
    const rootSelectRule = css.slice(
      css.indexOf(".zt-file-transfer-dialog .zt-file-transfer-path .zt-file-transfer-root-select.zt-select-trigger"),
      css.indexOf("}", css.indexOf(".zt-file-transfer-dialog .zt-file-transfer-path .zt-file-transfer-root-select.zt-select-trigger")),
    );
    expect(rootSelectRule).toContain("width: 48px");
    expect(rootSelectRule).toContain("min-width: 48px");
    expect(rootSelectRule).toContain("justify-content: flex-start");
    expect(rootSelectRule).toContain("padding-left: 5px");
    expect(ruleBody(".zt-file-transfer-root-select .zt-select-chevron")).toContain("right: 4px");
    expect(css).not.toContain(".zt-file-transfer-path:has(.zt-file-transfer-root-select)");
  });
});
