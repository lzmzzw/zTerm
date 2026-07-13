// Author: Liz
import { describe, expect, it } from "vitest";

import css from "../../index.css?raw";

function ruleBody(selector: string) {
  const match = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function ruleBodiesForSelector(selector: string) {
  const bodies: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(css))) {
    const selectors = match[1].split(",").map((item) => item.trim());
    if (selectors.includes(selector)) {
      bodies.push(match[2]);
    }
  }

  return bodies.join("\n");
}

function expectBorderlessIconButton(selector: string) {
  const styles = ruleBodiesForSelector(selector);
  const hoverStyles = ruleBodiesForSelector(`${selector}:hover`);

  expect(styles).toContain("border: 0");
  expect(styles).not.toContain("border: 1px");
  expect(hoverStyles).not.toContain("border-color");
}

describe("split pane css direction mapping", () => {
  it("maps horizontal split panes to side-by-side columns", () => {
    expect(ruleBody(".zt-split-pane-horizontal")).toContain("grid-template-columns");
  });

  it("maps vertical split panes to stacked rows", () => {
    expect(ruleBody(".zt-split-pane-vertical")).toContain("grid-template-rows");
  });

  it("keeps a small bottom breathing room around the terminal work area", () => {
    const mainStyles = ruleBodiesForSelector(".zt-main");

    expect(mainStyles).toContain("padding: 0 0 6px");
  });

  it("removes inactive workspace layers from the compositor while keeping the active layer visible", () => {
    const layerStyles = ruleBodiesForSelector(".zt-workspace-stage-layer");
    const activeLayerStyles = ruleBodiesForSelector(".zt-workspace-stage-layer.active");

    expect(layerStyles).toContain("display: none");
    expect(layerStyles).toContain("visibility: hidden");
    expect(activeLayerStyles).toContain("display: grid");
    expect(activeLayerStyles).toContain("visibility: visible");
  });

  it("keeps rail icons, side panel headers, and compact terminal pane headers consistently sized", () => {
    const leftRailStyles = ruleBodiesForSelector(".zt-left-rail");
    const toolRailStyles = ruleBodiesForSelector(".zt-tool-rail");
    const railButtonStyles = ruleBodiesForSelector(".zt-left-rail button");
    const panelHeaderStyles = ruleBodiesForSelector(".zt-panel-header");
    const frameStyles = ruleBodiesForSelector(".zt-terminal-frame");
    const paneTabsStyles = ruleBodiesForSelector(".zt-pane-tabs");
    const paneTablistStyles = ruleBodiesForSelector(".zt-pane-tablist");
    const terminalToolbarStyles = ruleBodiesForSelector(".zt-terminal-toolbar");

    expect(leftRailStyles).toContain("padding: 2px 6px 8px");
    expect(toolRailStyles).toContain("padding: 2px 6px 8px");
    expect(railButtonStyles).toContain("height: 28px");
    expect(panelHeaderStyles).toContain("height: 32px");
    expect(frameStyles).toContain("grid-template-rows: 32px 1fr");
    expect(paneTabsStyles).toContain("height: 32px");
    expect(paneTablistStyles).toContain("align-items: center");
    expect(paneTablistStyles).toContain("padding: 0 6px");
    expect(terminalToolbarStyles).toContain("height: 32px");
    expect(terminalToolbarStyles).toContain("padding: 0 12px 0 10px");
  });

  it("keeps compact terminal header controls vertically centered inside the 32px header", () => {
    const paneTabStyles = ruleBodiesForSelector(".zt-pane-tab");
    const paneTabIconStyles = ruleBodiesForSelector(".zt-pane-tab-icon");
    const terminalToolbarButtonStyles = ruleBodiesForSelector(".zt-terminal-toolbar button");
    const panelHeaderActionButtonStyles = ruleBodiesForSelector(".zt-panel-header-action button");

    expect(paneTabStyles).toContain("height: 24px");
    expect(paneTabIconStyles).toContain("height: 24px");
    expect(terminalToolbarButtonStyles).toContain("height: 24px");
    expect(panelHeaderActionButtonStyles).toContain("height: 24px");
    expect(paneTabIconStyles).toContain("align-items: center");
    expect(terminalToolbarButtonStyles).toContain("align-items: center");
    expect(panelHeaderActionButtonStyles).toContain("align-items: center");
  });

  it("uses neutral selected surfaces instead of blue-green highlights", () => {
    expect(css).toContain("--zt-surface-selected: rgb(255 255 255 / 0.12)");
    expect(css).toContain("--zt-accent-muted: rgb(255 255 255 / 0.1)");
    expect(css).toContain("--zt-focus-soft: rgb(255 255 255 / 0.18)");
    expect(css).not.toContain("100 210 255");

    expect(css).toContain("--zt-surface-selected: rgb(0 0 0 / 0.075)");
    expect(css).toContain("--zt-accent-muted: rgb(0 0 0 / 0.07)");
    expect(css).toContain("--zt-focus-soft: rgb(0 0 0 / 0.13)");
    expect(css).not.toContain("10 132 255");
  });

  it("renders terminal frames as small-radius rounded rectangles", () => {
    const frameStyles = ruleBodiesForSelector(".zt-terminal-frame");

    expect(frameStyles).toContain("border-radius: var(--zt-radius-pane)");
    expect(frameStyles).toContain("overflow: hidden");
    expect(frameStyles).not.toContain("border-radius: var(--zt-radius-window)");
  });

  it("draws a restrained kerminal-like border around the active pane", () => {
    const activePaneStyles = ruleBodiesForSelector(".zt-terminal-frame.active");

    expect(activePaneStyles).toContain("border-color: var(--zt-pane-active-border)");
    expect(activePaneStyles).toContain("outline: 1px solid var(--zt-pane-active-outline)");
    expect(activePaneStyles).toContain("outline-offset: -1px");
    expect(activePaneStyles).toContain("box-shadow: inset 0 0 0 1px var(--zt-line-hairline)");
    expect(activePaneStyles).not.toContain("rgba(255, 255, 255, 0.72)");
    expect(activePaneStyles).not.toContain("var(--zt-focus-soft)");
    expect(activePaneStyles).not.toContain("var(--zt-accent)");
  });

  it("preserves a low contrast active surface for the current pane tab", () => {
    const activeTabStyles = ruleBodiesForSelector(".zt-pane-tab.active");

    expect(activeTabStyles).toContain("border-color: var(--zt-border-strong)");
    expect(activeTabStyles).toContain("background: var(--zt-bg-active)");
    expect(activeTabStyles).not.toContain("var(--zt-accent)");
    expect(activeTabStyles).not.toContain("rgba(255, 255, 255, 0.28)");
  });

  it("draws a subtle visible divider line for every split without shrinking the drag target", () => {
    const dividerStyles = ruleBodiesForSelector(".zt-split-divider");
    const dividerLineStyles = ruleBodiesForSelector(".zt-split-divider::after");
    const horizontalDividerLineStyles = ruleBodiesForSelector(".zt-split-pane-horizontal > .zt-split-divider::after");
    const verticalDividerLineStyles = ruleBodiesForSelector(".zt-split-pane-vertical > .zt-split-divider::after");

    expect(ruleBody(".zt-split-pane-horizontal")).toContain(
      "grid-template-columns: minmax(0, var(--zt-split-ratio)) 4px minmax(0, 1fr)",
    );
    expect(ruleBody(".zt-split-pane-vertical")).toContain(
      "grid-template-rows: minmax(0, var(--zt-split-ratio)) 4px minmax(0, 1fr)",
    );
    expect(dividerStyles).toContain("background: transparent");
    expect(dividerStyles).toContain("touch-action: none");
    expect(dividerStyles).toContain("user-select: none");
    expect(dividerLineStyles).toContain('content: ""');
    expect(dividerLineStyles).toContain("background: var(--zt-pane-divider)");
    expect(horizontalDividerLineStyles).toContain("width: 1px");
    expect(horizontalDividerLineStyles).toContain("height: 100%");
    expect(verticalDividerLineStyles).toContain("width: 100%");
    expect(verticalDividerLineStyles).toContain("height: 1px");
    expect(ruleBodiesForSelector(".zt-split-divider::before")).toBe("");
    expect(ruleBodiesForSelector(".zt-split-pane-horizontal > .zt-split-divider::before")).toBe("");
    expect(ruleBodiesForSelector(".zt-split-pane-vertical > .zt-split-divider::before")).toBe("");
  });

  it("keeps workspace preview splits faithful to saved direction and ratio", () => {
    const horizontalPreviewStyles = ruleBodiesForSelector(".zt-workspace-layout-split-horizontal");
    const verticalPreviewStyles = ruleBodiesForSelector(".zt-workspace-layout-split-vertical");

    expect(horizontalPreviewStyles).toContain(
      "grid-template-columns: minmax(0, var(--zt-workspace-preview-ratio)) 4px minmax(0, 1fr)",
    );
    expect(verticalPreviewStyles).toContain(
      "grid-template-rows: minmax(0, var(--zt-workspace-preview-ratio)) 4px minmax(0, 1fr)",
    );
    expect(horizontalPreviewStyles).not.toContain("grid-template-columns: 1fr");
  });

  it("keeps split toolbar icon buttons borderless", () => {
    const iconButtonStyles = ruleBodiesForSelector(".zt-terminal-toolbar button");
    const iconButtonHoverStyles = ruleBodiesForSelector(".zt-terminal-toolbar button:hover");

    expect(iconButtonStyles).toContain("border: 0");
    expect(iconButtonStyles).not.toContain("border: 1px");
    expect(iconButtonHoverStyles).not.toContain("border-color");
  });

  it("keeps the pane add tab icon borderless", () => {
    const addIconStyles = ruleBodiesForSelector(".zt-pane-tab-icon");

    expect(addIconStyles).toContain("border: 0");
    expect(addIconStyles).not.toContain("border: 1px");
  });

  it("keeps sidebar and tool panel icon buttons borderless", () => {
    expectBorderlessIconButton(".zt-left-rail button");
    expectBorderlessIconButton(".zt-tool-rail button");
    expectBorderlessIconButton(".zt-panel-header-action button");
    expectBorderlessIconButton(".zt-session-group-row button");
    expect(ruleBodiesForSelector(".zt-session-node-actions button")).toBe("");
    expectBorderlessIconButton(".zt-file-toolbar button");
    expectBorderlessIconButton(".zt-history-toolbar button[aria-label]");
    expectBorderlessIconButton(".zt-history-entry button");
    expectBorderlessIconButton(".zt-transfer-row button");
  });

  it("keeps xterm internal padding and viewport on the terminal background", () => {
    const terminalRootStyles = ruleBodiesForSelector(".zt-xterm-host .terminal");
    const viewportStyles = ruleBodiesForSelector(".zt-xterm-host .xterm-viewport");
    const screenStyles = ruleBodiesForSelector(".zt-xterm-host .xterm-screen");

    expect(terminalRootStyles).toContain("background: var(--zt-bg-terminal)");
    expect(viewportStyles).toContain("background-color: var(--zt-bg-terminal)");
    expect(screenStyles).toContain("background-color: var(--zt-bg-terminal)");
  });
});
