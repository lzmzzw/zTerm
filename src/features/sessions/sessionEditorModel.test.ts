// Author: Liz
import { describe, expect, it } from "vitest";

import {
  defaultLocalOptions,
  defaultRdpOptions,
  initialSessionAuthMode,
  sessionDefaultPort,
  sessionEditorDialogTitle,
  sessionEditorSections,
} from "./sessionEditorModel";
import type { SavedSession } from "./types";

function session(overrides: Partial<SavedSession>): SavedSession {
  return {
    id: overrides.id ?? "session-1",
    name: overrides.name ?? "Session",
    type: overrides.type ?? "ssh",
    group_id: null,
    host: "127.0.0.1",
    port: overrides.port ?? 22,
    username: "root",
    auth_mode: overrides.auth_mode ?? "password",
    credential_ref: null,
    description: null,
    tags: [],
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
    ssh_options: null,
    rdp_options: null,
    local_options: null,
    ...overrides,
  };
}

describe("sessionEditorModel", () => {
  it("keeps default options for non-SSH session types", () => {
    expect(defaultRdpOptions).toEqual({
      domain: null,
      width: 1440,
      height: 900,
      color_depth: 24,
      redirect_clipboard: true,
      fullscreen: false,
    });
    expect(defaultLocalOptions).toEqual({
      profile_id: null,
      working_directory: null,
      environment: [],
    });
  });

  it("returns editor defaults by session type", () => {
    expect(sessionDefaultPort("ssh")).toBe(22);
    expect(sessionDefaultPort("rdp")).toBe(3389);
    expect(sessionDefaultPort("local")).toBe(1);

    expect(sessionEditorSections("ssh")).toEqual(["属性", "跳板机", "隧道", "容器"]);
    expect(sessionEditorSections("local")).toEqual(["属性", "环境变量"]);
    expect(sessionEditorSections("rdp")).toEqual(["连接属性", "显示属性"]);
  });

  it("resolves initial auth mode without exposing unsupported SSH modes", () => {
    expect(initialSessionAuthMode(null, "local")).toBe("none");
    expect(initialSessionAuthMode(null, "rdp")).toBe("password");
    expect(initialSessionAuthMode(session({ auth_mode: "key" }), "ssh")).toBe("key");
    expect(initialSessionAuthMode(session({ auth_mode: "password" }), "ssh")).toBe("password");
    expect(initialSessionAuthMode(session({ auth_mode: "agent" }), "ssh")).toBe("password");
  });

  it("formats editor dialog titles from type and edit state", () => {
    expect(sessionEditorDialogTitle("ssh", false)).toBe("新建 SSH 会话");
    expect(sessionEditorDialogTitle("local", true)).toBe("编辑 LOCAL 会话");
    expect(sessionEditorDialogTitle("rdp", false)).toBe("新建 RDP 会话");
  });
});
