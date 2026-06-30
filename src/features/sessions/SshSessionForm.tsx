// Author: Liz
import { FolderOpen } from "lucide-react";
import { useState } from "react";

import { ZtNumberInput } from "../../components/ZtNumberInput";
import { ZtSelect } from "../../components/ZtSelect";
import { SshContainerSection } from "./SshContainerSection";
import { SshJumpHostSection } from "./SshJumpHostSection";
import { SshSecretInput } from "./SshSecretInput";
import { SshTunnelsSection } from "./SshTunnelsSection";
import type { AuthMode, SavedSession, SshOptions, SshTunnelMode } from "./types";

interface SshSessionFormProps {
  section: string;
  authMode: AuthMode;
  password: string;
  keyPassphrase: string;
  sshOptions: SshOptions;
  hasSavedPassword?: boolean;
  hasSavedKeyPassphrase?: boolean;
  onAuthModeChange: (authMode: AuthMode) => void;
  onPasswordChange: (password: string) => void;
  onKeyPassphraseChange: (passphrase: string) => void;
  onSshOptionsChange: (options: SshOptions) => void;
  savedSessions?: SavedSession[];
  currentSessionId?: string | null;
  onSelectKeyFile: () => Promise<string | null>;
  onRevealPassword?: () => Promise<boolean> | boolean;
  onRevealKeyPassphrase?: () => Promise<boolean> | boolean;
}

const authModeOptions = [
  { value: "password", label: "密码" },
  { value: "key", label: "密钥" },
];

export function SshSessionForm({
  section,
  authMode,
  password,
  keyPassphrase,
  sshOptions,
  hasSavedPassword = false,
  hasSavedKeyPassphrase = false,
  onAuthModeChange,
  onPasswordChange,
  onKeyPassphraseChange,
  onSshOptionsChange,
  savedSessions = [],
  currentSessionId = null,
  onSelectKeyFile,
  onRevealPassword,
  onRevealKeyPassphrase,
}: SshSessionFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [showKeyPassphrase, setShowKeyPassphrase] = useState(false);
  const [selectedJumpHostId, setSelectedJumpHostId] = useState("");
  const [newTunnelMode, setNewTunnelMode] = useState<SshTunnelMode>("host_service");

  async function handleSelectKeyFile() {
    const selected = await onSelectKeyFile();
    if (!selected) return;
    onSshOptionsChange({ ...sshOptions, identity_file: selected });
  }

  return (
    <div className="zt-session-form-grid" data-session-form="ssh">
      {section === "属性" ? (
        <>
          <label>
            <span>认证方式</span>
            <ZtSelect
              ariaLabel="认证方式"
              value={authMode}
              options={authModeOptions}
              onChange={(nextValue) => onAuthModeChange(nextValue as AuthMode)}
            />
          </label>
          {authMode === "password" ? (
            <label>
              <span>密码</span>
              <SshSecretInput
                label="密码"
                value={password}
                maskedPlaceholder={hasSavedPassword}
                visible={showPassword}
                onVisibleChange={setShowPassword}
                onChange={onPasswordChange}
                onReveal={onRevealPassword}
              />
            </label>
          ) : null}
          {authMode === "key" ? (
            <>
              <label className="zt-session-form-wide">
                <span>身份文件</span>
                <div className="zt-path-picker">
                  <input
                    aria-label="身份文件"
                    value={sshOptions.identity_file ?? ""}
                    onChange={(event) => onSshOptionsChange({ ...sshOptions, identity_file: event.currentTarget.value })}
                    placeholder="选择或输入 SSH 身份文件路径"
                  />
                  <button type="button" aria-label="选择身份文件" title="选择身份文件" onClick={() => void handleSelectKeyFile()}>
                    <FolderOpen size={14} aria-hidden="true" />
                  </button>
                </div>
              </label>
              <label>
                <span>密钥密码</span>
                <SshSecretInput
                  label="密钥密码"
                  value={keyPassphrase}
                  maskedPlaceholder={hasSavedKeyPassphrase}
                  visible={showKeyPassphrase}
                  onVisibleChange={setShowKeyPassphrase}
                  onChange={onKeyPassphraseChange}
                  onReveal={onRevealKeyPassphrase}
                />
              </label>
            </>
          ) : null}
          {authMode !== "password" && authMode !== "key" ? (
            <label className="zt-session-form-wide">
              <span>认证方式</span>
              <input
                aria-label="认证状态"
                value="请选择密码或密钥认证"
                readOnly
              />
            </label>
          ) : null}
          <label>
            <span>连接超时(ms)</span>
            <ZtNumberInput
              ariaLabel="连接超时"
              min={1000}
              max={300000}
              step={1000}
              value={sshOptions.connect_timeout_ms ?? 30000}
              onChange={(value) => onSshOptionsChange({ ...sshOptions, connect_timeout_ms: value })}
            />
          </label>
          <label>
            <span>Keepalive(ms)</span>
            <ZtNumberInput
              ariaLabel="Keepalive"
              min={1000}
              max={60000}
              step={1000}
              value={sshOptions.keepalive_interval_ms ?? 15000}
              onChange={(value) => onSshOptionsChange({ ...sshOptions, keepalive_interval_ms: value })}
            />
          </label>
        </>
      ) : null}
      {section === "跳板机" ? (
        <SshJumpHostSection
          sshOptions={sshOptions}
          savedSessions={savedSessions}
          currentSessionId={currentSessionId}
          selectedJumpHostId={selectedJumpHostId}
          onSelectedJumpHostIdChange={setSelectedJumpHostId}
          onSshOptionsChange={onSshOptionsChange}
        />
      ) : null}
      {section === "隧道" ? (
        <SshTunnelsSection
          sshOptions={sshOptions}
          newTunnelMode={newTunnelMode}
          onNewTunnelModeChange={setNewTunnelMode}
          onSshOptionsChange={onSshOptionsChange}
        />
      ) : null}
      {section === "容器" ? (
        <SshContainerSection sshOptions={sshOptions} onSshOptionsChange={onSshOptionsChange} />
      ) : null}
    </div>
  );
}
