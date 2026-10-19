// Author: Liz
import { describe, expect, it } from "vitest";

import { invokeBrowserTauri, shouldUseBrowserTauriMock } from "./browserTauriMock";

describe("browser Tauri development mock", () => {
  it("is available only in the explicit browser development mode without a Tauri runtime", () => {
    expect(shouldUseBrowserTauriMock({ dev: true, mode: "browser", hasTauriRuntime: false })).toBe(true);
    expect(shouldUseBrowserTauriMock({ dev: false, mode: "browser", hasTauriRuntime: false })).toBe(false);
    expect(shouldUseBrowserTauriMock({ dev: true, mode: "development", hasTauriRuntime: false })).toBe(false);
    expect(shouldUseBrowserTauriMock({ dev: true, mode: "browser", hasTauriRuntime: true })).toBe(false);
  });

  it("returns stable startup data for visual browser checks", async () => {
    await expect(invokeBrowserTauri("settings_get")).resolves.toMatchObject({
      language: "zhCN",
      theme: "dark",
    });
    await expect(invokeBrowserTauri("sessions_list")).resolves.toEqual({ groups: [], sessions: [] });
  });

  it("fails visibly when a browser-only flow reaches an unsupported native command", async () => {
    await expect(invokeBrowserTauri("terminal_open")).rejects.toThrow(
      "浏览器 Tauri Mock 尚未实现命令: terminal_open",
    );
  });
});
