// Author: Liz
import { useState } from "react";

import { ZtModalOverlay, ZtSurfaceFrame } from "../components/ZtUi";
import { sshTunnelMode } from "../features/sessions/sshSessionModel";
import { SshTunnelsSection } from "../features/sessions/SshTunnelsSection";
import type { SshOptions, SshTunnel, SshTunnelMode } from "../features/sessions/types";
import type { SshTunnelEditorState } from "./appShellModel";

export function ExternalSshTunnelEditorDialog({
  host,
  hostServiceTargetHost,
  initialOptions,
  onCancel,
  onSave,
}: {
  host: string;
  hostServiceTargetHost: string;
  initialOptions: SshOptions;
  onCancel: () => void;
  onSave: (options: SshOptions) => void;
}) {
  const [sshOptions, setSshOptions] = useState<SshOptions>(initialOptions);
  const [newTunnelMode, setNewTunnelMode] = useState<SshTunnelMode>("host_service");

  return (
    <ZtModalOverlay className="zt-session-modal-backdrop">
      <ZtSurfaceFrame
        className="zt-session-dialog zt-session-editor-dialog zt-transient-tunnel-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="临时 SSH 隧道"
      >
        <header>
          <strong>临时 SSH 隧道</strong>
          <button type="button" aria-label="关闭临时 SSH 隧道编辑" onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="zt-session-editor-body zt-transient-tunnel-body">
          <div className="zt-session-editor-fields zt-transient-tunnel-fields">
            <SshTunnelsSection
              sshOptions={sshOptions}
              host={host}
              hostServiceTargetHost={hostServiceTargetHost}
              hostServiceTargetEditable={true}
              newTunnelMode={newTunnelMode}
              onNewTunnelModeChange={setNewTunnelMode}
              onSshOptionsChange={setSshOptions}
            />
          </div>
        </div>
        <div className="zt-session-editor-messages" aria-live="polite">
          <p className="zt-settings-status">临时隧道保存后需要重连当前 SSH 才会生效。</p>
        </div>
        <footer>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" aria-label="保存临时隧道" onClick={() => onSave(sshOptions)}>
            保存临时隧道
          </button>
        </footer>
      </ZtSurfaceFrame>
    </ZtModalOverlay>
  );
}

export function SshTunnelEditorDialog({
  editor,
  onCancel,
  onSave,
}: {
  editor: SshTunnelEditorState;
  onCancel: () => void;
  onSave: (tunnel: SshTunnel) => void;
}) {
  const [sshOptions, setSshOptions] = useState<SshOptions>({ ...editor.baseOptions, tunnels: [editor.tunnel] });
  const [tunnelMode, setTunnelMode] = useState<SshTunnelMode>(sshTunnelMode(editor.tunnel));
  const tunnel = sshOptions.tunnels?.[0] ?? null;
  const title = editor.mode === "create" ? "新增 SSH 隧道" : "编辑 SSH 隧道";

  return (
    <ZtModalOverlay className="zt-session-modal-backdrop">
      <ZtSurfaceFrame
        className="zt-session-dialog zt-session-editor-dialog zt-transient-tunnel-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <strong>{title}</strong>
          <button type="button" aria-label={`关闭${title}`} onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="zt-session-editor-body zt-transient-tunnel-body">
          <div className="zt-session-editor-fields zt-transient-tunnel-fields">
            <SshTunnelsSection
              sshOptions={sshOptions}
              host={editor.host}
              hostServiceTargetHost={editor.hostServiceTargetHost}
              hostServiceTargetEditable={editor.external}
              maxTunnels={1}
              singleTunnelEditor
              newTunnelMode={tunnelMode}
              onNewTunnelModeChange={setTunnelMode}
              onSshOptionsChange={setSshOptions}
            />
          </div>
        </div>
        <div className="zt-session-editor-messages">
          <p className="zt-settings-status">隧道配置将在当前 SSH 连接重连后生效。</p>
        </div>
        <footer>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" aria-label="保存隧道" disabled={!tunnel} onClick={() => tunnel && onSave(tunnel)}>
            保存隧道
          </button>
        </footer>
      </ZtSurfaceFrame>
    </ZtModalOverlay>
  );
}
