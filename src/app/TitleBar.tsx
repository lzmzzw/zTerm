// Author: Liz
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MouseEvent } from "react";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;
    const appWindow = getAppWindow();
    if (!appWindow) return;
    void appWindow
      .isMaximized()
      .then((value) => {
        if (mounted) setMaximized(value);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  function startWindowDrag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    void getAppWindow()?.startDragging();
  }

  async function toggleMaximize() {
    const appWindow = getAppWindow();
    if (!appWindow) return;
    await appWindow.toggleMaximize();
    try {
      setMaximized(await appWindow.isMaximized());
    } catch {
      setMaximized((value) => !value);
    }
  }

  return (
    <header className="zt-titlebar">
      <div className="zt-titlebar-drag-region" data-tauri-drag-region onMouseDown={startWindowDrag} />
      <div className="zt-window-actions" aria-label="窗口操作">
        <button
          type="button"
          aria-label="最小化"
          title="最小化"
          data-window-action="minimize"
          onClick={() => void getAppWindow()?.minimize()}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={maximized ? "恢复" : "全屏切换"}
          title={maximized ? "恢复" : "全屏切换"}
          data-window-action={maximized ? "restore" : "maximize"}
          onClick={() => void toggleMaximize()}
        >
          {maximized ? <Copy size={16} aria-hidden="true" /> : <Square size={16} aria-hidden="true" />}
        </button>
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          className="danger"
          data-window-action="close"
          onClick={() => void getAppWindow()?.close()}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function getAppWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}
