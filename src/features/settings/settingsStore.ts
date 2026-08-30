// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";

type CredentialKind = "ssh_password" | "ssh_key_passphrase" | "rdp_password";
export type AppLanguage = "zhCN" | "enUS";
export type AppTheme = "dark" | "light" | "system";
export type WorkspaceRestoreStrategy = "visible_first" | "connect_all" | "layout_only";
export type SettingsSection = "general" | "shortcuts";
type ShortcutScope = "app";

export interface McpSettings {
  enabled: boolean;
  port?: number | null;
}

export interface CredentialRecord {
  id: string;
  name: string;
  kind: CredentialKind;
  credential_ref: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CredentialDraft {
  id?: string | null;
  name: string;
  kind: CredentialKind;
  secret: string;
}

interface CredentialSecret {
  secret: string;
}

export interface ShortcutBinding {
  action_id: string;
  accelerator: string;
  scope: ShortcutScope;
}

export interface ShortcutDefinition {
  action_id: string;
  label: string;
  default_accelerator: string;
  scope: ShortcutScope;
}

export interface AppSettings {
  language: AppLanguage;
  theme: AppTheme;
  ui_font_size: number;
  terminal_font_size: number;
  default_right_tool: string | null;
  workspace_restore_strategy: WorkspaceRestoreStrategy;
  mcp: McpSettings;
  shortcuts: ShortcutBinding[];
}

export interface McpServerStatus {
  enabled: boolean;
  endpoint?: string | null;
  token?: string | null;
}

export interface McpToolDefinition {
  id: string;
  title: string;
  description: string;
  risk_level: "low" | "medium" | "high" | "critical";
  requires_confirmation: boolean;
}

export interface TerminalProfile {
  id: string;
  name: string;
  path: string;
  args: string[];
  detected: boolean;
  is_default: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface TerminalProfileDraft {
  id: string;
  name: string;
  path: string;
  args: string[];
  detected: boolean;
  is_default: boolean;
}

interface SettingsState {
  appSettings: AppSettings | null;
  credentials: CredentialRecord[];
  terminalProfiles: TerminalProfile[];
  shortcutDefinitions: ShortcutDefinition[];
  mcpStatus: McpServerStatus;
  loading: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  loadMcpStatus: () => Promise<McpServerStatus>;
  setMcpEnabled: (enabled: boolean, port?: number | null) => Promise<McpServerStatus>;
  rotateMcpToken: () => Promise<McpServerStatus>;
  saveAppSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetAppSettingsSection: (section: SettingsSection) => Promise<AppSettings>;
  saveCredential: (draft: CredentialDraft) => Promise<CredentialRecord>;
  readCredentialSecret: (credentialRef: string) => Promise<string>;
  deleteCredential: (id: string) => Promise<void>;
  testCredential: (id: string) => Promise<void>;
  detectTerminalProfiles: () => Promise<TerminalProfile[]>;
  setDefaultTerminalProfile: (draft: TerminalProfileDraft) => Promise<TerminalProfile>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appSettings: null,
  credentials: [],
  terminalProfiles: [],
  shortcutDefinitions: [],
  mcpStatus: { enabled: false, endpoint: null, token: null },
  loading: false,
  error: null,
  async loadSettings() {
    set({ loading: true, error: null });
    try {
      const [appSettings, shortcutDefinitions, credentials, terminalProfiles, mcpStatus] = await Promise.all([
        invoke<AppSettings>("settings_get"),
        invoke<ShortcutDefinition[]>("shortcut_registry_list"),
        invoke<CredentialRecord[]>("credentials_list"),
        invoke<TerminalProfile[]>("terminal_profile_list"),
        invoke<McpServerStatus>("mcp_server_status"),
      ]);
      set({ appSettings, shortcutDefinitions, credentials, terminalProfiles, mcpStatus, loading: false });
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "设置操作失败") });
    }
  },
  async saveAppSettings(settings) {
    const saved = await invoke<AppSettings>("settings_save", { settings });
    set({ appSettings: saved });
    return saved;
  },
  async resetAppSettingsSection(section) {
    const saved = await invoke<AppSettings>("settings_reset", { section });
    set({ appSettings: saved });
    return saved;
  },
  async loadMcpStatus() {
    const status = await invoke<McpServerStatus>("mcp_server_status");
    set({ mcpStatus: status });
    return status;
  },
  async setMcpEnabled(enabled, port) {
    const status = await invoke<McpServerStatus>("mcp_server_set_enabled", { enabled, port: port ?? null });
    const appSettings = await invoke<AppSettings>("settings_get");
    set({ mcpStatus: status, appSettings });
    return status;
  },
  async rotateMcpToken() {
    const status = await invoke<McpServerStatus>("mcp_server_rotate_token");
    set({ mcpStatus: status });
    return status;
  },
  async saveCredential(draft) {
    const credential = await invoke<CredentialRecord>("credentials_save", { draft });
    await get().loadSettings();
    return credential;
  },
  async readCredentialSecret(credentialRef) {
    const result = await invoke<CredentialSecret>("credentials_read_secret", { credentialRef });
    return result.secret;
  },
  async deleteCredential(id) {
    await invoke("credentials_delete", { id });
    await get().loadSettings();
  },
  async testCredential(id) {
    await invoke("credentials_test", { id });
  },
  async detectTerminalProfiles() {
    const profiles = await invoke<TerminalProfile[]>("terminal_profile_detect");
    set({ terminalProfiles: profiles });
    return profiles;
  },
  async setDefaultTerminalProfile(draft) {
    const profile = await invoke<TerminalProfile>("terminal_profile_set_default", { draft });
    await get().loadSettings();
    return profile;
  },
}));
