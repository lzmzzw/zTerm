// Author: Liz
import { describe, expect, it } from "vitest";

import css from "../index.css?raw";

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
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(css))) {
    const selectors = match[1].split(",").map((item) => item.trim());
    if (selectors.includes(selector)) {
      bodies.push(match[2]);
    }
  }

  return bodies.join("\n").toLowerCase();
}

describe("global dark theme colors", () => {
  it("uses kerminal-like semantic surface and line tokens in the dark theme", () => {
    expect(rootVariable("--zt-surface-page")).toBe("#101012");
    expect(rootVariable("--zt-surface-chrome")).toBe("#111113");
    expect(rootVariable("--zt-surface-sidebar")).toBe("#101012");
    expect(rootVariable("--zt-surface-terminal")).toBe("#1f1f21");
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
    expect(rootVariable("--zt-bg-active")).toBe("var(--zt-surface-selected)");
    expect(rootVariable("--zt-border-subtle")).toBe("var(--zt-line-hairline)");
    expect(ruleBodiesForSelector(".zt-sidebar")).toContain("background: var(--zt-bg-sidebar)");
    expect(ruleBodiesForSelector(".zt-xterm-pane")).toContain("background: var(--zt-bg-terminal)");
    expect(ruleBodiesForSelector(".zt-xterm-host")).toContain("background: var(--zt-bg-terminal)");
  });

  it("uses kerminal-like light surfaces including a light terminal background", () => {
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-page")).toBe("#f5f5f7");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-chrome")).toBe("#ffffff");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-sidebar")).toBe("#f5f5f7");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-surface-terminal")).toBe("#f7f7fa");
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-line-hairline")).toBe(
      "rgb(0 0 0 / 0.08)",
    );
    expect(variableForSelector(':root[data-zt-theme="light"]', "--zt-bg-terminal")).toBe(
      "var(--zt-surface-terminal)",
    );
  });

  it("uses kerminal-like settings navigation and content surfaces", () => {
    expect(rootVariable("--zt-bg-settings-nav")).toBe("var(--zt-surface-chrome)");
    expect(rootVariable("--zt-bg-settings-content")).toBe("var(--zt-surface-page)");
    expect(ruleBodiesForSelector(".zt-settings-page-body")).toContain(
      "grid-template-columns: clamp(260px, 24%, 360px) minmax(0, 1fr)",
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

  it("keeps the left rail visible and preserves left panel content width", () => {
    expect(ruleBodiesForSelector(".zt-workbench")).toContain(
      "grid-template-columns: 300px minmax(420px, 1fr) 430px",
    );
    expect(ruleBodiesForSelector(".zt-workbench-left-collapsed")).toContain(
      "grid-template-columns: 40px minmax(420px, 1fr) 430px",
    );
    expect(ruleBodiesForSelector(".zt-workbench-right-collapsed")).toContain(
      "grid-template-columns: 300px minmax(420px, 1fr) 40px",
    );
    expect(ruleBodiesForSelector(".zt-workbench-left-collapsed.zt-workbench-right-collapsed")).toContain(
      "grid-template-columns: 40px minmax(420px, 1fr) 40px",
    );
  });

  it("keeps expanded left tool panels full height so blank areas receive context menu events", () => {
    expect(ruleBodiesForSelector(".zt-left-tool-panel")).toContain("height: 100%");
    expect(ruleBodiesForSelector(".zt-workspace-panel")).toContain("height: 100%");
    expect(ruleBodiesForSelector(".zt-model-panel")).toContain("height: 100%");
  });

  it("keeps session tree rows compact instead of stretching empty space between groups", () => {
    expect(ruleBodiesForSelector(".zt-session-tree")).toContain("align-content: start");
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
    expect(rootVariable("--zt-surface-floating")).toBe("#1c1c1e");
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

    for (const selector of [
      ".xterm-viewport",
      ".zt-select-list",
      ".zt-sidebar",
      ".zt-session-tree",
      ".zt-workspace-list",
      ".zt-file-list",
      ".zt-transfer-list",
      ".zt-history-list",
      ".zt-history-group-list",
      ".zt-ai-messages",
      ".zt-ai-tools",
      ".zt-monitor-panel",
      ".zt-model-panel-body",
    ]) {
      expect(ruleBodiesForSelector(selector)).toContain("scrollbar-width: thin");
      expect(ruleBodiesForSelector(selector)).toContain("scrollbar-color: var(--zt-scrollbar-thumb) transparent");
    }

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

  it("keeps the AI composer controls compact and anchored to the bottom", () => {
    expect(ruleBodiesForSelector(".zt-ai-panel")).toContain("height: 100%");
    expect(ruleBodiesForSelector(".zt-ai-panel")).toContain("padding: 4px 10px 6px");
    expect(ruleBodiesForSelector(".zt-ai-composer")).toContain("grid-row: -2 / -1");
    expect(ruleBodiesForSelector(".zt-ai-composer")).toContain("align-self: end");
    expect(ruleBodiesForSelector(".zt-ai-prompt textarea")).toContain("resize: none");
    expect(ruleBodiesForSelector(".zt-ai-composer-footer")).toContain("align-items: flex-end");
    expect(ruleBodiesForSelector(".zt-ai-approval-mode svg")).toContain("width: 12px");
    expect(ruleBodiesForSelector(".zt-ai-approval-mode svg")).toContain("height: 12px");
    expect(ruleBodiesForSelector(".zt-ai-approval-select.zt-select-trigger")).toContain("height: 22px");
    expect(ruleBodiesForSelector(".zt-ai-approval-select.zt-select-trigger")).toContain("font-size: 12px");
    expect(ruleBodiesForSelector(".zt-ai-send")).toContain("width: 24px");
    expect(ruleBodiesForSelector(".zt-ai-send")).toContain("height: 24px");
    expect(ruleBodiesForSelector(".zt-ai-send svg")).toContain("width: 15px");
    expect(ruleBodiesForSelector(".zt-ai-send svg")).toContain("height: 15px");
  });

  it("styles connection type icons without adding icons to ordinary section tabs", () => {
    expect(ruleBodiesForSelector(".zt-session-type-tabs button")).toContain("display: inline-flex");
    expect(ruleBodiesForSelector(".zt-session-type-tabs button svg")).toContain("width: 15px");
    expect(ruleBodiesForSelector(".zt-session-editor-nav button")).toContain("justify-content: flex-start");
    expect(ruleBodiesForSelector(".zt-session-editor-nav button svg")).toBe("");
  });
});
