// Author: Liz
import { describe, expect, it } from "vitest";

import { globalCssEntrySource as indexCss, globalCssSource as css } from "../test/globalCssSource";

function variableForSelector(selector: string, name: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootMatch = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  const body = rootMatch?.[1] ?? "";
  const variableMatch = body.match(new RegExp(`${name}:\\s*([^;]+);`));
  return variableMatch?.[1].trim().toLowerCase() ?? "";
}

function rootVariable(name: string) {
  return variableForSelector(":root", name);
}

function ruleBodiesForSelector(selector: string) {
  const bodies: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(source))) {
    const selectors = match[1].split(",").map((item) => item.trim());
    if (selectors.includes(selector)) {
      bodies.push(match[2]);
    }
  }

  return bodies.join("\n").toLowerCase();
}

describe("global dark theme colors", () => {
  it("loads the global CSS layers in stable cascade order", () => {
    const imports = ["tokens", "primitives", "shell", "features", "responsive"].map((layer) =>
      indexCss.indexOf(`./styles/${layer}.css`),
    );
    expect(imports.every((index) => index >= 0)).toBe(true);
    expect(imports).toEqual([...imports].sort((left, right) => left - right));
  });

  it("defines shared geometry tokens for cross-module alignment", () => {
    expect(rootVariable("--zt-titlebar-height")).toBe("40px");
    expect(rootVariable("--zt-rail-width")).toBe("40px");
    expect(rootVariable("--zt-workbar-height")).toBe("36px");
    expect(rootVariable("--zt-rail-button-size")).toBe("28px");
    expect(rootVariable("--zt-rail-block-inset")).toBe("5px");
    expect(rootVariable("--zt-rail-inline-inset")).toBe("6px");
    expect(rootVariable("--zt-pane-border-width")).toBe("1px");
    expect(rootVariable("--zt-workbar-control-size")).toBe("28px");
    expect(rootVariable("--zt-font-size-caption")).toBe("11px");
    expect(rootVariable("--zt-left-sidebar-width")).toBe("300px");
    expect(rootVariable("--zt-right-sidebar-width")).toBe("430px");
    expect(rootVariable("--zt-settings-nav-width")).toBe("218px");
    expect(rootVariable("--zt-window-actions-width")).toBe("122px");
  });

  it("keeps shared typography and spinner rules single-sourced", () => {
    expect(css.match(/@keyframes\s+zt-spin/g)).toHaveLength(1);
    expect(css.match(/^\.zt-settings-status\s*\{/gm)).toHaveLength(1);
    expect(css).not.toMatch(/(^|\s)font-size:\s*(11|15)px;/m);
    expect(css).not.toContain("--zt-space-6");
  });

  it("drives aligned workbench chrome from the shared geometry tokens", () => {
    expect(ruleBodiesForSelector(".zt-workbench")).toContain(
      "grid-template-rows: var(--zt-titlebar-height) minmax(0, 1fr)",
    );
    expect(ruleBodiesForSelector(".zt-titlebar")).toContain("height: var(--zt-titlebar-height)");
    expect(ruleBodiesForSelector(".zt-titlebar-logo-slot")).toContain("width: var(--zt-rail-width)");
    expect(ruleBodiesForSelector(".zt-titlebar-navigation button")).toContain("width: 38px");
    expect(ruleBodiesForSelector(".zt-titlebar-navigation button")).toContain("height: 32px");
    expect(ruleBodiesForSelector(".zt-terminal-tools button")).toContain("width: var(--zt-workbar-control-size)");
    expect(ruleBodiesForSelector(".zt-terminal-tools button")).toContain("height: var(--zt-workbar-control-size)");

    for (const selector of [".zt-panel-header", ".zt-pane-tabs", ".zt-terminal-toolbar"]) {
      expect(ruleBodiesForSelector(selector)).toContain("height: var(--zt-workbar-height)");
    }

    expect(ruleBodiesForSelector(".zt-session-panel")).toContain(
      "border-top: var(--zt-pane-border-width) solid var(--zt-border-subtle)",
    );
    expect(ruleBodiesForSelector(".zt-terminal-frame")).toContain(
      "border: var(--zt-pane-border-width) solid transparent",
    );

    expect(ruleBodiesForSelector(".zt-terminal-toolbar button")).toContain(
      "width: var(--zt-workbar-control-size)",
    );
    expect(ruleBodiesForSelector(".zt-terminal-toolbar button")).toContain(
      "height: var(--zt-workbar-control-size)",
    );
  });

  it("keeps rail and workbar centers on the same horizontal guide", () => {
    const workbarHeight = Number.parseFloat(rootVariable("--zt-workbar-height"));
    const railButtonSize = Number.parseFloat(rootVariable("--zt-rail-button-size"));
    const railBlockInset = Number.parseFloat(rootVariable("--zt-rail-block-inset"));
    const paneBorderWidth = Number.parseFloat(rootVariable("--zt-pane-border-width"));

    expect(railBlockInset + railButtonSize / 2).toBe(paneBorderWidth + workbarHeight / 2);
  });

  it("keeps cached SSH containers directly below the loading state", () => {
    expect(ruleBodiesForSelector(".zt-container-panel")).toContain("display: flex");
    expect(ruleBodiesForSelector(".zt-container-panel")).toContain("flex-direction: column");
    expect(ruleBodiesForSelector(".zt-container-panel > .zt-tunnel-list")).toContain("flex: 1 1 0");
  });

  it("uses neutral semantic surface and line tokens in the dark theme", () => {
    expect(rootVariable("--zt-surface-page")).toBe("#191919");
    expect(rootVariable("--zt-surface-chrome")).toBe("#202020");
    expect(rootVariable("--zt-surface-sidebar")).toBe("#242424");
    expect(rootVariable("--zt-surface-terminal")).toBe("#141414");
    expect(rootVariable("--zt-line-hairline")).toBe("rgb(255 255 255 / 0.08)");
    expect(rootVariable("--zt-line-regular")).toBe("rgb(255 255 255 / 0.1)");
    expect(rootVariable("--zt-line-strong")).toBe("rgb(255 255 255 / 0.14)");
    expect(rootVariable("--zt-line-active")).toBe("rgb(255 255 255 / 0.2)");
    expect(rootVariable("--zt-radius-control")).toBe("6px");
  });

  it("keeps legacy dark theme aliases wired to the semantic tokens", () => {
    expect(rootVariable("--zt-bg-titlebar")).toBe("var(--zt-surface-chrome)");
    expect(rootVariable("--zt-bg-sidebar")).toBe("var(--zt-surface-sidebar)");
    expect(rootVariable("--zt-bg-main")).toBe("var(--zt-surface-page)");
    expect(rootVariable("--zt-bg-terminal")).toBe("var(--zt-surface-terminal)");
    expect(rootVariable("--zt-bg-hover")).toBe("var(--zt-surface-hover)");
    expect(rootVariable("--zt-bg-selected")).toBe("var(--zt-surface-selected)");
    expect(rootVariable("--zt-bg-active")).toBe("var(--zt-surface-selected)");
    expect(rootVariable("--zt-border-subtle")).toBe("var(--zt-line-hairline)");
    expect(ruleBodiesForSelector(".zt-sidebar")).toContain("background: var(--zt-bg-sidebar)");
    expect(ruleBodiesForSelector(".zt-xterm-pane")).toContain("background: var(--zt-bg-terminal)");
    expect(ruleBodiesForSelector(".zt-xterm-host")).toContain("background: var(--zt-bg-terminal)");
  });

  it("uses neutral light surfaces including a light terminal background", () => {
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-page")).toBe("#f5f5f5");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-chrome")).toBe("#f6f6f6");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-sidebar")).toBe("#ffffff");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-terminal")).toBe("#fafafa");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-line-hairline")).toBe(
      "rgb(0 0 0 / 0.08)",
    );
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-bg-terminal")).toBe(
      "var(--zt-surface-terminal)",
    );
  });

  it("uses neutral settings navigation and content surfaces", () => {
    expect(rootVariable("--zt-bg-settings-nav")).toBe("var(--zt-surface-chrome)");
    expect(rootVariable("--zt-bg-settings-content")).toBe("var(--zt-surface-page)");
    expect(ruleBodiesForSelector(".zt-settings-page-body")).toContain(
      "grid-template-columns: var(--zt-settings-nav-width) minmax(0, 1fr)",
    );
    expect(ruleBodiesForSelector(".zt-settings-page-tabs")).toContain("background: var(--zt-bg-settings-nav)");
    expect(ruleBodiesForSelector(".zt-settings-page-main")).toContain("background: var(--zt-bg-settings-content)");
    expect(ruleBodiesForSelector(".zt-settings-section")).toContain("background: var(--zt-bg-settings-content)");
    expect(ruleBodiesForSelector(".zt-settings-section")).toContain("height: 100%");
    expect(ruleBodiesForSelector(".zt-settings-section-body")).toContain("width: min(860px, 100%)");
    expect(ruleBodiesForSelector(".zt-settings-section-body")).toContain("justify-self: center");
    expect(ruleBodiesForSelector(".zt-settings-form")).toContain("grid-template-columns: 1fr");
    expect(ruleBodiesForSelector(".zt-settings-action-bar")).toContain("justify-self: center");
  });

  it("removes the collapsed left column and preserves the expanded session panel", () => {
    expect(ruleBodiesForSelector(".zt-workbench")).toContain(
      "grid-template-columns: var(--zt-left-sidebar-width) minmax(0, 1fr) var(--zt-right-sidebar-width)",
    );
    expect(ruleBodiesForSelector(".zt-workbench-left-collapsed")).toContain(
      "grid-template-columns: 0 minmax(0, 1fr) var(--zt-right-sidebar-width)",
    );
    expect(ruleBodiesForSelector(".zt-workbench-right-collapsed")).toContain(
      "grid-template-columns: var(--zt-left-sidebar-width) minmax(0, 1fr) 0",
    );
    expect(ruleBodiesForSelector(".zt-workbench-left-collapsed.zt-workbench-right-collapsed")).toContain(
      "grid-template-columns: 0 minmax(0, 1fr) 0",
    );
  });

  it("uses stable grid alignment in the file transfer header", () => {
    expect(ruleBodiesForSelector(".zt-file-transfer-dialog-title")).toContain(
      "grid-template-columns: minmax(0, 1fr) auto",
    );
    expect(ruleBodiesForSelector(".zt-file-transfer-policy")).toContain("justify-self: end");
    expect(ruleBodiesForSelector(".zt-file-transfer-policy")).not.toContain("position: absolute");
  });

  it("distinguishes selected file rows from transient hover feedback", () => {
    for (const selector of [".zt-file-list button.active", ".zt-file-transfer-list button.active"]) {
      expect(ruleBodiesForSelector(selector)).toContain("background: var(--zt-bg-selected)");
      expect(ruleBodiesForSelector(selector)).not.toContain("box-shadow");
    }
    expect(ruleBodiesForSelector(".zt-file-list button:hover")).toContain("background: var(--zt-bg-hover)");
    expect(ruleBodiesForSelector(".zt-file-transfer-list button:hover")).toContain("background: var(--zt-bg-hover)");
  });

  it("uses one neutral hover and selected hierarchy without directional accent bars", () => {
    const statePairs = [
      [".zt-tabs button:hover:not(:disabled)", ".zt-tabs button[aria-selected=\"true\"]"],
      [".zt-session-editor-nav button:hover", ".zt-session-editor-nav button[aria-current=\"page\"]"],
      [".zt-settings-page-tabs button:hover", ".zt-settings-page-tabs button[aria-selected=\"true\"]"],
    ];

    for (const [hoverSelector, selectedSelector] of statePairs) {
      expect(ruleBodiesForSelector(hoverSelector)).toContain("background: var(--zt-bg-hover)");
      expect(ruleBodiesForSelector(selectedSelector)).toContain("background: var(--zt-bg-selected)");
      expect(ruleBodiesForSelector(selectedSelector)).not.toContain("var(--zt-accent)");
    }

    expect(css).not.toContain("box-shadow: inset 2px 0 0 var(--zt-accent)");
    expect(css).not.toContain("box-shadow: inset 0 -2px 0 var(--zt-accent)");
    expect(css).not.toContain("box-shadow: inset 0 1px 0 var(--zt-accent)");
  });

  it("uses one mist-blue focus-visible ring across interactive elements", () => {
    expect(rootVariable("--zt-focus-ring")).toBe("var(--zt-accent)");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-focus-ring")).toBe(
      "var(--zt-accent)",
    );

    for (const selector of [
      "button:focus-visible",
      "a[href]:focus-visible",
      '[role="button"]:focus-visible',
      '[role="listitem"][tabindex]:focus-visible',
      '[role="tab"]:focus-visible',
      '[role="option"]:focus-visible',
    ]) {
      const body = ruleBodiesForSelector(selector);
      expect(body).toContain("outline: 2px solid var(--zt-focus-ring)");
      expect(body).toContain("outline-offset: -2px");
    }

    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = rulePattern.exec(css))) {
      if (!match[1].includes(":focus-visible")) continue;
      expect(match[2]).not.toContain("var(--zt-accent)");
    }
  });

  it("keeps expanded left tool panels full height so blank areas receive context menu events", () => {
    expect(ruleBodiesForSelector(".zt-left-tool-panel")).toContain("height: 100%");
  });

  it("uses one compact action style for panel headers and contextual toolbars", () => {
    const body = ruleBodiesForSelector(".zt-panel-action-button");
    expect(body).toContain("width: var(--zt-workbar-control-size)");
    expect(body).toContain("height: var(--zt-workbar-control-size)");
    expect(body).toContain("border: 0");
    expect(body).toContain("background: transparent");
    expect(body).toContain("color: var(--zt-text-secondary)");
    const labeled = ruleBodiesForSelector(".zt-panel-action-button-labeled");
    expect(labeled).toContain("width: auto");
    expect(labeled).toContain("white-space: nowrap");
    expect(ruleBodiesForSelector(".zt-history-group-toolbar")).toContain("justify-content: flex-end");
  });

  it("uses one target summary layout for right-side connection tools", () => {
    const summary = ruleBodiesForSelector(".zt-target-summary");
    expect(summary).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(summary).toContain("align-items: center");
    expect(ruleBodiesForSelector(".zt-target-summary strong")).toContain("text-overflow: ellipsis");
    expect(ruleBodiesForSelector(".zt-target-summary span")).toContain("text-align: left");
    expect(ruleBodiesForSelector(".zt-target-summary span")).toContain("white-space: nowrap");
    expect(ruleBodiesForSelector(".zt-target-summary-action")).toContain(
      "width: var(--zt-icon-button-default)",
    );
  });

  it("keeps session tree rows compact instead of stretching empty space between groups", () => {
    expect(ruleBodiesForSelector(".zt-session-tree")).toContain("flex-direction: column");
    expect(ruleBodiesForSelector(".zt-session-nodes")).toContain("align-content: start");
    expect(ruleBodiesForSelector(".zt-session-group ul")).toContain("align-content: start");
  });

  it("renders settings and session modals as shared floating cards", () => {
    expect(ruleBodiesForSelector(".zt-workbench-settings")).toContain("place-items: center");
    expect(rootVariable("--zt-dialog-width-large")).toBe("1180px");
    expect(ruleBodiesForSelector(".zt-settings-page")).toContain(
      "width: min(var(--zt-dialog-width-large), calc(100vw - 96px))",
    );
    expect(ruleBodiesForSelector(".zt-surface-frame")).toContain("border: 1px solid var(--zt-dialog-border)");
    expect(ruleBodiesForSelector(".zt-surface-frame")).toContain("border-radius: var(--zt-radius-window)");
    expect(ruleBodiesForSelector(".zt-surface-frame")).toContain("box-shadow: var(--zt-dialog-shadow)");
    expect(ruleBodiesForSelector(".zt-session-modal-backdrop")).toContain("place-items: center");
  });

  it("uses a shared hairline dialog border and shadow", () => {
    expect(rootVariable("--zt-dialog-border")).toBe("var(--zt-line-regular)");
    expect(rootVariable("--zt-dialog-shadow")).toContain("0 26px 72px");
    expect(ruleBodiesForSelector(".zt-surface-frame")).toContain("border: 1px solid var(--zt-dialog-border)");
    expect(ruleBodiesForSelector(".zt-surface-frame")).toContain("background: var(--zt-surface-floating)");
    expect(ruleBodiesForSelector(".zt-surface-frame")).toContain("backdrop-filter: blur(28px) saturate(160%)");
    expect(ruleBodiesForSelector(".zt-surface-frame")).toContain("box-shadow: var(--zt-dialog-shadow)");
    expect(ruleBodiesForSelector(".zt-session-context-menu")).toContain("background: var(--zt-surface-floating)");
    expect(ruleBodiesForSelector(".zt-session-context-menu")).toContain(
      "backdrop-filter: blur(28px) saturate(160%)",
    );
  });

  it("keeps floating surfaces opaque so background text cannot show through dialogs", () => {
    expect(rootVariable("--zt-surface-floating")).toBe("#292929");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-floating")).toBe("#ffffff");

    for (const selector of [".zt-surface-frame", ".zt-settings-dialog"]) {
      expect(ruleBodiesForSelector(selector)).toContain("background: var(--zt-surface-floating)");
    }
  });

  it("keeps context menus within the viewport and scrollable when their content is taller", () => {
    expect(ruleBodiesForSelector(".zt-floating-surface")).toContain("max-width: calc(100vw - 16px)");
    expect(ruleBodiesForSelector(".zt-floating-surface")).toContain("max-height: calc(100vh - 16px)");
    expect(ruleBodiesForSelector(".zt-floating-surface")).toContain("overflow-y: auto");
    expect(ruleBodiesForSelector(".zt-floating-surface")).toContain("overflow-x: hidden");
  });

  it("keeps the session editor header, body, and footer heights stable across sections", () => {
    expect(ruleBodiesForSelector(".zt-session-editor-dialog form")).toContain(
      "grid-template-rows: 52px 88px minmax(0, 1fr) auto 68px",
    );
    expect(ruleBodiesForSelector(".zt-session-editor-dialog form")).toContain("overflow: hidden");
    expect(ruleBodiesForSelector(".zt-session-editor-body")).toContain("align-items: stretch");
    expect(ruleBodiesForSelector(".zt-session-editor-fields")).toContain("align-content: start");
    expect(ruleBodiesForSelector(".zt-session-editor-fields")).toContain("overflow: auto");
    expect(ruleBodiesForSelector(".zt-session-dialog *")).toContain("scrollbar-width: none");
    expect(ruleBodiesForSelector(".zt-session-dialog *")).toContain("-ms-overflow-style: none");
    expect(ruleBodiesForSelector(".zt-session-dialog *::-webkit-scrollbar")).toContain("display: none");
    expect(ruleBodiesForSelector(".zt-session-editor-messages")).toContain("grid-row: 4");
  });

  it("keeps conservative modal chrome aligned with fixed header, body, and footer zones", () => {
    expect(ruleBodiesForSelector(".zt-session-modal-backdrop")).toContain(
      "padding: min(6vh, 48px) min(5vw, 56px)",
    );
    expect(ruleBodiesForSelector(".zt-session-dialog form")).toContain("overflow: hidden");
    expect(ruleBodiesForSelector(".zt-session-dialog header strong")).toContain("text-align: left");
    expect(ruleBodiesForSelector(".zt-session-dialog footer")).toContain("min-height: 64px");
    expect(rootVariable("--zt-dialog-inline-inset")).toBe("18px");
    expect(ruleBodiesForSelector(".zt-dialog-header")).toContain(
      "padding: 0 var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-dialog-footer")).toContain(
      "padding: 12px var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-dialog-form")).toContain(
      "padding: 16px var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-session-dialog header")).toContain(
      "padding: 0 var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-session-dialog footer")).toContain(
      "padding: 12px var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-session-type-tabs")).toContain(
      "padding: 16px var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-sync-channel-body")).toContain(
      "padding: 14px var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-transient-tunnel-dialog .zt-transient-tunnel-fields")).toContain(
      "padding: 16px var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-session-confirm-body")).toContain(
      "padding: 18px var(--zt-dialog-inline-inset)",
    );
    expect(ruleBodiesForSelector(".zt-session-group-dialog label")).toContain(
      "padding: 16px var(--zt-dialog-inline-inset) 0",
    );
    expect(rootVariable("--zt-dialog-height-large")).toBe("780px");
    expect(ruleBodiesForSelector(".zt-settings-page")).toContain(
      "height: min(var(--zt-dialog-height-large), calc(100vh - 96px))",
    );
  });

  it("uses one dark narrow scrollbar treatment for content display panes", () => {
    expect(rootVariable("--zt-scrollbar-size")).toBe("8px");
    expect(rootVariable("--zt-scrollbar-thumb")).toBe("var(--zt-border-strong)");
    expect(rootVariable("--zt-scrollbar-thumb-hover")).toBe("var(--zt-text-muted)");
    expect(ruleBodiesForSelector("::-webkit-scrollbar")).toContain("width: var(--zt-scrollbar-size)");
    expect(ruleBodiesForSelector("::-webkit-scrollbar")).toContain("height: var(--zt-scrollbar-size)");
    expect(ruleBodiesForSelector("::-webkit-scrollbar-button")).toContain("display: none");
    expect(ruleBodiesForSelector("::-webkit-scrollbar-track")).toContain("background: transparent");
    expect(ruleBodiesForSelector("::-webkit-scrollbar-thumb")).toContain(
      "background: var(--zt-scrollbar-thumb)",
    );

    expect(ruleBodiesForSelector("*")).toContain("scrollbar-width: auto");
    expect(ruleBodiesForSelector("::-webkit-scrollbar-thumb")).toContain("border: 1px solid transparent");

    expect(ruleBodiesForSelector(".xterm .xterm-scrollable-element > .scrollbar > .scra")).toContain(
      "display: none",
    );
    expect(ruleBodiesForSelector(".xterm .xterm-scrollable-element > .scrollbar .slider")).toContain(
      "background: var(--zt-scrollbar-thumb) !important",
    );
  });

  it("hides scrollbar chrome inside configuration and creation dialogs", () => {
    for (const selector of [".zt-session-dialog *", ".zt-settings-page *", ".zt-settings-dialog *"]) {
      expect(ruleBodiesForSelector(selector)).toContain("scrollbar-width: none");
      expect(ruleBodiesForSelector(selector)).toContain("-ms-overflow-style: none");
    }

    for (const selector of [
      ".zt-session-dialog *::-webkit-scrollbar",
      ".zt-settings-page *::-webkit-scrollbar",
      ".zt-settings-dialog *::-webkit-scrollbar",
    ]) {
      expect(ruleBodiesForSelector(selector)).toContain("display: none");
      expect(ruleBodiesForSelector(selector)).toContain("width: 0");
      expect(ruleBodiesForSelector(selector)).toContain("height: 0");
    }
  });

  it("keeps Agent approval controls compact", () => {
    expect(ruleBodiesForSelector(".zt-ai-approval-mode svg")).toContain("width: 12px");
    expect(ruleBodiesForSelector(".zt-ai-approval-mode svg")).toContain("height: 12px");
    expect(ruleBodiesForSelector(".zt-ai-approval-select.zt-select-trigger")).toContain("height: 22px");
    expect(ruleBodiesForSelector(".zt-ai-approval-select.zt-select-trigger")).toContain("font-size: 12px");
  });

  it("styles connection type icons without adding icons to ordinary section tabs", () => {
    expect(ruleBodiesForSelector(".zt-session-type-tabs button")).toContain("display: inline-flex");
    expect(ruleBodiesForSelector(".zt-session-type-tabs button svg")).toContain("width: 15px");
    expect(ruleBodiesForSelector(".zt-session-editor-nav button")).toContain("justify-content: flex-start");
    expect(ruleBodiesForSelector(".zt-session-editor-nav button svg")).toBe("");
  });
});
