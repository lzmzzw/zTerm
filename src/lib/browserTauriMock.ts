// Author: Liz
type BrowserMockArgs = Record<string, unknown> | undefined;
type BrowserEventCallback<T> = (event: { event: string; id: number; payload: T }) => void;
type BrowserUnlistenFn = () => void;

interface BrowserMockEnvironment {
  dev: boolean;
  mode: string;
  hasTauriRuntime: boolean;
}

const DEFAULT_SETTINGS = {
  language: "zhCN",
  theme: "dark",
  ui_font_size: 13,
  terminal_font_size: 13,
  default_right_tool: null,
  workspace_restore_strategy: "visible_first",
  mcp: { enabled: false, port: null },
  shortcuts: [],
};

const EMPTY_MCP_STATUS = { enabled: false, endpoint: null, token: null };

const startupHandlers: Record<string, (args: BrowserMockArgs) => unknown> = {
  settings_get: () => DEFAULT_SETTINGS,
  settings_save: (args) => args?.settings ?? DEFAULT_SETTINGS,
  settings_reset: () => DEFAULT_SETTINGS,
  shortcut_registry_list: () => [],
  credentials_list: () => [],
  terminal_profile_list: () => [],
  terminal_profile_detect: () => [],
  mcp_server_status: () => EMPTY_MCP_STATUS,
  mcp_server_set_enabled: (args) => ({ ...EMPTY_MCP_STATUS, enabled: args?.enabled === true }),
  mcp_server_rotate_token: () => EMPTY_MCP_STATUS,
  mcp_tool_catalog_list: () => [],
  mcp_tool_pending: () => [],
  mcp_connection_approval_mode_get: (args) => ({
    saved_session_id: stringArg(args, "savedSessionId"),
    approval_mode: "safe",
    updated_at_ms: 0,
  }),
  sessions_list: () => ({ groups: [], sessions: [] }),
  workspace_list: () => [],
  workspace_get: (args) => emptyWorkspaceDefinition(stringArg(args, "workspaceId") || "default"),
  workspace_save_default_snapshot: (args) => workspaceFromDraft(args?.draft),
  external_launch_take_pending: () => [],
  transfer_list: () => [],
  file_transfer_list: () => [],
  file_transfer_view_state_get: () => null,
  file_transfer_default_local_path: () => "C:\\Users\\Browser",
  file_transfer_local_roots: () => ["C:\\"],
  file_transfer_list_endpoint: () => [],
  history_search: () => [],
  history_command_group_list: () => [],
  command_completion_suggest: () => [],
  command_completion_resolve_cwd: () => null,
};

export function shouldUseBrowserTauriMock(environment: BrowserMockEnvironment) {
  return environment.dev && environment.mode === "browser" && !environment.hasTauriRuntime;
}

export function browserTauriMockEnabled() {
  return shouldUseBrowserTauriMock({
    dev: import.meta.env.DEV,
    mode: import.meta.env.MODE,
    hasTauriRuntime: "__TAURI_INTERNALS__" in globalThis,
  });
}

export async function invokeBrowserTauri<T>(command: string, args?: BrowserMockArgs): Promise<T> {
  markBrowserMockRuntime();
  const handler = startupHandlers[command];
  if (!handler) {
    throw new Error(`浏览器 Tauri Mock 尚未实现命令: ${command}`);
  }
  return handler(args) as T;
}

export async function listenBrowserTauri<T>(
  _event: string,
  _handler: BrowserEventCallback<T>,
): Promise<BrowserUnlistenFn> {
  markBrowserMockRuntime();
  return () => undefined;
}

function markBrowserMockRuntime() {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.ztRuntime = "browser-mock";
  }
}

function stringArg(args: BrowserMockArgs, key: string) {
  const value = args?.[key];
  return typeof value === "string" ? value : "";
}

function emptyWorkspaceDefinition(id: string) {
  return {
    id,
    name: id === "default" ? "默认工作区" : id,
    status: "running",
    active_tab_id: "",
    tabs: [],
    sort_order: 0,
    created_at_ms: 0,
    updated_at_ms: 0,
  };
}

function workspaceFromDraft(value: unknown) {
  if (!value || typeof value !== "object") return emptyWorkspaceDefinition("default");
  return {
    ...value,
    id: "id" in value && typeof value.id === "string" ? value.id : "default",
    created_at_ms: 0,
    updated_at_ms: 0,
  };
}
