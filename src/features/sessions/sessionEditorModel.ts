// Author: Liz
import type { AuthMode, LocalOptions, RdpOptions, SavedSession, SessionType } from "./types";

export const defaultRdpOptions: RdpOptions = {
  domain: null,
  width: 1440,
  height: 900,
  color_depth: 24,
  redirect_clipboard: true,
  fullscreen: false,
};

export const defaultLocalOptions: LocalOptions = {
  profile_id: null,
  working_directory: null,
  environment: [],
};

export function sessionDefaultPort(type: SessionType): number {
  if (type === "ssh") return 22;
  if (type === "rdp") return 3389;
  return 1;
}

export function sessionEditorDialogTitle(type: SessionType, editing: boolean): string {
  const typeLabel = type.toUpperCase();
  return editing ? `编辑 ${typeLabel} 会话` : `新建 ${typeLabel} 会话`;
}

export function initialSessionAuthMode(
  initialSession: SavedSession | null | undefined,
  type: SessionType,
): AuthMode {
  if (type === "local") return "none";
  if (type === "rdp") return "password";
  return initialSession?.auth_mode === "key" || initialSession?.auth_mode === "password"
    ? initialSession.auth_mode
    : "password";
}

export function sessionEditorSections(type: SessionType): string[] {
  if (type === "ssh") return ["属性", "跳板机", "隧道", "容器"];
  if (type === "local") return ["属性", "环境变量"];
  return ["连接属性", "显示属性"];
}
