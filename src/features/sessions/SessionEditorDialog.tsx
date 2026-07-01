// Author: Liz
import { Monitor, Server, Terminal } from "lucide-react";
import { useEffect, useState } from "react";

import { ZtNumberInput } from "../../components/ZtNumberInput";
import { ZtSelect } from "../../components/ZtSelect";
import { ZtInput } from "../../components/ZtUi";
import { fallbackOnlyErrorMessage } from "../../lib/unknownErrorMessage";
import { LocalSessionForm } from "./LocalSessionForm";
import { RdpSessionForm } from "./RdpSessionForm";
import {
  defaultLocalOptions,
  defaultRdpOptions,
  initialSessionAuthMode,
  sessionDefaultPort,
  sessionEditorDialogTitle,
  sessionEditorSections,
} from "./sessionEditorModel";
import { SshSessionForm } from "./SshSessionForm";
import { defaultSshOptions, normalizeSshOptions } from "./sshSessionModel";
import { selectSshKeyFile } from "./sshKeyFileDialog";
import type {
  AuthMode,
  LocalOptions,
  RdpOptions,
  SavedSession,
  SavedSessionDraft,
  SessionGroup,
  SessionTestResult,
  SessionType,
  SshOptions,
} from "./types";
import type { CredentialDraft, CredentialRecord } from "../settings/settingsStore";
import type { TerminalProfile } from "../settings/settingsStore";

interface SessionEditorDialogProps {
  type: SessionType;
  groups: SessionGroup[];
  sessions?: SavedSession[];
  initialSession?: SavedSession | null;
  initialGroupId?: string | null;
  onClose: () => void;
  onTypeChange?: (type: SessionType) => void;
  onSave: (draft: SavedSessionDraft) => Promise<unknown> | unknown;
  onTestConnection?: (draft: SavedSessionDraft) => Promise<SessionTestResult> | SessionTestResult;
  onSaveCredential?: (draft: CredentialDraft) => Promise<CredentialRecord> | CredentialRecord;
  onReadCredential?: (credentialRef: string) => Promise<string> | string;
  onSelectSshKeyFile?: () => Promise<string | null> | string | null;
  terminalProfiles?: TerminalProfile[];
}

