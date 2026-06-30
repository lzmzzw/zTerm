// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useAppTextInputDialog } from "./useAppTextInputDialog";

const cleanupFns: Array<() => void> = [];

describe("useAppTextInputDialog", () => {
  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) {
      cleanup();
    }
  });

  it("creates a dialog request and resolves the submitted value", async () => {
    const { api, rootElement } = renderHookHarness();
    let result: Promise<string | null> | null = null;

    act(() => {
      result = api.current.requestTextInput({
        title: "新建工作区",
        label: "工作区名称",
        initialValue: "默认名称",
        requiredMessage: "请填写工作区名称",
      });
    });

    expect(rootElement.dataset.id).toBe("1");
    expect(rootElement.dataset.title).toBe("新建工作区");
    expect(rootElement.dataset.initialValue).toBe("默认名称");

    act(() => {
      api.current.resolveTextInputDialog("生产环境");
    });

    await expect(result).resolves.toBe("生产环境");
    expect(rootElement.dataset.id).toBe("");
  });

  it("resolves null when the dialog is cancelled", async () => {
    const { api, rootElement } = renderHookHarness();
    let result: Promise<string | null> | null = null;

    act(() => {
      result = api.current.requestTextInput({
        title: "上传",
        label: "本地上传路径",
        requiredMessage: "请填写本地上传路径",
      });
    });

    expect(rootElement.dataset.id).toBe("1");

    act(() => {
      api.current.resolveTextInputDialog(null);
    });

    await expect(result).resolves.toBeNull();
    expect(rootElement.dataset.id).toBe("");
  });
});

function renderHookHarness() {
  const api: { current: ReturnType<typeof useAppTextInputDialog> } = {
    current: null as unknown as ReturnType<typeof useAppTextInputDialog>,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<HookHarness api={api} />);
  });

  cleanupFns.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  return {
    api,
    rootElement: container.firstElementChild as HTMLElement,
  };
}

function HookHarness({ api }: { api: { current: ReturnType<typeof useAppTextInputDialog> } }): ReactElement {
  const hook = useAppTextInputDialog();
  api.current = hook;

  return (
    <section
      data-id={hook.textInputDialog?.id ?? ""}
      data-title={hook.textInputDialog?.title ?? ""}
      data-initial-value={hook.textInputDialog?.initialValue ?? ""}
    />
  );
}
