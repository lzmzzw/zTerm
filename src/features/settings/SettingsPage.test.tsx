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
        settings={{ ...baseSettings, ui_font_size: 17 }}
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

  it("keeps MCP tool details collapsed and groups every tool after expansion", async () => {
    const onLoadMcpTools = vi.fn().mockResolvedValue([
      {
        id: "terminal.list",
        title: "列出终端",
        description: "读取当前终端运行态摘要",
        risk_level: "low",
        requires_confirmation: false,
      },
      {
        id: "terminal.write",
        title: "写入终端",
        description: "向指定运行终端写入输入",
        risk_level: "high",
        requires_confirmation: true,
      },
      {
        id: "tool.open",
        title: "打开工具",
        description: "打开工具面板",
        risk_level: "low",
        requires_confirmation: false,
      },
      {
        id: "ssh.execute",
        title: "执行 SSH 命令",
        description: "复用 zTerm 认证执行远程命令",
        risk_level: "high",
        requires_confirmation: true,
      },
    ]);
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
        onLoadMcpTools={onLoadMcpTools}
      />,
    );

    await click(button(view.container, "MCP"));
    const detailsButton = button(view.container, "工具详情");
    expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
    expect(onLoadMcpTools).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("terminal.list");

    await click(detailsButton);
    await flushAsyncUpdates();

    expect(detailsButton.getAttribute("aria-expanded")).toBe("true");
    expect(onLoadMcpTools).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("终端 (2)");
    expect(view.container.textContent).toContain("工具 (1)");
    expect(view.container.textContent).toContain("SSH (1)");
    expect(view.container.textContent).toContain("terminal.list");
    expect(view.container.textContent).toContain("terminal.write");
    expect(view.container.textContent).toContain("tool.open");
    expect(view.container.textContent).toContain("ssh.execute");

    const search = input(view.container, "搜索 MCP 工具");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "SSH.EXECUTE");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(view.container.textContent).toContain("ssh.execute");
    expect(view.container.textContent).not.toContain("terminal.list");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "no-such-tool");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(view.container.textContent).toContain("没有匹配的工具");

    await click(detailsButton);
    await click(detailsButton);
    expect(onLoadMcpTools).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it("allows retrying a failed MCP tool load and then shows the empty state", async () => {
    const onLoadMcpTools = vi.fn()
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce([]);
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
        onLoadMcpTools={onLoadMcpTools}
      />,
    );

    await click(button(view.container, "MCP"));
    await click(button(view.container, "工具详情"));
    await flushAsyncUpdates();
    expect(view.container.textContent).toContain("工具清单加载失败：registry unavailable");

    await click(button(view.container, "重试"));
    await flushAsyncUpdates();
    expect(onLoadMcpTools).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("当前 MCP 未提供工具");

    view.unmount();
  });

  it("expires copy feedback after the latest copy and keeps it beside the copied field", async () => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = render(
      <SettingsPage settings={baseSettings} terminalProfiles={[]} shortcutDefinitions={shortcuts}
        loading={false} error={null} onClose={vi.fn()} onSaveSettings={vi.fn()} onResetSettings={vi.fn()}
        onDetectTerminalProfiles={vi.fn()} onSetDefaultTerminalProfile={vi.fn()}
        mcpStatus={{ enabled: true, endpoint: "http://localhost/sample", token: "sample-token" }} />,
    );
    try {
      await click(button(view.container, "MCP"));
      const endpoint = button(view.container, "复制 Endpoint");
      const token = button(view.container, "复制 Token");
      await click(endpoint);
      expect(endpoint.textContent).toBe("已复制");
      expect(token.textContent).toBe("复制 Token");
      expect(writeText).toHaveBeenLastCalledWith("http://localhost/sample");
      await act(async () => { vi.advanceTimersByTime(2000); });
      await click(token);
      expect(endpoint.textContent).toBe("复制 Endpoint");
      expect(token.textContent).toBe("已复制");
      expect(writeText).toHaveBeenLastCalledWith("sample-token");
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(token.textContent).toBe("已复制");
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(token.textContent).toBe("复制 Token");
      expect(view.container.querySelector(".is-copied")).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("shows a copy failure instead of a false copied state when clipboard access fails", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
    const view = render(
      <SettingsPage settings={baseSettings} terminalProfiles={[]} shortcutDefinitions={shortcuts}
        loading={false} error={null} onClose={vi.fn()} onSaveSettings={vi.fn()} onResetSettings={vi.fn()}
        onDetectTerminalProfiles={vi.fn()} onSetDefaultTerminalProfile={vi.fn()}
        mcpStatus={{ enabled: true, endpoint: "http://localhost/sample" }} />,
    );
    try {
      await click(button(view.container, "MCP"));
      await click(button(view.container, "复制 Endpoint"));
      expect(view.container.textContent).toContain("复制失败，请重试。");
      expect(view.container.querySelector(".is-copied")).toBeNull();
    } finally {
      view.unmount();
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
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
