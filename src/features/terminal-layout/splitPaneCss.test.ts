// Author: Liz
import { describe, expect, it } from "vitest";

import { globalCssSource as css } from "../../test/globalCssSource";

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

  it("reserves a layout row for terminalLayout errors instead of covering terminal content", () => {
    const mainWithError = ruleBody(".zt-main-with-error");
    const stageWithError = ruleBody(".zt-main-with-error .zt-terminal-layout-stage");

    expect(mainWithError).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(stageWithError).toContain("position: relative");
    expect(stageWithError).toContain("grid-row: 2");
  });

  it("removes inactive terminalLayout layers from the compositor while keeping the active layer visible", () => {
    const layerStyles = ruleBodiesForSelector(".zt-terminal-layout-stage-layer");
    const activeLayerStyles = ruleBodiesForSelector(".zt-terminal-layout-stage-layer.active");

    expect(layerStyles).toContain("display: none");
    expect(layerStyles).toContain("visibility: hidden");
    expect(activeLayerStyles).toContain("display: grid");
    expect(activeLayerStyles).toContain("visibility: visible");
  });

  it("keeps rail icons, side panel headers, and compact terminal pane headers consistently sized", () => {
    const toolRailStyles = ruleBodiesForSelector(".zt-terminal-tools");
    const railButtonStyles = ruleBodiesForSelector(".zt-terminal-tools button");
    const panelHeaderStyles = ruleBodiesForSelector(".zt-panel-header");
    const frameStyles = ruleBodiesForSelector(".zt-terminal-frame");
    const paneTabsStyles = ruleBodiesForSelector(".zt-pane-tabs");
    const paneTablistStyles = ruleBodiesForSelector(".zt-pane-tablist");
    const terminalToolbarStyles = ruleBodiesForSelector(".zt-terminal-toolbar");

    expect(toolRailStyles).toContain("position: absolute");
    expect(toolRailStyles).toContain("flex-direction: column");
    expect(railButtonStyles).toContain("height: var(--zt-workbar-control-size)");
    expect(panelHeaderStyles).toContain("height: var(--zt-workbar-height)");
    expect(frameStyles).toContain("grid-template-rows: var(--zt-workbar-height) 1fr");
    expect(paneTabsStyles).toContain("height: var(--zt-workbar-height)");
    expect(paneTablistStyles).toContain("align-items: center");
    expect(paneTablistStyles).toContain("padding: 0 6px");
    expect(terminalToolbarStyles).toContain("height: var(--zt-workbar-height)");
    expect(terminalToolbarStyles).toContain("padding: 0 3px 0 4px");
  });

  it("keeps compact terminal header controls vertically centered inside the 32px header", () => {
    const paneTabStyles = ruleBodiesForSelector(".zt-pane-tab");
    const paneTabIconStyles = ruleBodiesForSelector(".zt-pane-tab-icon");
    const terminalToolbarButtonStyles = ruleBodiesForSelector(".zt-terminal-toolbar button");
    const panelHeaderActionButtonStyles = ruleBodiesForSelector(".zt-panel-action-button");

    expect(paneTabStyles).toContain("height: var(--zt-workbar-control-size)");
    expect(paneTabIconStyles).toContain("height: var(--zt-workbar-control-size)");
    expect(terminalToolbarButtonStyles).toContain("height: var(--zt-workbar-control-size)");
    expect(panelHeaderActionButtonStyles).toContain("height: var(--zt-workbar-control-size)");
    expect(paneTabIconStyles).toContain("align-items: center");
    expect(terminalToolbarButtonStyles).toContain("align-items: center");
    expect(panelHeaderActionButtonStyles).toContain("align-items: center");
  });

  it("uses theme accent mixing for selected surfaces in both themes", () => {
    expect(css).toContain("--zt-surface-hover: rgb(255 255 255 / 0.07)");
    expect(css).toContain("--zt-surface-selected: color-mix(in srgb, var(--zt-accent) 16%, var(--zt-surface-elevated))");
    expect(css).toContain("--zt-accent-muted: rgb(100 169 255 / 0.1)");
    expect(css).toContain("--zt-focus-ring: var(--zt-accent)");
    expect(css).toContain("--zt-focus-soft: rgb(100 169 255 / 0.18)");
    expect(css).not.toContain("100 210 255");

    expect(css).toContain("--zt-surface-hover: rgb(0 0 0 / 0.04)");
    expect(css).toContain("--zt-surface-selected: color-mix(in srgb, var(--zt-accent) 16%, var(--zt-surface-elevated))");
    expect(css).toContain("--zt-accent-muted: rgb(8 102 207 / 0.07)");
    expect(css).toContain("--zt-focus-ring: var(--zt-accent)");
    expect(css).toContain("--zt-focus-soft: rgb(8 102 207 / 0.13)");
    expect(css).not.toContain("10 132 255");
  });

  it("renders terminal frames as small-radius rounded rectangles", () => {
    const frameStyles = ruleBodiesForSelector(".zt-terminal-frame");

    expect(frameStyles).toContain("border-radius: var(--zt-radius-pane)");
    expect(frameStyles).toContain("overflow: hidden");
    expect(frameStyles).not.toContain("border-radius: var(--zt-radius-window)");
  });

  it("keeps active pane headers neutral with a subtle pane border", () => {
    const activePaneStyles = ruleBodiesForSelector(".zt-terminal-frame.active");
    const activeIndicatorStyles = ruleBodiesForSelector(".zt-pane-active-indicator");

    expect(activePaneStyles).toBe("");
    expect(activeIndicatorStyles).toContain("display: none");
    expect(ruleBodiesForSelector(".zt-terminal-frame.active > .zt-pane-tabs")).toBe("");
    expect(ruleBodiesForSelector(".zt-terminal-frame:focus-within > .zt-pane-tabs")).toBe("");
    expect(ruleBodiesForSelector(".zt-split-pane .zt-terminal-frame.active > .zt-pane-tabs")).toContain("background: var(--zt-surface-elevated)");
    expect(ruleBodiesForSelector(".zt-pane-tabs > .zt-terminal-toolbar")).toContain("background: transparent");
    expect(activeIndicatorStyles).toContain("border-radius: 50%");
  });

  it("preserves a low contrast active surface for the current pane tab", () => {
    const activeTabStyles = ruleBodiesForSelector(".zt-pane-tab.active");

    expect(activeTabStyles).toContain("border-color: var(--zt-border-strong)");
    expect(activeTabStyles).toContain("background: var(--zt-bg-selected)");
    expect(activeTabStyles).not.toContain("var(--zt-accent)");
    expect(activeTabStyles).not.toContain("rgba(255, 255, 255, 0.28)");
  });

  it("hides split divider lines without shrinking the drag target", () => {
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
    expect(dividerLineStyles).toContain('content: none');
    expect(dividerLineStyles).toContain("background: var(--zt-pane-divider)");
    expect(horizontalDividerLineStyles).toContain("width: 1px");
    expect(horizontalDividerLineStyles).toContain("height: 100%");
    expect(verticalDividerLineStyles).toContain("width: 100%");
    expect(verticalDividerLineStyles).toContain("height: 1px");
    expect(ruleBodiesForSelector(".zt-split-divider::before")).toBe("");
    expect(ruleBodiesForSelector(".zt-split-pane-horizontal > .zt-split-divider::before")).toBe("");
    expect(ruleBodiesForSelector(".zt-split-pane-vertical > .zt-split-divider::before")).toBe("");
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
    expectBorderlessIconButton(".zt-terminal-tools button");
    expectBorderlessIconButton(".zt-panel-action-button");
    expect(ruleBodiesForSelector(".zt-session-node-actions button")).toBe("");
    expectBorderlessIconButton(".zt-file-toolbar button");
    expectBorderlessIconButton(".zt-history-entry button");
    expectBorderlessIconButton(".zt-transfer-row button");
  });

  it("keeps the session tree compact", () => {
    const treeStyles = ruleBodiesForSelector(".zt-session-tree");
    const nodeListStyles = ruleBodiesForSelector(".zt-session-nodes");
    const groupRowStyles = ruleBodiesForSelector(".zt-session-group-row");
    const sessionNodeStyles = ruleBodiesForSelector(".zt-session-node");
    const sessionButtonStyles = ruleBodiesForSelector(".zt-session-node-main");

    expect(treeStyles).toContain("gap: 2px");
    expect(treeStyles).toContain("padding: 0 6px 4px");
    expect(nodeListStyles).toContain("gap: 0");
    expect(groupRowStyles).toContain("min-height: 26px");
    expect(sessionNodeStyles).toContain("min-height: 28px");
    expect(sessionButtonStyles).toContain("min-height: 28px");
  });

  it("keeps the session search visible while scrolling and aligns its icon with group folders", () => {
    const toolbarStyles = ruleBodiesForSelector(".zt-session-toolbar");
    const searchStyles = ruleBodiesForSelector(".zt-session-search");

    expect(toolbarStyles).toContain("flex-shrink: 0");
    const nodeListStyles = ruleBodiesForSelector(".zt-session-nodes");
    expect(nodeListStyles).toContain("overflow-y: auto");
    expect(nodeListStyles).toContain("min-height: 0");
    expect(nodeListStyles).toContain("user-select: none");
    expect(toolbarStyles).toContain("padding-top: 4px");
    expect(toolbarStyles).toContain("background: var(--zt-bg-sidebar)");
    expect(searchStyles).toContain("padding: 0 0 0 5px");
    expect(searchStyles).toContain("grid-template-columns: 18px minmax(0, 1fr) 24px");
  });

  it("uses the compact session tree rhythm in connection pickers", () => {
    const groupStyles = ruleBodiesForSelector(".zt-session-picker-group");
    const optionStyles = ruleBodiesForSelector(".zt-session-picker-option");
    const selectGroupStyles = ruleBodiesForSelector(".zt-select-tree-group");
    const selectOptionStyles = ruleBodiesForSelector(".zt-select-option.zt-select-tree-option");

    expect(groupStyles).toContain("min-height: 26px");
    expect(optionStyles).toContain("min-height: 28px");
    expect(selectGroupStyles).toContain("min-height: 26px");
    expect(selectOptionStyles).toContain("min-height: 28px");
    expect(selectOptionStyles).toContain("padding-left: calc(6px + var(--zt-session-tree-depth) * 12px)");
  });

  it("keeps removed history toolbar icon button styles absent", () => {
    expect(ruleBodiesForSelector(".zt-history-toolbar button[aria-label]")).toBe("");
    expect(ruleBodiesForSelector(".zt-history-toolbar .zt-history-icon-button")).toBe("");
  });

  it("keeps one group action column and no item action column", () => {
    expect(ruleBodiesForSelector(".zt-history-group header")).toContain(
      "grid-template-columns: minmax(0, 1fr) 28px",
    );
    const itemStyles = ruleBodiesForSelector(".zt-history-group-item");
    expect(itemStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(itemStyles).not.toContain("28px");
  });

  it("keeps history and command group toolbars at the same height", () => {
    expect(ruleBodiesForSelector(".zt-history-toolbar")).toContain("padding: 5px 8px");
    expect(ruleBodiesForSelector(".zt-history-group-toolbar")).toContain("padding: 5px 8px");
  });

  it("prevents native text selection in command history rows", () => {
    const historyEntryStyles = ruleBodiesForSelector(".zt-history-entry");
    expect(historyEntryStyles).toMatch(/(?:^|\n)\s*user-select: none/);
    expect(historyEntryStyles).toContain("-webkit-user-select: none");
  });

  it("highlights selected history rows without a left accent", () => {
    const selectedStyles = ruleBodiesForSelector(".zt-history-entry.is-selected");
    expect(selectedStyles).toContain("background: var(--zt-bg-selected)");
    expect(selectedStyles).not.toContain("box-shadow");
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
