// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelManagerPanel } from "./ModelManagerPanel";
import type { AiProviderProfile } from "../settings/settingsStore";

const eventListeners: Record<string, (event: { payload: unknown }) => void> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    eventListeners[eventName] = handler;
    return () => {
      delete eventListeners[eventName];
    };
  }),
}));

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function input(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`Input not found: ${label}`);
  return match as HTMLInputElement;
}

function textarea(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`Textarea not found: ${label}`);
  return match as HTMLTextAreaElement;
}

function select(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"][role="combobox"]`);
  if (!match) throw new Error(`Select not found: ${label}`);
  return match as HTMLButtonElement;
}

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function chooseSelect(container: HTMLElement, label: string, value: string) {
  await click(select(container, label));
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.getAttribute("data-value") === value,
  );
  if (!option) throw new Error(`Option not found: ${label}=${value}`);
  await click(option as HTMLElement);
}

function emitProviderTestEvent(eventName: string, payload: unknown) {
  act(() => {
    eventListeners[eventName]?.({ payload });
  });
}

const providers: AiProviderProfile[] = [
  {
    id: "provider-1",
    name: "OpenAI Compatible",
    kind: "openai_responses",
    base_url: "http://127.0.0.1:5555/v1",
    model: "gpt-test",
    api_key_ref: "credential:provider-1",
    enabled: true,
    is_default: true,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
  {
    id: "provider-2",
    name: "Anthropic Claude",
    kind: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    model: "claude-test",
    api_key_ref: "credential:provider-2",
    enabled: true,
    is_default: false,
    created_at_ms: 3,
    updated_at_ms: 4,
  },
];

describe("ModelManagerPanel", () => {
  beforeEach(() => {
    for (const eventName of Object.keys(eventListeners)) {
      delete eventListeners[eventName];
    }
  });

  it("keeps the left panel as a model list and creates/tests a draft model in a large streaming dialog", async () => {
    const onSaveProvider = vi.fn().mockResolvedValue(undefined);
    const onStartProviderDraftTest = vi.fn().mockResolvedValue({ test_id: "test-1" });
    const apiKey = "sk-model-secret";
    const view = render(
      <ModelManagerPanel
        providers={[]}
        loading={false}
        error={null}
        onSaveProvider={onSaveProvider}
        onDeleteProvider={vi.fn()}
        onStartProviderDraftTest={onStartProviderDraftTest}
        onCancelProviderDraftTest={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".zt-panel-header")?.textContent).toContain("模型");
    expect(view.container.querySelector(".zt-panel-header > svg")).toBe(null);
    expect(view.container.querySelector('[aria-label="模型配置"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="模型名称"]')).toBe(null);

    await click(button(view.container, "新增模型"));
    const dialog = view.container.querySelector('[aria-label="模型配置"]') as HTMLElement | null;
    expect(dialog).not.toBe(null);
    if (!dialog) throw new Error("Dialog should render");
    expect(dialog.classList.contains("zt-dialog-large")).toBe(true);
    expect(dialog.querySelector(".zt-model-editor-nav")).toBe(null);
    expect(dialog.querySelector(".zt-model-config-section")).not.toBe(null);
    expect(dialog.querySelector(".zt-model-test-section")).not.toBe(null);

    change(input(dialog, "模型名称"), "Local Responses");
    await chooseSelect(dialog, "协议类型", "openai_responses");
    change(input(dialog, "模型 URL"), "http://127.0.0.1:5555/v1");
    change(input(dialog, "模型标识"), "any-model");
    change(input(dialog, "API Key"), apiKey);
    change(textarea(dialog, "测试输入"), "say pong");
    expect(textarea(dialog, "测试输出").value).toBe("等待测试输出");
    await click(button(dialog, "发送测试消息"));
    emitProviderTestEvent("llm-provider-test:chunk", { test_id: "test-1", delta: "pong" });
    emitProviderTestEvent("llm-provider-test:chunk", { test_id: "test-1", delta: " from model" });
    emitProviderTestEvent("llm-provider-test:done", { test_id: "test-1", message: "模型测试通过", output: "pong from model" });
    expect(textarea(dialog, "测试输出").value).toBe("pong from model");
    expect(dialog.textContent).not.toContain(apiKey);
    await click(button(dialog, "保存模型"));

    expect(onStartProviderDraftTest).toHaveBeenCalledWith({
      prompt: "say pong",
      draft: expect.objectContaining({
        id: null,
        name: "Local Responses",
        kind: "openai_responses",
        base_url: "http://127.0.0.1:5555/v1",
        model: "any-model",
        api_key: apiKey,
        api_key_ref: null,
      }),
    });
    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        name: "Local Responses",
        api_key: apiKey,
      }),
    );
    expect(view.container.textContent).not.toContain(apiKey);
    expect(view.container.querySelector('[aria-label="模型配置"]')).toBe(null);

    view.unmount();
  });

  it("edits an existing model in a dialog while retaining its saved key when API Key is left blank", async () => {
    const onSaveProvider = vi.fn().mockResolvedValue(undefined);
    const onStartProviderDraftTest = vi.fn().mockResolvedValue({ test_id: "test-edit" });
    const view = render(
      <ModelManagerPanel
        providers={providers}
        loading={false}
        error={null}
        onSaveProvider={onSaveProvider}
        onDeleteProvider={vi.fn()}
        onStartProviderDraftTest={onStartProviderDraftTest}
        onCancelProviderDraftTest={vi.fn()}
      />,
    );

    await click(button(view.container, "编辑模型 OpenAI Compatible"));
    const dialog = view.container.querySelector('[aria-label="模型配置"]') as HTMLElement | null;
    expect(dialog).not.toBe(null);
    if (!dialog) throw new Error("Dialog should render");

    expect(input(dialog, "模型名称").value).toBe("OpenAI Compatible");
    expect(input(dialog, "API Key").value).toBe("");
    expect(view.container.textContent).not.toContain("credential:provider-1");

    change(input(dialog, "模型名称"), "OpenAI Edited");
    change(textarea(dialog, "测试输入"), "hello");
    await click(button(dialog, "发送测试消息"));
    emitProviderTestEvent("llm-provider-test:done", { test_id: "test-edit", message: "模型测试通过", output: "edited output" });
    await click(button(dialog, "保存模型"));

    expect(onStartProviderDraftTest).toHaveBeenCalledWith({
      prompt: "hello",
      draft: expect.objectContaining({
        id: "provider-1",
        name: "OpenAI Edited",
        api_key: null,
        api_key_ref: "credential:provider-1",
      }),
    });
    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "provider-1",
        name: "OpenAI Edited",
        api_key: null,
        api_key_ref: "credential:provider-1",
      }),
    );

    view.unmount();
  });

  it("shows structured backend errors when streaming draft testing fails", async () => {
    const view = render(
      <ModelManagerPanel
        providers={[]}
        loading={false}
        error={null}
        onSaveProvider={vi.fn()}
        onDeleteProvider={vi.fn()}
        onStartProviderDraftTest={vi.fn().mockResolvedValue({ test_id: "test-error" })}
        onCancelProviderDraftTest={vi.fn()}
      />,
    );

    await click(button(view.container, "新增模型"));
    const dialog = view.container.querySelector('[aria-label="模型配置"]') as HTMLElement | null;
    if (!dialog) throw new Error("Dialog should render");

    change(input(dialog, "模型名称"), "Local Responses");
    await chooseSelect(dialog, "协议类型", "openai_responses");
    change(input(dialog, "模型 URL"), "http://127.0.0.1:5555/v1");
    change(input(dialog, "模型标识"), "gpt-5");
    change(textarea(dialog, "测试输入"), "hello");
    expect(textarea(dialog, "测试输出").value).toBe("等待测试输出");
    await click(button(dialog, "发送测试消息"));
    emitProviderTestEvent("llm-provider-test:error", { test_id: "test-error", message: "LLM 响应中未找到文本内容" });

    expect(dialog.textContent).toContain("LLM 响应中未找到文本内容");
    expect(dialog.textContent).not.toContain("测试模型失败");
    expect(textarea(dialog, "测试输出").value).toBe("LLM 响应中未找到文本内容");

    view.unmount();
  });

  it("replays stream events that arrive before the test id response resolves", async () => {
    let resolveStart!: (result: { test_id: string }) => void;
    const onStartProviderDraftTest = vi.fn(
      () =>
        new Promise<{ test_id: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const view = render(
      <ModelManagerPanel
        providers={providers}
        loading={false}
        error={null}
        onSaveProvider={vi.fn()}
        onDeleteProvider={vi.fn()}
        onStartProviderDraftTest={onStartProviderDraftTest}
        onCancelProviderDraftTest={vi.fn()}
      />,
    );

    await click(button(view.container, "编辑模型 OpenAI Compatible"));
    const dialog = view.container.querySelector('[aria-label="模型配置"]') as HTMLElement | null;
    if (!dialog) throw new Error("Dialog should render");

    change(textarea(dialog, "测试输入"), "hello");
    await click(button(dialog, "发送测试消息"));
    emitProviderTestEvent("llm-provider-test:chunk", { test_id: "early-test", delta: "fast " });
    emitProviderTestEvent("llm-provider-test:done", { test_id: "early-test", message: "模型测试通过", output: "fast output" });

    await act(async () => {
      resolveStart({ test_id: "early-test" });
      await Promise.resolve();
    });

    expect(textarea(dialog, "测试输出").value).toBe("fast output");
    expect(dialog.textContent).toContain("模型测试通过");

    view.unmount();
  });

  it("sets the default model from the model list without opening the edit dialog", async () => {
    const onSaveProvider = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ModelManagerPanel
        providers={providers}
        loading={false}
        error={null}
        onSaveProvider={onSaveProvider}
        onDeleteProvider={vi.fn()}
        onStartProviderDraftTest={vi.fn()}
        onCancelProviderDraftTest={vi.fn()}
      />,
    );

    expect(view.container.textContent).toContain("OpenAI Compatible");
    expect(view.container.textContent).toContain("Anthropic Claude");
    expect(view.container.textContent).not.toContain("OpenAI Responses");
    expect(view.container.textContent).not.toContain("gpt-test");
    expect(view.container.textContent).not.toContain("API Key 已保存");

    await click(button(view.container, "设为默认模型 Anthropic Claude"));

    expect(view.container.querySelector('[aria-label="模型配置"]')).toBe(null);
    expect(onSaveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "provider-2",
        name: "Anthropic Claude",
        kind: "anthropic",
        base_url: "https://api.anthropic.com/v1",
        model: "claude-test",
        api_key: null,
        api_key_ref: "credential:provider-2",
        enabled: true,
        is_default: true,
      }),
    );

    view.unmount();
  });

  it("requires confirmation before deleting a model", async () => {
    const onDeleteProvider = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ModelManagerPanel
        providers={providers}
        loading={false}
        error={null}
        onSaveProvider={vi.fn()}
        onDeleteProvider={onDeleteProvider}
        onStartProviderDraftTest={vi.fn()}
        onCancelProviderDraftTest={vi.fn()}
      />,
    );

    await click(button(view.container, "删除模型 OpenAI Compatible"));
    expect(onDeleteProvider).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("确认删除模型“OpenAI Compatible”？");

    await click(button(view.container, "确认删除"));
    expect(onDeleteProvider).toHaveBeenCalledWith("provider-1");

    view.unmount();
  });

  it("shows only the new model action from the expanded model context menu", async () => {
    const view = render(
      <ModelManagerPanel
        providers={providers}
        loading={false}
        error={null}
        onSaveProvider={vi.fn()}
        onDeleteProvider={vi.fn()}
        onStartProviderDraftTest={vi.fn()}
        onCancelProviderDraftTest={vi.fn()}
      />,
    );

    await act(async () => {
      view.container.querySelector(".zt-model-panel")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 24 }),
      );
    });

    const menuItems = Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual(["新建模型"]);

    await click(button(view.container, "新建模型"));
    expect(view.container.querySelector('[aria-label="模型配置"]')).not.toBe(null);

    view.unmount();
  });

  it("cancels streaming draft testing, keeps partial output, and ignores late chunks", async () => {
    const onCancelProviderDraftTest = vi.fn().mockResolvedValue({ cancelled: true });
    const view = render(
      <ModelManagerPanel
        providers={providers}
        loading={false}
        error={null}
        onSaveProvider={vi.fn()}
        onDeleteProvider={vi.fn()}
        onStartProviderDraftTest={vi.fn().mockResolvedValue({ test_id: "test-cancel" })}
        onCancelProviderDraftTest={onCancelProviderDraftTest}
      />,
    );

    await click(button(view.container, "编辑模型 OpenAI Compatible"));
    const dialog = view.container.querySelector('[aria-label="模型配置"]') as HTMLElement | null;
    if (!dialog) throw new Error("Dialog should render");

    change(textarea(dialog, "测试输入"), "hello");
    await click(button(dialog, "发送测试消息"));
    emitProviderTestEvent("llm-provider-test:chunk", { test_id: "test-cancel", delta: "partial" });
    expect(button(dialog, "取消测试").classList.contains("is-cancel")).toBe(true);

    await click(button(dialog, "取消测试"));
    expect(onCancelProviderDraftTest).toHaveBeenCalledWith("test-cancel");
    emitProviderTestEvent("llm-provider-test:cancelled", { test_id: "test-cancel" });
    emitProviderTestEvent("llm-provider-test:chunk", { test_id: "test-cancel", delta: " late" });

    expect(textarea(dialog, "测试输出").value).toContain("partial");
    expect(textarea(dialog, "测试输出").value).toContain("已取消");
    expect(textarea(dialog, "测试输出").value).not.toContain("late");
    expect(button(dialog, "发送测试消息").disabled).toBe(false);

    view.unmount();
  });
});
