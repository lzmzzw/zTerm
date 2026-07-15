// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Info, Hash, KeyRound, Power, Scale, GitBranch, RefreshCw, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import packageJson from "../../../package.json";

import { acceleratorFromKeyboardEvent, bindingsWithDefaults, detectShortcutConflicts } from "./shortcutManager";
import { t } from "./i18n";
import { useDomI18n } from "./domI18n";
import {
  fallbackSettings,
  languageOptions,
  settingsShortcutPatchFor,
  settingsTabs,
  themeOptions,
  type SettingsTab,
  workspaceRestoreStrategyOptions,
} from "./settingsPageModel";
import { ZtNumberInput } from "../../components/ZtNumberInput";
import { ZtSelect } from "../../components/ZtSelect";
import { ZtSurfaceFrame } from "../../components/ZtUi";
import type {
  AppLanguage,
  AppSettings,
  AppTheme,
  McpServerStatus,
  McpToolDefinition,
  SettingsSection,
  ShortcutBinding,
  ShortcutDefinition,
  TerminalProfile,
  TerminalProfileDraft,
  WorkspaceRestoreStrategy,
} from "./settingsStore";

interface SettingsPageProps {
  settings: AppSettings | null;
  terminalProfiles: TerminalProfile[];
  shortcutDefinitions: ShortcutDefinition[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSaveSettings: (settings: AppSettings) => Promise<AppSettings> | AppSettings;
  onResetSettings: (section: SettingsSection) => Promise<AppSettings> | AppSettings;
  onDetectTerminalProfiles: () => Promise<TerminalProfile[]> | TerminalProfile[];
  onSetDefaultTerminalProfile: (draft: TerminalProfileDraft) => Promise<unknown> | unknown;
  mcpStatus?: McpServerStatus;
  onSetMcpEnabled?: (enabled: boolean, port?: number | null) => Promise<McpServerStatus> | McpServerStatus;
  onRotateMcpToken?: () => Promise<McpServerStatus> | McpServerStatus;
  onLoadMcpTools?: () => Promise<McpToolDefinition[]> | McpToolDefinition[];
}

export function SettingsPage({
  settings,
  terminalProfiles,
  shortcutDefinitions,
  loading,
  error,
  onClose,
  onSaveSettings,
  onResetSettings,
  onDetectTerminalProfiles,
  onSetDefaultTerminalProfile,
  mcpStatus = { enabled: false, endpoint: null, token: null },
  onSetMcpEnabled = async () => ({ enabled: false, endpoint: null, token: null }),
  onRotateMcpToken = async () => ({ enabled: false, endpoint: null, token: null }),
  onLoadMcpTools = () => invoke<McpToolDefinition[]>("mcp_tool_catalog_list"),
}: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState<AppSettings>(settings ?? fallbackSettings);
  const [status, setStatus] = useState<string | null>(null);
  const language = draft.language;

  useDomI18n(language);

  useEffect(() => {
    setDraft(settings ?? fallbackSettings);
  }, [settings]);

  useEffect(() => {
    setStatus(null);
  }, [tab]);

  async function saveDraft(nextDraft = draft) {
    const saved = await onSaveSettings(nextDraft);
    setDraft(saved);
    setStatus(t(saved.language, "settingsSaved"));
  }

  async function resetDraft(section: SettingsSection) {
    const reset = await onResetSettings(section);
    setDraft(reset);
    setStatus(t(reset.language, "settingsReset"));
  }

  return (
    <ZtSurfaceFrame className="zt-settings-page">
      <header className="zt-settings-page-header">
        <strong>{t(language, "settings")}</strong>
        {error ? <span className="zt-settings-page-error">{error}</span> : null}
        <button type="button" aria-label={t(language, "closeSettings")} onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="zt-settings-page-body">
        <nav className="zt-settings-page-tabs" aria-label="设置分类">
          {settingsTabs.map((item) => (
            <button key={item} type="button" aria-selected={tab === item} onClick={() => setTab(item)}>
              {t(language, item)}
            </button>
          ))}
        </nav>
        <main className="zt-settings-page-main">
          {tab === "general" ? (
            <GeneralSettings
              draft={draft}
              language={language}
              loading={loading}
              status={status}
              onDraftChange={setDraft}
              onReset={() => void resetDraft("general")}
              onSave={() => void saveDraft()}
            />
          ) : null}
          {tab === "shortcuts" ? (
            <ShortcutSettings
              definitions={shortcutDefinitions}
              draft={draft}
              language={language}
              loading={loading}
              status={status}
              onDraftChange={setDraft}
              onReset={() => void resetDraft("shortcuts")}
              onSave={(nextDraft) => void saveDraft(nextDraft)}
            />
          ) : null}
          {tab === "terminal" ? (
            <TerminalProfileSettings
              profiles={terminalProfiles}
              language={language}
              loading={loading}
              onDetect={onDetectTerminalProfiles}
              onSetDefault={onSetDefaultTerminalProfile}
            />
          ) : null}
          {tab === "mcp" ? (
            <McpSettings
              status={mcpStatus}
              language={language}
              loading={loading}
              onSetEnabled={onSetMcpEnabled}
              onRotateToken={onRotateMcpToken}
              onLoadTools={onLoadMcpTools}
            />
          ) : null}
          {tab === "about" ? (
            <AboutSettings language={language} />
          ) : null}
        </main>
      </div>
    </ZtSurfaceFrame>
  );
}

function McpSettings({
  status,
  language,
  loading,
  onSetEnabled,
  onRotateToken,
  onLoadTools,
}: {
  status: McpServerStatus;
  language: AppLanguage;
  loading: boolean;
  onSetEnabled: (enabled: boolean, port?: number | null) => Promise<McpServerStatus> | McpServerStatus;
  onRotateToken: () => Promise<McpServerStatus> | McpServerStatus;
  onLoadTools: () => Promise<McpToolDefinition[]> | McpToolDefinition[];
}) {
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [tools, setTools] = useState<McpToolDefinition[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const toolGroups = useMemo(() => groupMcpTools(tools ?? []), [tools]);

  async function setEnabled(enabled: boolean) {
    await onSetEnabled(enabled, null);
    setLocalStatus(enabled ? t(language, "mcpServiceStarted") : t(language, "mcpServiceStopped"));
  }

  async function rotateToken() {
    await onRotateToken();
    setLocalStatus(t(language, "mcpTokenRotated"));
  }

  async function copyValue(value: string | null | undefined, message: string) {
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    setLocalStatus(message);
  }

  async function loadTools() {
    setToolsLoading(true);
    setToolsError(null);
    try {
      setTools(await onLoadTools());
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : String(error));
    } finally {
      setToolsLoading(false);
    }
  }

  function toggleTools() {
    const nextExpanded = !toolsExpanded;
    setToolsExpanded(nextExpanded);
    if (nextExpanded && tools === null && !toolsLoading) void loadTools();
  }

  return (
    <section className="zt-settings-section zt-mcp-settings-section" aria-label={t(language, "mcpLocalService")}>
      <div className="zt-settings-actions">
        <button type="button" disabled={loading} onClick={() => void setEnabled(!status.enabled)}>
          <Power size={14} aria-hidden="true" />
          {status.enabled ? t(language, "mcpDisable") : t(language, "mcpEnable")}
        </button>
        <button type="button" disabled={loading || !status.enabled} onClick={() => void rotateToken()}>
          <RefreshCw size={14} aria-hidden="true" />
          {t(language, "mcpRotateToken")}
        </button>
        {localStatus ? <span className="zt-settings-status">{localStatus}</span> : null}
      </div>
      <div className="zt-settings-list" aria-label={t(language, "mcpLocalService")}>
        {!status.enabled ? <div className="zt-empty-line">{t(language, "mcpDisabled")}</div> : null}
        <div className="zt-settings-row zt-mcp-row">
          <ExternalLink size={14} aria-hidden="true" />
          <div>
            <strong>{t(language, "mcpEndpoint")}</strong>
            <span>{status.endpoint ?? "-"}</span>
          </div>
          <button
            type="button"
            aria-label={t(language, "mcpCopyEndpoint")}
            title={t(language, "mcpCopyEndpoint")}
            disabled={!status.endpoint}
            onClick={() => void copyValue(status.endpoint, t(language, "mcpEndpointCopied"))}
          >
            <Copy size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="zt-settings-row zt-mcp-row">
          <KeyRound size={14} aria-hidden="true" />
          <div>
            <strong>{t(language, "mcpToken")}</strong>
            <span>{status.token ?? "-"}</span>
          </div>
          <button
            type="button"
            aria-label={t(language, "mcpCopyToken")}
            title={t(language, "mcpCopyToken")}
            disabled={!status.token}
            onClick={() => void copyValue(status.token, t(language, "mcpTokenCopied"))}
          >
            <Copy size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="zt-mcp-tools-panel">
        <button
          type="button"
          className="zt-mcp-tools-toggle"
          aria-expanded={toolsExpanded}
          aria-controls="zt-mcp-tools-details"
          onClick={toggleTools}
        >
          {toolsExpanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          <strong>{t(language, "mcpToolDetails")}</strong>
          <span>{tools ? t(language, "mcpToolCount", { count: tools.length }) : null}</span>
        </button>
        {toolsExpanded ? (
          <div id="zt-mcp-tools-details" className="zt-mcp-tools-details">
            {toolsLoading ? <div className="zt-mcp-tools-message">{t(language, "mcpToolsLoading")}</div> : null}
            {toolsError ? (
              <div className="zt-mcp-tools-message is-error">
                <span>{t(language, "mcpToolsLoadFailed", { message: toolsError })}</span>
                <button type="button" onClick={() => void loadTools()}>{t(language, "mcpToolsRetry")}</button>
              </div>
            ) : null}
            {!toolsLoading && !toolsError && tools?.length === 0 ? (
              <div className="zt-mcp-tools-message">{t(language, "mcpToolsEmpty")}</div>
            ) : null}
            {!toolsLoading && !toolsError
              ? toolGroups.map((group) => (
                  <section key={group.key} className="zt-mcp-tool-group" aria-label={mcpToolGroupLabel(language, group.key)}>
                    <h3>{mcpToolGroupLabel(language, group.key)} ({group.tools.length})</h3>
                    <div className="zt-mcp-tool-list">
                      {group.tools.map((tool) => (
                        <div key={tool.id} className="zt-mcp-tool-item">
                          <div>
                            <strong>{tool.title}</strong>
                            <code>{tool.id}</code>
                          </div>
                          <p>{tool.description}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                ))
              : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface McpToolGroup {
  key: string;
  tools: McpToolDefinition[];
}

function groupMcpTools(tools: McpToolDefinition[]): McpToolGroup[] {
  const groups = new Map<string, McpToolDefinition[]>();
  for (const tool of tools) {
    const key = mcpToolGroupKey(tool.id.split(".", 1)[0] || "other");
    const group = groups.get(key) ?? [];
    group.push(tool);
    groups.set(key, group);
  }
  return Array.from(groups, ([key, groupTools]) => ({ key, tools: groupTools }));
}

function mcpToolGroupKey(namespace: string) {
  if (namespace === "terminal_profile" || namespace === "ssh_container") return "terminal";
  if (namespace === "session_groups") return "sessions";
  return namespace;
}

function mcpToolGroupLabel(language: AppLanguage, key: string) {
  const labelKeys = {
    terminal: "mcpToolGroupTerminal",
    terminal_profile: "mcpToolGroupTerminal",
    workspace: "mcpToolGroupWorkspace",
    settings: "mcpToolGroupSettings",
    llm_provider: "mcpToolGroupModels",
    sessions: "mcpToolGroupSessions",
    session_groups: "mcpToolGroupSessions",
    sftp: "mcpToolGroupFiles",
    history: "mcpToolGroupHistory",
    transfer: "mcpToolGroupTransfers",
    server_info: "mcpToolGroupMonitor",
    ssh: "mcpToolGroupSsh",
    ssh_container: "mcpToolGroupTerminal",
    zterm: "mcpToolGroupZterm",
  } as const;
  return t(language, labelKeys[key as keyof typeof labelKeys] ?? "mcpToolGroupOther");
}

function GeneralSettings({
  draft,
  language,
  loading,
  status,
  onDraftChange,
  onReset,
  onSave,
}: {
  draft: AppSettings;
  language: AppLanguage;
  loading: boolean;
  status: string | null;
  onDraftChange: (draft: AppSettings) => void;
  onReset: () => void;
  onSave: () => void;
}) {
  const localizedLanguageOptions = languageOptions.map((option) => ({ value: option.value, label: t(language, option.labelKey) }));
  const localizedWorkspaceRestoreStrategyOptions = workspaceRestoreStrategyOptions.map((option) => ({
    value: option.value,
    label: t(language, option.labelKey),
  }));
  return (
    <section className="zt-settings-section zt-settings-section-with-actions" aria-label={t(language, "general")}>
      <div className="zt-settings-section-body">
        <form
          id="zt-general-settings-form"
          className="zt-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <label>
            <span>{t(language, "language")}</span>
            <ZtSelect
              ariaLabel={t(language, "language")}
              value={draft.language}
              options={localizedLanguageOptions}
              onChange={(nextValue) => onDraftChange({ ...draft, language: nextValue as AppLanguage })}
            />
          </label>
          <label>
            <span>{t(language, "theme")}</span>
            <ZtSelect
              ariaLabel={t(language, "theme")}
              value={draft.theme}
              options={themeOptions}
              onChange={(nextValue) => onDraftChange({ ...draft, theme: nextValue as AppTheme })}
            />
          </label>
          <label>
            <span>{t(language, "uiFontSize")}</span>
            <ZtNumberInput
              ariaLabel={t(language, "uiFontSize")}
              min={11}
              max={18}
              step={1}
              value={draft.ui_font_size}
              onChange={(value) => onDraftChange({ ...draft, ui_font_size: value })}
            />
          </label>
          <label>
            <span>{t(language, "terminalFontSize")}</span>
            <ZtNumberInput
              ariaLabel={t(language, "terminalFontSize")}
              min={9}
              max={24}
              step={1}
              value={draft.terminal_font_size}
              onChange={(value) => onDraftChange({ ...draft, terminal_font_size: value })}
            />
          </label>
          <label>
            <span>{t(language, "workspaceRestoreStrategy")}</span>
            <ZtSelect
              ariaLabel={t(language, "workspaceRestoreStrategy")}
              value={draft.workspace_restore_strategy ?? "visible_first"}
              options={localizedWorkspaceRestoreStrategyOptions}
              onChange={(nextValue) =>
                onDraftChange({ ...draft, workspace_restore_strategy: nextValue as WorkspaceRestoreStrategy })
              }
            />
          </label>
        </form>
      </div>
      <SettingsActionBar language={language} loading={loading} status={status} formId="zt-general-settings-form" onReset={onReset} />
    </section>
  );
}

function ShortcutSettings({
  definitions,
  draft,
  language,
  loading,
  status,
  onDraftChange,
  onReset,
  onSave,
}: {
  definitions: ShortcutDefinition[];
  draft: AppSettings;
  language: AppLanguage;
  loading: boolean;
  status: string | null;
  onDraftChange: (draft: AppSettings) => void;
  onReset: () => void;
  onSave: (draft: AppSettings) => void;
}) {
  const rows = useMemo(() => bindingsWithDefaults(definitions, draft.shortcuts), [definitions, draft.shortcuts]);
  const conflicts = useMemo(() => detectShortcutConflicts(rows.map((row) => row.binding)), [rows]);

  function updateBinding(actionId: string, patch: Partial<ShortcutBinding>) {
    const nextBindings = rows.map(({ definition, binding }) => ({
      ...binding,
      action_id: definition.action_id,
      scope: definition.scope,
      ...settingsShortcutPatchFor(actionId, definition.action_id, patch),
    }));
    onDraftChange({ ...draft, shortcuts: nextBindings });
  }

  const nextDraft = { ...draft, shortcuts: rows.map((row) => row.binding) };

  return (
    <section className="zt-settings-section zt-settings-section-with-actions" aria-label={t(language, "shortcuts")}>
      <div className="zt-settings-section-body">
        {conflicts.size > 0 ? <p className="zt-session-error">{t(language, "shortcutConflict")}</p> : null}
        <div className="zt-shortcut-list">
          {rows.map(({ definition, binding }) => (
            <div className={`zt-shortcut-row ${conflicts.has(definition.action_id) ? "conflict" : ""}`} key={definition.action_id}>
              <strong>{definition.label}</strong>
              <input
                aria-label={`${t(language, "shortcutAriaPrefix")} ${definition.label}`}
                value={binding.accelerator}
                readOnly
                placeholder={t(language, "captureShortcutPlaceholder")}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.currentTarget.blur();
                    return;
                  }
                  event.preventDefault();
                  if (event.key === "Backspace" || event.key === "Delete") {
                    updateBinding(definition.action_id, { accelerator: "" });
                    return;
                  }
                  const accelerator = acceleratorFromKeyboardEvent(event.nativeEvent);
                  if (accelerator) {
                    updateBinding(definition.action_id, { accelerator });
                  }
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <SettingsActionBar
        language={language}
        loading={loading}
        saveDisabled={conflicts.size > 0}
        status={status}
        onReset={onReset}
        onSave={() => onSave(nextDraft)}
      />
    </section>
  );
}

function SettingsActionBar({
  language,
  loading,
  saveDisabled = false,
  status,
  formId,
  onReset,
  onSave,
}: {
  language: AppLanguage;
  loading: boolean;
  saveDisabled?: boolean;
  status: string | null;
  formId?: string;
  onReset: () => void;
  onSave?: () => void;
}) {
  return (
    <footer className="zt-settings-action-bar">
      {status ? <span className="zt-settings-status">{status}</span> : null}
      <div className="zt-settings-action-buttons">
        <button type="button" disabled={loading} onClick={onReset}>
          {t(language, "resetDefaults")}
        </button>
        <button type={onSave ? "button" : "submit"} form={formId} disabled={loading || saveDisabled} onClick={onSave}>
          {t(language, "save")}
        </button>
      </div>
    </footer>
  );
}

function TerminalProfileSettings({
  profiles,
  language,
  loading,
  onDetect,
  onSetDefault,
}: {
  profiles: TerminalProfile[];
  language: AppLanguage;
  loading: boolean;
  onDetect: () => Promise<TerminalProfile[]> | TerminalProfile[];
  onSetDefault: (draft: TerminalProfileDraft) => Promise<unknown> | unknown;
}) {
  const [status, setStatus] = useState<string | null>(null);

  async function detect() {
    const detected = await onDetect();
    setStatus(t(language, "detectedTerminalCount", { count: detected.length }));
  }

  async function setDefault(profile: TerminalProfile) {
    await onSetDefault({
      id: profile.id,
      name: profile.name,
      path: profile.path,
      args: profile.args,
      detected: profile.detected,
      is_default: true,
    });
    setStatus(t(language, "defaultTerminalSet", { name: profile.name }));
  }

  return (
    <section className="zt-settings-section" aria-label={t(language, "terminal")}>
      <div className="zt-settings-actions">
        <button type="button" disabled={loading} onClick={() => void detect()}>
          <Search size={14} aria-hidden="true" />
          {t(language, "detectTerminal")}
        </button>
        {status ? <span className="zt-settings-status">{status}</span> : null}
      </div>
      <div className="zt-settings-list" aria-label={t(language, "terminalProfileList")}>
        {profiles.length === 0 ? <div className="zt-empty-line">{t(language, "noTerminalProfiles")}</div> : null}
        {profiles.map((profile) => (
          <div className="zt-settings-row zt-terminal-profile-row" key={profile.id}>
            <Star size={14} aria-hidden="true" className={profile.is_default ? "active" : ""} />
            <div>
              <strong>{profile.name}</strong>
              <span>{profile.path}</span>
            </div>
            <button type="button" disabled={profile.is_default || loading} onClick={() => void setDefault(profile)}>
              {t(language, "setDefault")}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function AboutSettings({ language }: { language: AppLanguage }) {
  const [version, setVersion] = useState(packageJson.version);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const githubUrl = `https://${t(language, "aboutGitHubUrl")}`;

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((runtimeVersion) => {
        if (!cancelled && runtimeVersion.trim()) {
          setVersion(runtimeVersion);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVersion(packageJson.version);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openGitHub() {
    await openUrl(githubUrl);
  }

  function describeUpdateError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function formatDownloadProgress(event: DownloadEvent, totalBytes: number | null, downloadedBytes: number) {
    if (event.event === "Started") {
      return {
        totalBytes: event.data.contentLength ?? null,
        downloadedBytes: 0,
        status: t(language, "aboutUpdateDownloading"),
      };
    }
    if (event.event === "Progress") {
      const nextDownloadedBytes = downloadedBytes + event.data.chunkLength;
      if (totalBytes && totalBytes > 0) {
        return {
          totalBytes,
          downloadedBytes: nextDownloadedBytes,
          status: t(language, "aboutUpdateDownloadingProgress", {
            percent: Math.min(100, Math.round((nextDownloadedBytes / totalBytes) * 100)),
          }),
        };
      }
      return {
        totalBytes,
        downloadedBytes: nextDownloadedBytes,
        status: t(language, "aboutUpdateDownloading"),
      };
    }
    return {
      totalBytes,
      downloadedBytes,
      status: t(language, "aboutUpdateInstalling"),
    };
  }

  async function checkForUpdates() {
    setCheckingUpdate(true);
    setUpdateStatus(t(language, "aboutUpdateChecking"));
    let totalBytes: number | null = null;
    let downloadedBytes = 0;
    try {
      const update = await check({ timeout: 30000 });
      if (!update) {
        setUpdateStatus(t(language, "aboutUpdateNone"));
        return;
      }
      setUpdateStatus(t(language, "aboutUpdateFound", { version: update.version }));
      await update.downloadAndInstall((event) => {
        const next = formatDownloadProgress(event, totalBytes, downloadedBytes);
        totalBytes = next.totalBytes;
        downloadedBytes = next.downloadedBytes;
        setUpdateStatus(next.status);
      });
      setUpdateStatus(t(language, "aboutUpdateInstalled"));
      await relaunch();
    } catch (error) {
      setUpdateStatus(t(language, "aboutUpdateFailed", { message: describeUpdateError(error) }));
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <section className="zt-settings-section zt-settings-about" aria-label={t(language, "about")}>
      <div className="zt-settings-section-body">
        <div className="zt-settings-about-header">
          <Info size={18} aria-hidden="true" />
          <strong>{t(language, "aboutTitle")}</strong>
          <span className="zt-settings-about-version-badge">v{version}</span>
        </div>
        <div className="zt-settings-about-cards">
          <div className="zt-settings-about-card">
            <div className="zt-settings-about-card-header">
              <Hash size={16} aria-hidden="true" />
              <strong>{t(language, "aboutVersion")}</strong>
            </div>
            <span className="zt-settings-about-card-value">v{version}</span>
          </div>
          <div className="zt-settings-about-card">
            <div className="zt-settings-about-card-header">
              <Scale size={16} aria-hidden="true" />
              <strong>{t(language, "aboutLicense")}</strong>
            </div>
            <span className="zt-settings-about-card-value">{t(language, "aboutLicenseValue")}</span>
          </div>
          <div className="zt-settings-about-card">
            <div className="zt-settings-about-card-header">
              <GitBranch size={16} aria-hidden="true" />
              <strong>{t(language, "aboutGitHub")}</strong>
            </div>
            <span className="zt-settings-about-card-value">{t(language, "aboutGitHubUrl")}</span>
            <button type="button" className="zt-settings-about-link-btn" onClick={() => void openGitHub()}>
              {t(language, "aboutOpen")}
              <ExternalLink size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="zt-settings-about-card">
            <div className="zt-settings-about-card-header">
              <RefreshCw size={16} aria-hidden="true" />
              <strong>{t(language, "aboutUpdate")}</strong>
            </div>
            <span className="zt-settings-about-card-value">{updateStatus ?? t(language, "aboutUpdateIdle")}</span>
            <button type="button" className="zt-settings-about-check-btn" disabled={checkingUpdate} onClick={() => void checkForUpdates()}>
              {checkingUpdate ? t(language, "aboutUpdateCheckingButton") : t(language, "aboutCheckUpdate")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