export function SessionEditorDialog({
  type,
  groups,
  sessions = [],
  initialSession,
  initialGroupId,
  onClose,
  onTypeChange,
  onSave,
  onTestConnection,
  onSaveCredential,
  onReadCredential,
  onSelectSshKeyFile,
  terminalProfiles = [],
}: SessionEditorDialogProps) {
  const [name, setName] = useState(initialSession?.name ?? "");
  const [host, setHost] = useState(initialSession?.host ?? "");
  const [port, setPort] = useState(String(initialSession?.port ?? sessionDefaultPort(type)));
  const [username, setUsername] = useState(initialSession?.username ?? "");
  const [groupId, setGroupId] = useState(initialSession?.group_id ?? initialGroupId ?? "");
  const [description, setDescription] = useState(initialSession?.description ?? "");
  const [tags] = useState(initialSession?.tags.join(",") ?? "");
  const [authMode, setAuthMode] = useState<AuthMode>(initialSessionAuthMode(initialSession, type));
  const [credentialRef, setCredentialRef] = useState(initialSession?.credential_ref ?? "");
  const [password, setPassword] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [keyPassphraseDirty, setKeyPassphraseDirty] = useState(false);
  const [sshOptions, setSshOptions] = useState<SshOptions>(initialSession?.ssh_options ?? defaultSshOptions);
  const [rdpOptions, setRdpOptions] = useState<RdpOptions>(initialSession?.rdp_options ?? defaultRdpOptions);
  const [localOptions, setLocalOptions] = useState<LocalOptions>(initialSession?.local_options ?? defaultLocalOptions);
  const [activeSection, setActiveSection] = useState(sessionEditorSections(type)[0]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setActiveSection(sessionEditorSections(type)[0]);
  }, [type]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedHost = type === "local" ? "localhost" : host.trim();
    const normalizedUsername = type === "local" ? "" : username.trim();
    const normalizedPort = type === "local" ? 1 : Number(port);
    const normalizedCredentialRef = credentialRef.trim();

    if (!normalizedName || !normalizedHost || (type !== "local" && !normalizedUsername) || !Number.isInteger(normalizedPort)) {
      setError("请填写名称、主机、用户名和端口");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      let sessionCredentialRef = normalizedCredentialRef || null;
      if (type === "ssh") {
        if (authMode === "password") {
          if (password && passwordDirty) {
            if (!onSaveCredential) {
              setError("当前无法保存 SSH 密码凭据");
              return;
            }
            const credential = await onSaveCredential({
              name: `${normalizedName} SSH 密码`,
              kind: "ssh_password",
              secret: password,
            });
            sessionCredentialRef = credential.credential_ref;
          } else if (!sessionCredentialRef) {
            setError("请填写 SSH 密码");
            return;
          }
        } else if (authMode === "key") {
          if (keyPassphrase && keyPassphraseDirty) {
            if (!onSaveCredential) {
              setError("当前无法保存 SSH 密钥密码凭据");
              return;
            }
            const credential = await onSaveCredential({
              name: `${normalizedName} SSH 密钥密码`,
              kind: "ssh_key_passphrase",
              secret: keyPassphrase,
            });
            sessionCredentialRef = credential.credential_ref;
          }
        }
      }
      if (type === "rdp" && authMode === "password") {
        if (password && passwordDirty) {
          if (!onSaveCredential) {
            setError("当前无法保存 RDP 密码凭据");
            return;
          }
          const credential = await onSaveCredential({
            name: `${normalizedName} RDP 密码`,
            kind: "rdp_password",
            secret: password,
          });
          sessionCredentialRef = credential.credential_ref;
        } else if (!sessionCredentialRef) {
          setError("请填写 RDP 密码");
          return;
        }
      }

      await onSave(buildDraft(sessionCredentialRef));
      setPassword("");
      setKeyPassphrase("");
      setPasswordDirty(false);
      setKeyPassphraseDirty(false);
      onClose();
    } catch (saveError) {
      setError(fallbackOnlyErrorMessage(saveError, "保存会话失败"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!onTestConnection) return;
    setError(null);
    setStatus(null);
    try {
      const result = await onTestConnection(buildDraft(credentialRef.trim() || null));
      setStatus(result.message);
    } catch (testError) {
      setError(fallbackOnlyErrorMessage(testError, "测试连接失败"));
    }
  }

  function buildDraft(sessionCredentialRef: string | null): SavedSessionDraft {
    return {
      id: initialSession?.id ?? null,
      name: name.trim(),
      type,
      group_id: groupId || null,
      host: type === "local" ? "localhost" : host.trim(),
      port: type === "local" ? 1 : Number(port),
      username: type === "local" ? "" : username.trim(),
      auth_mode: type === "local" ? "none" : authMode,
      credential_ref: type === "local" ? null : sessionCredentialRef,
      description: description.trim() || null,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      sort_order: initialSession?.sort_order ?? 0,
      ssh_options: type === "ssh" ? normalizeSshOptionsForSessionHost(sshOptions, host.trim()) : null,
      rdp_options: type === "rdp" ? rdpOptions : null,
      local_options: type === "local" ? localOptions : null,
    };
  }

  function changeType(nextType: SessionType) {
    if (initialSession) return;
    onTypeChange?.(nextType);
    setError(null);
    setStatus(null);
    setPort(String(sessionDefaultPort(nextType)));
    setAuthMode(initialSessionAuthMode(null, nextType));
    if (nextType === "local") {
      setCredentialRef("");
      setPassword("");
      setPasswordDirty(false);
    }
  }

  function handleAuthModeChange(nextAuthMode: AuthMode) {
    setAuthMode(nextAuthMode);
    if (nextAuthMode !== "password") {
      setPassword("");
      setPasswordDirty(false);
    }
    if (nextAuthMode !== "key") {
      setKeyPassphrase("");
      setKeyPassphraseDirty(false);
    }
    if (nextAuthMode !== initialSession?.auth_mode) {
      setCredentialRef("");
    } else {
      setCredentialRef(initialSession?.credential_ref ?? "");
    }
  }

  function handlePasswordChange(nextPassword: string) {
    setPassword(nextPassword);
    setPasswordDirty(true);
  }

  function handleKeyPassphraseChange(nextPassphrase: string) {
    setKeyPassphrase(nextPassphrase);
    setKeyPassphraseDirty(true);
  }

  async function handleRevealSshSecret(kind: "password" | "keyPassphrase") {
    const currentSecret = kind === "password" ? password : keyPassphrase;
    if (currentSecret) return true;

    const normalizedCredentialRef = credentialRef.trim();
    if (!normalizedCredentialRef) return true;

    const secretLabel = kind === "password" ? "SSH 密码" : "SSH 密钥密码";
    if (!onReadCredential) {
      setError(`当前无法读取已保存的 ${secretLabel} 凭据`);
      return true;
    }

    setError(null);
    try {
      const secret = await onReadCredential(normalizedCredentialRef);
      if (kind === "password") {
        setPassword(secret);
        setPasswordDirty(false);
      } else {
        setKeyPassphrase(secret);
        setKeyPassphraseDirty(false);
      }
      return true;
    } catch (readError) {
      setError(fallbackOnlyErrorMessage(readError, `读取已保存的 ${secretLabel} 失败`));
      return false;
    }
  }

  async function handleRevealRdpPassword() {
    if (password) return true;

    const normalizedCredentialRef = credentialRef.trim();
    if (!normalizedCredentialRef) return true;

    if (!onReadCredential) {
      setError("当前无法读取已保存的 RDP 密码凭据");
      return true;
    }

    setError(null);
    try {
      const secret = await onReadCredential(normalizedCredentialRef);
      setPassword(secret);
      setPasswordDirty(false);
      return true;
    } catch (readError) {
      setError(fallbackOnlyErrorMessage(readError, "读取已保存的 RDP 密码失败"));
      return false;
    }
  }

  async function handleSelectSshKeyFile() {
    try {
      return await (onSelectSshKeyFile ? onSelectSshKeyFile() : selectSshKeyFile());
    } catch (selectError) {
      setError(fallbackOnlyErrorMessage(selectError, "选择身份文件失败"));
      return null;
    }
  }

  const sections = sessionEditorSections(type);
  const showBaseFields = activeSection === "属性" || activeSection === "连接属性";
  const hasSavedSshCredential = type === "ssh" && Boolean(credentialRef.trim());
  const hasSavedRdpCredential = type === "rdp" && Boolean(credentialRef.trim());
  const typeTabs = [
    { icon: Server, label: "SSH", type: "ssh" },
    { icon: Terminal, label: "Local", type: "local" },
    { icon: Monitor, label: "RDP", type: "rdp" },
  ] satisfies Array<{ icon: typeof Server; label: string; type: SessionType }>;

  return (
    <div className="zt-session-modal-backdrop">
      <div
        className="zt-session-dialog zt-session-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={sessionEditorDialogTitle(type, Boolean(initialSession))}
      >
        <form onSubmit={handleSubmit}>
          <header>
            <strong>{sessionEditorDialogTitle(type, Boolean(initialSession))}</strong>
            <button type="button" aria-label="关闭会话编辑" onClick={onClose}>
              ×
            </button>
          </header>

        <div className="zt-session-type-tabs" role="tablist" aria-label="连接类型">
          {typeTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.type}
                type="button"
                aria-selected={type === tab.type}
                disabled={Boolean(initialSession) && type !== tab.type}
                onClick={() => changeType(tab.type)}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="zt-session-editor-body">
          <nav className="zt-session-editor-nav" aria-label="连接配置分组">
            {sections.map((section) => (
              <button
                key={section}
                type="button"
                aria-current={section === activeSection ? "page" : undefined}
                onClick={() => setActiveSection(section)}
              >
                {section}
              </button>
            ))}
          </nav>

          <div className="zt-session-editor-fields">
            {showBaseFields ? (
              <div className="zt-session-form-grid">
                <label>
                  <span>会话名称</span>
                  <ZtInput aria-label="会话名称" value={name} onChange={(event) => setName(event.currentTarget.value)} />
                </label>
                <label>
                  <span>分组</span>
                  <ZtSelect
                    ariaLabel="分组"
                    value={groupId}
                    options={[{ value: "", label: "未分组" }, ...groups.map((group) => ({ value: group.id, label: group.name }))]}
                    searchable
                    onChange={setGroupId}
                  />
                </label>
                {type !== "local" ? (
                  <>
                    <label>
                      <span>主机</span>
                      <ZtInput aria-label="主机" value={host} onChange={(event) => setHost(event.currentTarget.value)} />
                    </label>
                    <label>
                      <span>端口</span>
                      <ZtNumberInput
                        ariaLabel="端口"
                        min={1}
                        max={65535}
                        step={1}
                        value={Number(port) || 22}
                        onChange={(value) => setPort(String(value))}
                      />
                    </label>
                    <label>
                      <span>用户名</span>
                      <ZtInput aria-label="用户名" value={username} onChange={(event) => setUsername(event.currentTarget.value)} />
                    </label>
                  </>
                ) : null}
                <label className="zt-session-form-wide">
                  <span>描述</span>
                  <ZtInput aria-label="描述" value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
                </label>
              </div>
            ) : null}

            {type === "ssh" ? (
              <SshSessionForm
                section={activeSection}
                host={host}
                authMode={authMode}
                password={password}
                keyPassphrase={keyPassphrase}
                sshOptions={sshOptions}
                hasSavedPassword={authMode === "password" && hasSavedSshCredential}
                hasSavedKeyPassphrase={authMode === "key" && hasSavedSshCredential}
                onAuthModeChange={handleAuthModeChange}
                onPasswordChange={handlePasswordChange}
                onKeyPassphraseChange={handleKeyPassphraseChange}
                onSshOptionsChange={setSshOptions}
                savedSessions={sessions}
                currentSessionId={initialSession?.id ?? null}
                onSelectKeyFile={handleSelectSshKeyFile}
                onRevealPassword={() => handleRevealSshSecret("password")}
                onRevealKeyPassphrase={() => handleRevealSshSecret("keyPassphrase")}
              />
            ) : null}
            {type === "rdp" ? (
              <RdpSessionForm
                section={activeSection}
                password={password}
                options={rdpOptions}
                hasSavedPassword={hasSavedRdpCredential}
                onOptionsChange={setRdpOptions}
                onPasswordChange={handlePasswordChange}
                onRevealPassword={handleRevealRdpPassword}
              />
            ) : null}
            {type === "local" ? (
              <LocalSessionForm section={activeSection} options={localOptions} terminalProfiles={terminalProfiles} onOptionsChange={setLocalOptions} />
            ) : null}
          </div>
        </div>

        <div className="zt-session-editor-messages" aria-live="polite">
          {error ? <p className="zt-session-error">{error}</p> : null}
          {status ? <p className="zt-settings-status">{status}</p> : null}
        </div>

        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" onClick={() => void handleTestConnection()} disabled={!onTestConnection}>
            测试连接
          </button>
          <button type="submit" disabled={saving}>
            保存会话
          </button>
        </footer>
        </form>
      </div>
    </div>
  );
}

function normalizeSshOptionsForSessionHost(options: SshOptions, host: string): SshOptions {
  const normalized = normalizeSshOptions(options);
  return {
    ...normalized,
    tunnels: (normalized.tunnels ?? []).map((tunnel) =>
      tunnel.mode === "host_service" || tunnel.kind === "local"
        ? { ...tunnel, remote_host: host || tunnel.remote_host }
        : tunnel,
    ),
  };
}
