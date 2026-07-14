// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ZtButton,
  ZtAttentionRegion,
  ZtCheckbox,
  ZtDialog,
  ZtFloatingSurface,
  ZtIcon,
  ZtIconButton,
  ZtInput,
  ZtModalOverlay,
  ZtModalBackdrop,
  ZtSurfaceFrame,
  ZtSegmentedControl,
  ZtSlider,
  ZtSwitch,
  ZtTabs,
  ZtTextarea,
} from "./ZtUi";

const cleanupFns: Array<() => void> = [];

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  const view = {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  cleanupFns.push(view.unmount);
  return view;
}

function click(element: HTMLElement) {
  act(() => {
    element.click();
  });
}

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
  document.body.innerHTML = "";
});

describe("ZtUi primitives", () => {
  it("composes modal overlays and surfaces from shared frame primitives", () => {
    const view = render(
      <ZtModalOverlay>
        <ZtSurfaceFrame className="custom-surface" role="dialog" aria-label="统一外壳">
          弹窗内容
        </ZtSurfaceFrame>
      </ZtModalOverlay>,
    );

    expect(view.container.querySelector(".zt-modal-overlay")).not.toBeNull();
    expect(view.container.querySelector(".zt-dialog-backdrop")).not.toBeNull();
    expect(view.container.querySelector(".zt-surface-frame.custom-surface")).not.toBeNull();
  });

  it("marks a configured empty region for attention without reacting to its content", () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const view = render(
      <ZtAttentionRegion className="settings-region">
        <section className="settings-content">设置内容</section>
      </ZtAttentionRegion>,
    );

    const region = view.container.querySelector(".settings-region") as HTMLElement;
    const content = view.container.querySelector(".settings-content") as HTMLElement;

    click(content);
    expect(region.classList.contains("is-attention")).toBe(false);

    click(region);
    expect(region.classList.contains("is-attention")).toBe(true);

    requestAnimationFrameSpy.mockRestore();
  });

  it("marks the dialog for attention when its backdrop is clicked", () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const view = render(
      <ZtModalBackdrop>
        <section role="dialog" aria-label="需要操作的弹窗">
          <button type="button">弹窗内操作</button>
        </section>
      </ZtModalBackdrop>,
    );

    const backdrop = view.container.querySelector(".zt-dialog-backdrop") as HTMLElement;
    const dialog = view.container.querySelector('[role="dialog"]') as HTMLElement;

    click(dialog.querySelector("button") as HTMLElement);
    expect(backdrop.classList.contains("is-attention")).toBe(false);

    click(backdrop);
    expect(backdrop.classList.contains("is-attention")).toBe(true);

    requestAnimationFrameSpy.mockRestore();
  });

  it("renders a consistent large dialog shell with left title and right close button", () => {
    const onClose = vi.fn();
    const view = render(
      <ZtDialog
        ariaLabel="统一弹窗"
        title="统一弹窗"
        size="large"
        footer={<ZtButton variant="primary">保存</ZtButton>}
        onClose={onClose}
      >
        <p>弹窗内容</p>
      </ZtDialog>,
    );

    const dialog = view.container.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog?.classList.contains("zt-dialog")).toBe(true);
    expect(dialog?.classList.contains("zt-dialog-large")).toBe(true);
    expect(dialog?.querySelector(".zt-dialog-title")?.textContent).toBe("统一弹窗");

    const closeButton = dialog?.querySelector('button[aria-label="关闭统一弹窗"]') as HTMLButtonElement | null;
    expect(closeButton?.classList.contains("zt-dialog-close")).toBe(true);
    expect(dialog?.querySelector(".zt-dialog-footer")?.textContent).toContain("保存");

    click(closeButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("applies shared button, icon button and icon size classes", () => {
    const view = render(
      <>
        <ZtButton size="dense" variant="danger">
          删除
        </ZtButton>
        <ZtIconButton ariaLabel="刷新" title="刷新" size="large">
          <ZtIcon name="refresh" size="default" />
        </ZtIconButton>
      </>,
    );

    const dangerButton = view.container.querySelector(".zt-button") as HTMLButtonElement | null;
    expect(dangerButton?.className).toContain("zt-button-dense");
    expect(dangerButton?.className).toContain("zt-button-danger");

    const iconButton = view.container.querySelector(".zt-icon-button") as HTMLButtonElement | null;
    expect(iconButton?.getAttribute("aria-label")).toBe("刷新");
    expect(iconButton?.getAttribute("title")).toBe("刷新");
    expect(iconButton?.className).toContain("zt-icon-button-large");
    expect(iconButton?.querySelector("svg")?.classList.contains("zt-icon-default")).toBe(true);
  });

  it("renders shared input and textarea controls with coordinated size classes", () => {
    const view = render(
      <>
        <ZtInput aria-label="名称" value="zTerm" onChange={() => undefined} />
        <ZtTextarea aria-label="描述" controlSize="dense" value="说明" onChange={() => undefined} />
      </>,
    );

    const input = view.container.querySelector(".zt-input") as HTMLInputElement | null;
    expect(input?.getAttribute("aria-label")).toBe("名称");
    expect(input?.classList.contains("zt-input-form")).toBe(true);
    expect(input?.value).toBe("zTerm");

    const textarea = view.container.querySelector(".zt-textarea") as HTMLTextAreaElement | null;
    expect(textarea?.getAttribute("aria-label")).toBe("描述");
    expect(textarea?.classList.contains("zt-textarea-dense")).toBe(true);
    expect(textarea?.value).toBe("说明");
  });

  it("keeps switch and checkbox semantics separate", () => {
    const onSwitchChange = vi.fn();
    const onCheckboxChange = vi.fn();
    const view = render(
      <>
        <ZtSwitch label="启用模型" checked={false} onChange={onSwitchChange} />
        <ZtCheckbox label="选择历史命令" checked={true} onChange={onCheckboxChange} />
      </>,
    );

    const switchInput = view.container.querySelector('input[role="switch"]') as HTMLInputElement | null;
    expect(switchInput?.checked).toBe(false);
    expect(switchInput?.classList.contains("zt-switch-input")).toBe(true);

    const checkboxInput = view.container.querySelector('input[type="checkbox"]:not([role="switch"])') as HTMLInputElement | null;
    expect(checkboxInput?.checked).toBe(true);
    expect(checkboxInput?.classList.contains("zt-checkbox-input")).toBe(true);

    click(view.container.querySelector(".zt-switch-control") as HTMLElement);
    click(view.container.querySelector(".zt-checkbox-control") as HTMLElement);

    expect(onSwitchChange).toHaveBeenCalledWith(true);
    expect(onCheckboxChange).toHaveBeenCalledWith(false);
  });

  it("renders floating surfaces, sliders, tabs and segmented controls with shared classes", () => {
    const onSliderChange = vi.fn();
    const onTabChange = vi.fn();
    const onSegmentChange = vi.fn();
    const view = render(
      <>
        <ZtFloatingSurface role="menu" style={{ left: 12, top: 16 }}>
          <button type="button" role="menuitem">
            复制
          </button>
        </ZtFloatingSurface>
        <ZtSlider ariaLabel="透明度" value={32} min={0} max={100} onChange={onSliderChange} />
        <ZtTabs
          ariaLabel="设置分类"
          value="general"
          orientation="vertical"
          onChange={onTabChange}
          items={[
            { value: "general", label: "通用" },
            { value: "shortcuts", label: "快捷键" },
          ]}
        />
        <ZtSegmentedControl
          ariaLabel="模式"
          value="history"
          onChange={onSegmentChange}
          items={[
            { value: "history", label: "历史" },
            { value: "groups", label: "指令组" },
          ]}
        />
      </>,
    );

    expect(view.container.querySelector(".zt-floating-surface")?.getAttribute("role")).toBe("menu");
    expect(view.container.querySelector(".zt-slider-input")?.getAttribute("aria-label")).toBe("透明度");
    expect(view.container.querySelector(".zt-tabs")?.getAttribute("aria-orientation")).toBe("vertical");
    expect(view.container.querySelector(".zt-segmented-control")?.getAttribute("role")).toBe("tablist");

    click(view.container.querySelector('button[aria-label="设置分类 快捷键"]') as HTMLElement);
    click(view.container.querySelector('button[aria-label="模式 指令组"]') as HTMLElement);
    act(() => {
      const slider = view.container.querySelector(".zt-slider-input") as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(slider), "value");
      descriptor?.set?.call(slider, "48");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onTabChange).toHaveBeenCalledWith("shortcuts");
    expect(onSegmentChange).toHaveBeenCalledWith("groups");
    expect(onSliderChange).toHaveBeenCalledWith(48);
  });
});
