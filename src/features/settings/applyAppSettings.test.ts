// Author: Liz
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyAppSettings } from "./applyAppSettings";
import type { AppSettings } from "./settingsStore";

const originalMatchMedia = window.matchMedia;

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    language: "zhCN",
    theme: "dark",
    ui_font_size: 13,
    terminal_font_size: 14,
    default_right_tool: "agent",
    workspace_restore_strategy: "visible_first",
    shortcuts: [],
    ...overrides,
  };
}

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: "(prefers-color-scheme: light)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList),
  });
}

describe("applyAppSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete document.documentElement.dataset.ztTheme;
    document.documentElement.style.removeProperty("--zt-font-size-ui");
    document.documentElement.style.removeProperty("--zt-terminal-font-size");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it("applies explicit theme and font variables to the document root", () => {
    applyAppSettings(settings({ theme: "light", ui_font_size: 15, terminal_font_size: 17 }));

    expect(document.documentElement.dataset.ztTheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--zt-font-size-ui")).toBe("15px");
    expect(document.documentElement.style.getPropertyValue("--zt-terminal-font-size")).toBe("17px");
  });

  it("resolves system theme from light media preference", () => {
    stubMatchMedia(true);

    applyAppSettings(settings({ theme: "system" }));

    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: light)");
    expect(document.documentElement.dataset.ztTheme).toBe("light");
  });

  it("falls back to dark when system theme cannot detect light preference", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    applyAppSettings(settings({ theme: "system" }));

    expect(document.documentElement.dataset.ztTheme).toBe("dark");
  });
});
