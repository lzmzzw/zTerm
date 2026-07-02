// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "./SettingsPage";
import type { AppSettings, ShortcutDefinition, TerminalProfile } from "./settingsStore";

const tauriMocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  openUrl: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: tauriMocks.getVersion,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: tauriMocks.openUrl,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: tauriMocks.relaunch,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: tauriMocks.check,
}));

const baseSettings: AppSettings = {
  language: "zhCN",
  theme: "dark",
  ui_font_size: 13,
  terminal_font_size: 13,
  default_right_tool: "agent",
  workspace_restore_strategy: "visible_first",
  mcp: { enabled: false, port: null },
  shortcuts: [],
};

const shortcuts: ShortcutDefinition[] = [
  {
    action_id: "terminal.split",
    label: "Split Pane",
    default_accelerator: "Ctrl+Shift+D",
    scope: "app",
  },
];

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender(nextUi: ReactElement) {
      act(() => root.render(nextUi));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
      document.querySelectorAll(".zt-select-popover").forEach((element) => element.remove());
    },
  };
}

function button(container: ParentNode, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

function input(container: ParentNode, label: string) {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`Input not found: ${label}`);
  return match as HTMLInputElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function keydown(element: HTMLElement, init: KeyboardEventInit) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

async function flushAsyncUpdates() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectOption(container: HTMLElement, label: string, optionText: string) {
  await click(button(container, label));
  const option = Array.from(document.querySelectorAll(".zt-select-option")).find(
    (item) => item.textContent?.trim() === optionText,
  );
  if (!option) throw new Error(`Option not found: ${optionText}`);
  await click(option as HTMLElement);
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.getVersion.mockResolvedValue("9.9.9");
  });

  it("renders visible form controls in the selected language", async () => {
    const view = render(
      <SettingsPage
        settings={{ ...baseSettings, language: "enUS" }}
        terminalProfiles={[]}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={vi.fn()}
        onResetSettings={vi.fn()}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain("Settings");
    expect(view.container.textContent).toContain("General");
    expect(view.container.textContent).toContain("Save");
    expect(view.container.textContent).not.toContain("保存通用设置");
    expect(view.container.textContent).not.toContain("Default Right Tool");

    view.unmount();
  });

  it("resets general settings through the unified action bar and refreshes the draft", async () => {
    const onResetSettings = vi.fn().mockResolvedValue(baseSettings);
    const view = render(
      <SettingsPage
        settings={{ ...baseSettings, ui_font_size: 17, workspace_restore_strategy: "layout_only" }}
        terminalProfiles={[]}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={vi.fn()}
        onResetSettings={onResetSettings}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    expect(input(view.container, "UI 字号").value).toBe("17");
    await click(button(view.container, "恢复默认"));

    expect(onResetSettings).toHaveBeenCalledWith("general");
    expect(input(view.container, "UI 字号").value).toBe("13");
    expect(button(view.container, "可见优先").textContent).toContain("可见优先");

    view.unmount();
  });

  it("saves the workspace restore strategy from general settings", async () => {
    const onSaveSettings = vi.fn().mockResolvedValue({ ...baseSettings, workspace_restore_strategy: "layout_only" });
    const view = render(
      <SettingsPage
        settings={baseSettings}
        terminalProfiles={[]}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={onSaveSettings}
        onResetSettings={vi.fn()}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    await selectOption(view.container, "工作区恢复策略", "只恢复布局");
    await click(button(view.container, "保存"));

    expect(onSaveSettings).toHaveBeenCalledWith(expect.objectContaining({ workspace_restore_strategy: "layout_only" }));
    view.unmount();
  });

  it("captures shortcut combinations and clears them with delete", async () => {
    const onSaveSettings = vi.fn();
    const view = render(
      <SettingsPage
        settings={baseSettings}
        terminalProfiles={[]}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={onSaveSettings}
        onResetSettings={vi.fn()}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    await click(button(view.container, "快捷键"));
    const shortcutInput = input(view.container, "快捷键 Split Pane");
    expect(shortcutInput.readOnly).toBe(true);

    await keydown(shortcutInput, { key: "h", ctrlKey: true, altKey: true });
    expect(shortcutInput.value).toBe("Ctrl+Alt+H");

    await keydown(shortcutInput, { key: "Delete" });
    expect(shortcutInput.value).toBe("");

    view.unmount();
  });

  it("resets shortcut settings through the unified action bar", async () => {
    const onResetSettings = vi.fn().mockResolvedValue({
      ...baseSettings,
      shortcuts: [
        {
          action_id: "terminal.split",
          accelerator: "Ctrl+Shift+D",
          scope: "app",
        },
      ],
    });
    const view = render(
      <SettingsPage
        settings={{
          ...baseSettings,
          shortcuts: [
            {
              action_id: "terminal.split",
              accelerator: "Ctrl+Alt+H",
              scope: "app",
            },
          ],
        }}
        terminalProfiles={[]}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={vi.fn()}
        onResetSettings={onResetSettings}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    await click(button(view.container, "快捷键"));
    expect(input(view.container, "快捷键 Split Pane").value).toBe("Ctrl+Alt+H");

    await click(button(view.container, "恢复默认"));

    expect(onResetSettings).toHaveBeenCalledWith("shortcuts");
    expect(input(view.container, "快捷键 Split Pane").value).toBe("Ctrl+Shift+D");

    view.unmount();
  });

  it("keeps save disabled for shortcut conflicts while allowing reset", async () => {
    const conflictDefinitions: ShortcutDefinition[] = [
      ...shortcuts,
      {
        action_id: "terminal.close",
        label: "Close Pane",
        default_accelerator: "Ctrl+Shift+W",
        scope: "app",
      },
    ];
    const conflictSettings: AppSettings = {
      ...baseSettings,
      shortcuts: [
        {
          action_id: "terminal.split",
          accelerator: "Ctrl+Shift+D",
          scope: "app",
        },
        {
          action_id: "terminal.close",
          accelerator: "Ctrl+Shift+D",
          scope: "app",
        },
      ],
    };
    const view = render(
      <SettingsPage
        settings={conflictSettings}
        terminalProfiles={[]}
        shortcutDefinitions={conflictDefinitions}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={vi.fn()}
        onResetSettings={vi.fn().mockResolvedValue(baseSettings)}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    await click(button(view.container, "快捷键"));

    expect(button(view.container, "保存").disabled).toBe(true);
    expect(button(view.container, "恢复默认").disabled).toBe(false);

    view.unmount();
  });

  it("reports detected terminal profiles including Git Bash", async () => {
    const detectedProfiles: TerminalProfile[] = [
      {
        id: "git-bash",
        name: "Git Bash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["--login", "-i"],
        detected: true,
        is_default: false,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    const onDetectTerminalProfiles = vi.fn().mockResolvedValue(detectedProfiles);
    const view = render(
      <SettingsPage
        settings={baseSettings}
        terminalProfiles={detectedProfiles}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={vi.fn()}
        onResetSettings={vi.fn()}
        onDetectTerminalProfiles={onDetectTerminalProfiles}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    await click(button(view.container, "终端"));
    expect(view.container.textContent).toContain("Git Bash");
    await click(button(view.container, "自动识别终端"));

    expect(onDetectTerminalProfiles).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("检测到 1 个终端工具");

    view.unmount();
  });

  it("renders the about page as single-line facts and opens GitHub through the system browser", async () => {
    const view = render(
      <SettingsPage
        settings={baseSettings}
        terminalProfiles={[]}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={vi.fn()}
        onResetSettings={vi.fn()}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    await click(button(view.container, "关于"));
    await flushAsyncUpdates();

    expect(view.container.textContent).toContain("v9.9.9");
    expect(view.container.textContent).not.toContain("v0.1.0");
    expect(view.container.textContent).toContain("GPL-3.0");
    expect(view.container.textContent).toContain("github.com/lzmzzw/zTerm");
    expect(view.container.textContent).not.toContain("本地智能终端工作台。");
    expect(view.container.textContent).not.toContain("Apache-2.0");
    expect(view.container.textContent).not.toContain("可检查");
    expect(view.container.textContent).not.toContain("手动检查更新。");

    await click(button(view.container, "打开"));
    expect(tauriMocks.openUrl).toHaveBeenCalledWith("https://github.com/lzmzzw/zTerm");

    view.unmount();
  });

  it("checks, downloads, installs and relaunches through the Tauri updater", async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 100 } });
      onEvent({ event: "Finished" });
    });
    tauriMocks.check.mockResolvedValue({
      version: "0.2.0",
      downloadAndInstall,
    });
    const view = render(
      <SettingsPage
        settings={baseSettings}
        terminalProfiles={[]}
        shortcutDefinitions={shortcuts}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSaveSettings={vi.fn()}
        onResetSettings={vi.fn()}
        onDetectTerminalProfiles={vi.fn()}
        onSetDefaultTerminalProfile={vi.fn()}
      />,
    );

    await click(button(view.container, "关于"));
    await click(button(view.container, "检查"));
    await flushAsyncUpdates();

    expect(tauriMocks.check).toHaveBeenCalledWith({ timeout: 30000 });
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(tauriMocks.relaunch).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("更新已安装，正在重启。");

    view.unmount();
  });
});
