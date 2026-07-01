// Author: Liz
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { SessionTree } from "./SessionTree";
import type { SavedSession, SessionGroup } from "./types";
import type { CredentialRecord } from "../settings/settingsStore";

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match as HTMLButtonElement;
}

function input(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Input not found: ${label}`);
  }
  return match as HTMLInputElement;
}

function inputs(container: HTMLElement, label: string) {
  const matches = Array.from(container.querySelectorAll(`[aria-label="${label}"]`));
  if (matches.length === 0) {
    throw new Error(`Inputs not found: ${label}`);
  }
  return matches as HTMLInputElement[];
}

function select(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"][role="combobox"]`);
  if (!match) {
    throw new Error(`Select not found: ${label}`);
  }
  return match as HTMLButtonElement;
}

function dialog(container: HTMLElement) {
  const match = container.querySelector('[role="dialog"]');
  if (!match) {
    throw new Error("Dialog not found");
  }
  return match as HTMLElement;
}

function editorFields(container: HTMLElement) {
  const match = container.querySelector(".zt-session-editor-fields");
  if (!match) {
    throw new Error("Editor fields not found");
  }
  return match as HTMLElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function chooseSelect(container: HTMLElement, label: string, value: string) {
  await click(select(container, label));
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.getAttribute("data-value") === value,
  );
  if (!option) {
    throw new Error(`Option not found: ${label}=${value}`);
  }
  await click(option as HTMLElement);
}

async function openSelectOptions(container: HTMLElement, label: string) {
  await click(select(container, label));
  return Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[];
}

async function doubleClick(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
}

async function contextMenu(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 16 }));
  });
}

function change(element: HTMLInputElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const groups: SessionGroup[] = [
  {
    id: "group-prod",
    parent_id: null,
    name: "生产环境",
    expanded: true,
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
  },
];

const sessions: SavedSession[] = [
  {
    id: "ssh-prod",
    name: "生产跳板机",
    type: "ssh",
    group_id: "group-prod",
    host: "10.0.0.10",
    port: 22,
    username: "deploy",
    auth_mode: "key",
    credential_ref: "cred-prod",
    description: null,
    tags: ["prod"],
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
  },
  {
    id: "rdp-office",
    name: "办公 RDP",
    type: "rdp",
    group_id: null,
    host: "rdp.example.test",
    port: 3389,
    username: "ops",
    auth_mode: "password",
    credential_ref: "cred-rdp",
    description: null,
    tags: ["windows"],
    sort_order: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
    rdp_options: {
      domain: "CORP",
      width: 1440,
      height: 900,
      color_depth: 24,
      redirect_clipboard: true,
    },
  },
  {
    id: "ssh-log",
    name: "日志节点",
    type: "ssh",
    group_id: null,
    host: "logs.example.test",
    port: 22,
    username: "log",
    auth_mode: "agent",
    credential_ref: null,
    description: null,
    tags: ["logs"],
    sort_order: 2,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
  },
  {
    id: "ssh-web",
    name: "Web 节点",
    type: "ssh",
    group_id: null,
    host: "web.example.test",
    port: 2222,
    username: "web",
    auth_mode: "password",
    credential_ref: "cred-web",
    description: null,
    tags: ["web"],
    sort_order: 3,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
  },
  {
    id: "local-pwsh",
    name: "本机 PowerShell",
    type: "local",
    group_id: null,
    host: "localhost",
    port: 1,
    username: "",
    auth_mode: "none",
    credential_ref: null,
    description: null,
    tags: ["local"],
    sort_order: 4,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
    local_options: {
      profile_id: "pwsh",
      working_directory: "C:\\Users\\ops",
      environment: [
        {
          name: "ZTERM_ENV",
          value: "enabled",
        },
      ],
    },
  },
];

describe("SessionTree", () => {
  it("removes the search box and top-level add session buttons", () => {
    const view = render(<SessionTree groups={groups} sessions={sessions} />);

    expect(view.container.querySelector('[aria-label="搜索会话"]')).toBeNull();
    expect(() => button(view.container, "新增 SSH")).toThrow();
    expect(() => button(view.container, "新增 RDP")).toThrow();
    expect(view.container.textContent).toContain("生产跳板机");
    expect(view.container.textContent).toContain("本机 PowerShell");
    expect(view.container.textContent).not.toContain("10.0.0.10");
    expect(view.container.textContent).not.toContain("localhost");

    view.unmount();
  });

  it("creates a folder from the session panel context menu", async () => {
    const onSaveGroup = vi.fn();
    const promptSpy = vi.spyOn(window, "prompt");
    const view = render(<SessionTree groups={[]} sessions={[]} onSaveGroup={onSaveGroup} />);

    await contextMenu(view.container.querySelector(".zt-session-tree") as HTMLElement);
    const rootMenuItems = Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
    expect(rootMenuItems).toEqual(["添加连接", "新建分组"]);
    expect(view.container.textContent).not.toContain("编辑");
    expect(view.container.textContent).not.toContain("删除");
    expect(view.container.textContent).not.toContain("建立新连接");
    expect(view.container.textContent).toContain("添加连接");
    await click(button(view.container, "新建分组"));
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("新建组");
    change(input(view.container, "文件夹名称"), "数据库");
    await click(button(view.container, "确定"));

    expect(promptSpy).not.toHaveBeenCalled();
    expect(onSaveGroup).toHaveBeenCalledWith({
      parent_id: null,
      name: "数据库",
      expanded: true,
      sort_order: 0,
    });

    promptSpy.mockRestore();
    view.unmount();
  });

  it("keeps fixed fallback text when folder save fails with a non-Error value", async () => {
    const onSaveGroup = vi.fn().mockRejectedValue("raw save failure");
    const view = render(<SessionTree groups={[]} sessions={[]} onSaveGroup={onSaveGroup} />);

    await contextMenu(view.container.querySelector(".zt-session-tree") as HTMLElement);
    await click(button(view.container, "新建分组"));
    change(input(view.container, "文件夹名称"), "数据库");
    await click(button(view.container, "确定"));

    expect(onSaveGroup).toHaveBeenCalled();
    expect(view.container.textContent).toContain("保存文件夹失败");
    expect(view.container.textContent).not.toContain("raw save failure");

    view.unmount();
  });

  it("creates a new SSH connection in a group from the group action menu", async () => {
    const onSaveSession = vi.fn();
    const view = render(<SessionTree groups={groups} sessions={sessions} onSaveSession={onSaveSession} />);

    await click(button(view.container, "分组操作 生产环境"));
    await click(button(view.container, "新建连接"));

    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("新建 SSH 会话");
    expect(select(view.container, "分组").value).toBe("group-prod");
    expect(view.container.textContent).toContain("SSH");
    expect(view.container.textContent).toContain("Local");
    expect(view.container.textContent).toContain("RDP");
    expect(view.container.querySelectorAll(".zt-session-type-tabs svg")).toHaveLength(3);
    expect(view.container.querySelectorAll(".zt-session-editor-nav svg")).toHaveLength(0);
    expect(view.container.textContent).toContain("容器");
    expect(view.container.textContent).toContain("属性");
    expect(select(view.container, "认证方式").value).toBe("password");
    await chooseSelect(view.container, "认证方式", "key");
    change(input(view.container, "会话名称"), "生产新节点");
    change(input(view.container, "主机"), "10.0.0.11");
    change(input(view.container, "用户名"), "deploy");
    change(input(view.container, "身份文件"), "C:\\Users\\ops\\.ssh\\id_ed25519");
    await click(button(view.container, "保存会话"));

    expect(onSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ssh",
        name: "生产新节点",
        group_id: "group-prod",
        host: "10.0.0.11",
        auth_mode: "key",
        ssh_options: expect.objectContaining({
          identity_file: "C:\\Users\\ops\\.ssh\\id_ed25519",
        }),
      }),
    );

    view.unmount();
  });

  it("opens a new connection dialog from the blank session area context menu", async () => {
    const view = render(<SessionTree groups={[]} sessions={[]} />);

    await contextMenu(view.container.querySelector(".zt-session-tree") as HTMLElement);
    await click(button(view.container, "添加连接"));

    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("新建 SSH 会话");
    expect(view.container.textContent).toContain("属性");
    expect(view.container.textContent).not.toContain("代理");
    expect(view.container.textContent).toContain("跳板机");
    expect(view.container.textContent).toContain("隧道");
    expect(view.container.textContent).toContain("容器");

    view.unmount();
  });

  it("locks the connection type tabs when editing an existing SSH session", async () => {
    const view = render(<SessionTree groups={groups} sessions={sessions} />);

    await click(button(view.container, "编辑会话 生产跳板机"));

    expect(button(view.container, "SSH").disabled).toBe(false);
    expect(button(view.container, "Local").disabled).toBe(true);
    expect(button(view.container, "RDP").disabled).toBe(true);
    expect(dialog(view.container).textContent).not.toContain("标签");
    expect(dialog(view.container).textContent).not.toContain("ProxyCommand");
    expect(dialog(view.container).textContent).not.toContain("代理");
    expect(dialog(view.container).textContent).not.toContain("凭据引用");
    expect(dialog(view.container).textContent).toContain("跳板机");
    expect(dialog(view.container).textContent).toContain("隧道");
    expect(dialog(view.container).textContent).toContain("容器");
    expect(editorFields(view.container).textContent).toContain("认证方式");
    const authOptions = await openSelectOptions(view.container, "认证方式");
    expect(authOptions.map((option) => option.getAttribute("data-value"))).toEqual(["password", "key"]);
    expect(authOptions.map((option) => option.textContent)).toEqual(["密码", "密钥"]);
    await click(select(view.container, "认证方式"));
    expect(editorFields(view.container).textContent).not.toContain("在连接时自动打开");

    await click(button(view.container, "跳板机"));
    expect(editorFields(view.container).textContent).toContain("跳板机");
    expect(editorFields(view.container).textContent).not.toContain("认证方式");

    await click(button(view.container, "隧道"));
    await click(button(view.container, "添加"));
    expect(editorFields(view.container).textContent).toContain("在连接时自动打开");
    expect(editorFields(view.container).textContent).not.toContain("认证方式");

    await click(button(view.container, "容器"));
    expect(editorFields(view.container).textContent).toContain("启用容器入口");
    expect(editorFields(view.container).textContent).not.toContain("在连接时自动打开");

    view.unmount();
  });

  it("configures SSH container entry without a default container target", async () => {
    const view = render(<SessionTree groups={groups} sessions={sessions} />);

    await click(button(view.container, "编辑会话 生产跳板机"));
    await click(button(view.container, "容器"));

    const runtimeOptions = await openSelectOptions(view.container, "容器运行时");
    expect(runtimeOptions.map((option) => option.getAttribute("data-value"))).toEqual([
      "docker",
      "podman",
      "nerdctl",
    ]);
    expect(runtimeOptions.map((option) => option.textContent)).toEqual([
      "Docker",
      "Podman",
      "containerd (nerdctl)",
    ]);
    await click(select(view.container, "容器运行时"));

    expect(editorFields(view.container).querySelector('input[aria-label="容器"]')).toBeNull();
    expect(editorFields(view.container).textContent).not.toContain("容器 ID 或名称");
    expect(input(view.container, "容器 Shell").placeholder).toBe("/bin/sh");
    expect(input(view.container, "容器工作目录").placeholder).toBe("/app");
    expect(input(view.container, "容器用户")).not.toBeNull();

    view.unmount();
  });

  it("adds saved SSH sessions as ordered jump hosts and excludes the current session", async () => {
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const view = render(<SessionTree groups={groups} sessions={sessions} onSaveSession={onSaveSession} />);

    await click(button(view.container, "编辑会话 生产跳板机"));
    await click(button(view.container, "跳板机"));

    const hostOptions = await openSelectOptions(view.container, "已有 SSH 主机");
    expect(hostOptions.map((option) => option.textContent)).toEqual([
      "请选择 SSH 主机",
      "log@logs.example.test",
      "web@web.example.test",
    ]);
    expect(hostOptions.map((option) => option.getAttribute("data-value"))).not.toContain("ssh-prod");
    await click(select(view.container, "已有 SSH 主机"));

    await chooseSelect(view.container, "已有 SSH 主机", "ssh-log");
    await click(button(view.container, "添加跳板机"));
    expect(editorFields(view.container).textContent).toContain("log@logs.example.test");

    await chooseSelect(view.container, "已有 SSH 主机", "ssh-web");
    await click(button(view.container, "添加跳板机"));
    await click(button(view.container, "上移跳板机 web@web.example.test"));

    const jumpItems = Array.from(view.container.querySelectorAll(".zt-ssh-jump-host-label")).map((item) => item.textContent);
    expect(jumpItems).toEqual(["web@web.example.test", "log@logs.example.test"]);

    await click(button(view.container, "删除跳板机 log@logs.example.test"));
    await click(button(view.container, "保存会话"));

    expect(onSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ssh-prod",
        ssh_options: expect.objectContaining({
          jump_hosts: ["web@web.example.test"],
        }),
      }),
    );

    view.unmount();
  });

  it("saves SSH tunnel presets for host service and remote SOCKS", async () => {
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const view = render(<SessionTree groups={groups} sessions={sessions} onSaveSession={onSaveSession} />);

    await click(button(view.container, "编辑会话 生产跳板机"));
    await click(button(view.container, "隧道"));

    expect(editorFields(view.container).textContent).toContain("访问主机服务");
    expect(editorFields(view.container).textContent).toContain("暴露本机服务");
    expect(editorFields(view.container).textContent).toContain("主机使用本机网络");
    expect(editorFields(view.container).textContent).toContain("SOCKS / 高级");
    expect(editorFields(view.container).textContent).not.toContain("把主机服务映射到本机端口");
    expect(editorFields(view.container).textContent).not.toContain("把本机服务暴露到主机端口");
    const hostServicePreset = button(view.container, "访问主机服务");
    const hostServicePresetText = hostServicePreset.textContent ?? "";
    expect(hostServicePresetText.indexOf("访问主机服务")).toBeLessThan(hostServicePresetText.indexOf("-L"));

    await click(button(view.container, "访问主机服务"));
    await click(button(view.container, "添加隧道"));
    expect(editorFields(view.container).textContent).not.toContain("用途");
    expect(editorFields(view.container).textContent).not.toContain("名称");
    expect(input(view.container, "主机目标地址").readOnly).toBe(true);
    expect(input(view.container, "主机目标地址").value).toBe("10.0.0.10");
    change(input(view.container, "隧道名称"), "PostgreSQL 隧道");
    change(input(view.container, "主机目标端口"), "5432");
    change(input(view.container, "本机监听端口"), "15432");

    await click(button(view.container, "SOCKS / 高级"));
    await click(button(view.container, "添加隧道"));
    change(inputs(view.container, "隧道名称")[1], "主机 SOCKS");
    await chooseSelect(view.container, "SOCKS 入口位置", "remote");
    change(input(view.container, "SOCKS 监听端口"), "11080");
    await click(button(view.container, "保存会话"));

    expect(onSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ssh-prod",
        ssh_options: expect.objectContaining({
          tunnels: [
            expect.objectContaining({
              mode: "host_service",
              name: "PostgreSQL 隧道",
              kind: "local",
              auto_open: true,
              bind_address: "127.0.0.1",
              local_port: 15432,
              remote_host: "10.0.0.10",
              remote_port: 5432,
            }),
            expect.objectContaining({
              mode: "socks",
              name: "主机 SOCKS",
              kind: "remote_dynamic",
              auto_open: true,
              bind_address: "127.0.0.1",
              local_port: 11080,
              remote_host: null,
              remote_port: null,
            }),
          ],
        }),
      }),
    );

    view.unmount();
  });

  it("shows local environment variables without proxy or jump-host sections", async () => {
    const view = render(<SessionTree groups={groups} sessions={sessions} />);

    await click(button(view.container, "编辑会话 本机 PowerShell"));

    expect(button(view.container, "SSH").disabled).toBe(true);
    expect(button(view.container, "Local").disabled).toBe(false);
    expect(button(view.container, "RDP").disabled).toBe(true);
    expect(dialog(view.container).textContent).not.toContain("标签");
    expect(dialog(view.container).textContent).not.toContain("代理");
    expect(dialog(view.container).textContent).not.toContain("跳板机");
    expect(dialog(view.container).textContent).toContain("环境变量");
    expect(editorFields(view.container).textContent).toContain("工作目录");
    expect(editorFields(view.container).textContent).not.toContain("环境变量名");

    await click(button(view.container, "环境变量"));
    expect(input(view.container, "环境变量名").value).toBe("ZTERM_ENV");
    expect(input(view.container, "环境变量值").value).toBe("enabled");

    view.unmount();
  });

  it("shows RDP password, connection properties, and display properties only", async () => {
    const view = render(<SessionTree groups={groups} sessions={sessions} />);

    await click(button(view.container, "编辑会话 办公 RDP"));

    expect(button(view.container, "SSH").disabled).toBe(true);
    expect(button(view.container, "Local").disabled).toBe(true);
    expect(button(view.container, "RDP").disabled).toBe(false);
    expect(dialog(view.container).textContent).not.toContain("标签");
    expect(dialog(view.container).textContent).not.toContain("代理");
    expect(dialog(view.container).textContent).not.toContain("跳板机");
    expect(dialog(view.container).textContent).toContain("连接属性");
    expect(dialog(view.container).textContent).toContain("显示属性");
    expect(editorFields(view.container).textContent).toContain("密码");
    expect(editorFields(view.container).textContent).not.toContain("宽度");
    expect(dialog(view.container).textContent).not.toContain("凭据引用");
    expect(input(view.container, "密码").type).toBe("password");
    expect(input(view.container, "密码").placeholder).toBe("******");
    expect(() => button(view.container, "显示密码")).not.toThrow();

    await click(button(view.container, "显示属性"));
    expect(editorFields(view.container).textContent).toContain("宽度");
    expect(editorFields(view.container).textContent).not.toContain("密码");

    view.unmount();
  });

  it("shows a validation error when deleting a non-empty group fails", async () => {
    const onDeleteGroup = vi.fn().mockRejectedValue(new Error("分组下仍有会话，不能删除"));
    const view = render(<SessionTree groups={groups} sessions={sessions} onDeleteGroup={onDeleteGroup} />);

    await click(button(view.container, "分组操作 生产环境"));
    await click(button(view.container, "删除"));

    expect(onDeleteGroup).toHaveBeenCalledWith("group-prod");
    expect(view.container.textContent).toContain("分组下仍有会话，不能删除");

    view.unmount();
  });

  it("reveals an existing RDP password from its saved credential only after the eye button is clicked", async () => {
    const onReadCredential = vi.fn().mockResolvedValue("saved-rdp-password");
    const onSaveCredential = vi.fn();
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SessionTree
        {...({
          groups,
          sessions,
          onReadCredential,
          onSaveCredential,
          onSaveSession,
        } as unknown as ComponentProps<typeof SessionTree>)}
      />,
    );

    await click(button(view.container, "编辑会话 办公 RDP"));

    expect(input(view.container, "密码").value).toBe("");
    expect(input(view.container, "密码").type).toBe("password");
    expect(input(view.container, "密码").placeholder).toBe("******");
    expect(onReadCredential).not.toHaveBeenCalled();

    await click(button(view.container, "显示密码"));

    expect(onReadCredential).toHaveBeenCalledWith("cred-rdp");
    expect(input(view.container, "密码").value).toBe("saved-rdp-password");
    expect(input(view.container, "密码").type).toBe("text");

    await click(button(view.container, "保存会话"));

    expect(onSaveCredential).not.toHaveBeenCalled();
    expect(onSaveSession).toHaveBeenCalledWith(expect.objectContaining({ credential_ref: "cred-rdp" }));

    view.unmount();
  });

  it("saves a typed RDP password as a credential ref before saving an edited session", async () => {
    const credential: CredentialRecord = {
      id: "rdp-office-password",
      name: "办公 RDP RDP 密码",
      kind: "rdp_password",
      credential_ref: "credential:rdp-office-password",
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    const onSaveCredential = vi.fn().mockResolvedValue(credential);
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const secret = "phase-rdp-password";
    const view = render(
      <SessionTree
        groups={groups}
        sessions={sessions}
        onSaveSession={onSaveSession}
        onSaveCredential={onSaveCredential}
      />,
    );

    await click(button(view.container, "编辑会话 办公 RDP"));
    expect(dialog(view.container).textContent).not.toContain("凭据引用");
    await click(button(view.container, "显示密码"));
    change(input(view.container, "密码"), secret);
    await click(button(view.container, "保存会话"));

    expect(onSaveCredential).toHaveBeenCalledWith({
      name: "办公 RDP RDP 密码",
      kind: "rdp_password",
      secret,
    });
    expect(onSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rdp-office",
        type: "rdp",
        auth_mode: "password",
        credential_ref: "credential:rdp-office-password",
      }),
    );
    expect(onSaveSession).not.toHaveBeenCalledWith(expect.objectContaining({ credential_ref: secret }));
    expect(view.container.textContent).not.toContain(secret);

    view.unmount();
  });

  it("keeps fixed fallback text when deleting a group fails with a non-Error value", async () => {
    const onDeleteGroup = vi.fn().mockRejectedValue("raw group delete failure");
    const view = render(<SessionTree groups={groups} sessions={sessions} onDeleteGroup={onDeleteGroup} />);

    await click(button(view.container, "分组操作 生产环境"));
    await click(button(view.container, "删除"));

    expect(onDeleteGroup).toHaveBeenCalledWith("group-prod");
    expect(view.container.textContent).toContain("删除分组失败");
    expect(view.container.textContent).not.toContain("raw group delete failure");

    view.unmount();
  });

  it("opens a session from a tree node double click and context menu", async () => {
    const onOpenSession = vi.fn();
    const view = render(<SessionTree groups={groups} sessions={sessions} onOpenSession={onOpenSession} />);

    const sessionButton = Array.from(view.container.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("日志节点"),
    );
    if (!sessionButton) {
      throw new Error("Session button not found");
    }

    await doubleClick(sessionButton);
    await contextMenu(sessionButton);
    await click(button(view.container, "建立新连接"));

    expect(onOpenSession).toHaveBeenCalledTimes(2);
    expect(onOpenSession).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ssh-log" }));

    view.unmount();
  });

  it("edits a session from the row icon and deletes a session after confirmation", async () => {
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm");
    const view = render(
      <SessionTree
        groups={groups}
        sessions={sessions}
        onSaveSession={onSaveSession}
        onDeleteSession={onDeleteSession}
      />,
    );

    await click(button(view.container, "编辑会话 日志节点"));
    expect(input(view.container, "会话名称").value).toBe("日志节点");
    expect(input(view.container, "主机").value).toBe("logs.example.test");
    await chooseSelect(view.container, "认证方式", "key");
    change(input(view.container, "主机"), "logs.internal.test");
    await click(button(view.container, "保存会话"));
    expect(onSaveSession).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-log", host: "logs.internal.test", auth_mode: "key" }));

    await click(button(view.container, "删除会话 日志节点"));
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("删除会话");
    expect(view.container.textContent).toContain("确认删除会话“日志节点”？");
    await click(button(view.container, "确认删除"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onDeleteSession).toHaveBeenCalledWith("ssh-log");

    confirmSpy.mockRestore();
    view.unmount();
  });

  it("keeps fixed fallback text when saving a session fails with a non-Error value", async () => {
    const onSaveSession = vi.fn().mockRejectedValue("raw session save failure");
    const view = render(<SessionTree groups={groups} sessions={sessions} onSaveSession={onSaveSession} />);

    await click(button(view.container, "编辑会话 本机 PowerShell"));
    await click(button(view.container, "保存会话"));

    expect(onSaveSession).toHaveBeenCalled();
    expect(view.container.textContent).toContain("保存会话失败");
    expect(view.container.textContent).not.toContain("raw session save failure");

    view.unmount();
  });

  it("keeps fixed fallback text when testing a session fails with a non-Error value", async () => {
    const onTestSession = vi.fn().mockRejectedValue("raw test failure");
    const view = render(<SessionTree groups={groups} sessions={sessions} onTestSession={onTestSession} />);

    await click(button(view.container, "编辑会话 日志节点"));
    await click(button(view.container, "测试连接"));

    expect(onTestSession).toHaveBeenCalled();
    expect(view.container.textContent).toContain("测试连接失败");
    expect(view.container.textContent).not.toContain("raw test failure");

    view.unmount();
  });

  it("keeps fixed fallback text when deleting a session fails with a non-Error value", async () => {
    const onDeleteSession = vi.fn().mockRejectedValue("raw session delete failure");
    const view = render(<SessionTree groups={groups} sessions={sessions} onDeleteSession={onDeleteSession} />);

    await click(button(view.container, "删除会话 日志节点"));
    await click(button(view.container, "确认删除"));

    expect(onDeleteSession).toHaveBeenCalledWith("ssh-log");
    expect(view.container.textContent).toContain("删除会话失败");
    expect(view.container.textContent).not.toContain("raw session delete failure");

    view.unmount();
  });

  it("saves a typed SSH password as a credential ref before saving an edited session", async () => {
    const credential: CredentialRecord = {
      id: "ssh-prod-password",
      name: "生产跳板机 SSH 密码",
      kind: "ssh_password",
      credential_ref: "credential:ssh-prod-password",
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    const onSaveCredential = vi.fn().mockResolvedValue(credential);
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const secret = "phase9-ui-password";
    const view = render(
      <SessionTree
        groups={groups}
        sessions={sessions}
        onSaveSession={onSaveSession}
        onSaveCredential={onSaveCredential}
      />,
    );

    await click(button(view.container, "编辑会话 生产跳板机"));
    await chooseSelect(view.container, "认证方式", "password");
    expect(dialog(view.container).textContent).not.toContain("凭据引用");
    expect(input(view.container, "密码").type).toBe("password");
    await click(button(view.container, "显示密码"));
    expect(input(view.container, "密码").type).toBe("text");
    change(input(view.container, "密码"), secret);
    await click(button(view.container, "保存会话"));

    expect(onSaveCredential).toHaveBeenCalledWith({
      name: "生产跳板机 SSH 密码",
      kind: "ssh_password",
      secret,
    });
    expect(onSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ssh-prod",
        type: "ssh",
        name: "生产跳板机",
        auth_mode: "password",
        credential_ref: "credential:ssh-prod-password",
      }),
    );
    expect(onSaveSession).not.toHaveBeenCalledWith(expect.objectContaining({ credential_ref: secret }));
    expect(view.container.textContent).not.toContain(secret);

    view.unmount();
  });

  it("reveals an existing SSH password from its saved credential only after the eye button is clicked", async () => {
    const passwordSession: SavedSession = {
      id: "ssh-password",
      name: "密码节点",
      type: "ssh",
      group_id: null,
      host: "password.example.test",
      port: 22,
      username: "deploy",
      auth_mode: "password",
      credential_ref: "credential:ssh-password",
      description: null,
      tags: [],
      sort_order: 10,
      created_at_ms: 1,
      updated_at_ms: 1,
      last_used_at_ms: null,
    };
    const onReadCredential = vi.fn().mockResolvedValue("saved-password");
    const onSaveCredential = vi.fn();
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SessionTree
        {...({
          groups: [],
          sessions: [passwordSession],
          onReadCredential,
          onSaveCredential,
          onSaveSession,
        } as unknown as ComponentProps<typeof SessionTree>)}
      />,
    );

    await click(button(view.container, "编辑会话 密码节点"));

    expect(input(view.container, "密码").value).toBe("");
    expect(input(view.container, "密码").type).toBe("password");
    expect(input(view.container, "密码").placeholder).toBe("******");
    expect(onReadCredential).not.toHaveBeenCalled();

    await click(button(view.container, "显示密码"));

    expect(onReadCredential).toHaveBeenCalledWith("credential:ssh-password");
    expect(input(view.container, "密码").value).toBe("saved-password");
    expect(input(view.container, "密码").type).toBe("text");

    await click(button(view.container, "保存会话"));

    expect(onSaveCredential).not.toHaveBeenCalled();
    expect(onSaveSession).toHaveBeenCalledWith(expect.objectContaining({ credential_ref: "credential:ssh-password" }));

    view.unmount();
  });

  it("keeps fixed fallback text when reading a saved SSH password fails with a non-Error value", async () => {
    const passwordSession: SavedSession = {
      id: "ssh-password",
      name: "密码节点",
      type: "ssh",
      group_id: null,
      host: "password.example.test",
      port: 22,
      username: "deploy",
      auth_mode: "password",
      credential_ref: "credential:ssh-password",
      description: null,
      tags: [],
      sort_order: 10,
      created_at_ms: 1,
      updated_at_ms: 1,
      last_used_at_ms: null,
    };
    const onReadCredential = vi.fn().mockRejectedValue("raw read failure");
    const view = render(
      <SessionTree
        {...({
          groups: [],
          sessions: [passwordSession],
          onReadCredential,
        } as unknown as ComponentProps<typeof SessionTree>)}
      />,
    );

    await click(button(view.container, "编辑会话 密码节点"));
    await click(button(view.container, "显示密码"));

    expect(onReadCredential).toHaveBeenCalledWith("credential:ssh-password");
    expect(view.container.textContent).toContain("读取已保存的 SSH 密码 失败");
    expect(view.container.textContent).not.toContain("raw read failure");

    view.unmount();
  });

  it("reveals an existing SSH key passphrase from its saved credential only after the eye button is clicked", async () => {
    const onReadCredential = vi.fn().mockResolvedValue("saved-key-passphrase");
    const view = render(
      <SessionTree
        {...({
          groups,
          sessions,
          onReadCredential,
        } as unknown as ComponentProps<typeof SessionTree>)}
      />,
    );

    await click(button(view.container, "编辑会话 生产跳板机"));

    expect(input(view.container, "密钥密码").value).toBe("");
    expect(input(view.container, "密钥密码").type).toBe("password");
    expect(input(view.container, "密钥密码").placeholder).toBe("******");
    expect(onReadCredential).not.toHaveBeenCalled();

    await click(button(view.container, "显示密钥密码"));

    expect(onReadCredential).toHaveBeenCalledWith("cred-prod");
    expect(input(view.container, "密钥密码").value).toBe("saved-key-passphrase");
    expect(input(view.container, "密钥密码").type).toBe("text");

    view.unmount();
  });

  it("selects an SSH public key file, masks its passphrase, and saves it as key auth", async () => {
    const credential: CredentialRecord = {
      id: "ssh-prod-key-passphrase",
      name: "生产跳板机 SSH 密钥密码",
      kind: "ssh_key_passphrase",
      credential_ref: "credential:ssh-prod-key-passphrase",
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    const onSaveCredential = vi.fn().mockResolvedValue(credential);
    const onSaveSession = vi.fn().mockResolvedValue(undefined);
    const onSelectSshKeyFile = vi.fn().mockResolvedValue("C:\\Users\\ops\\.ssh\\id_ed25519");
    const secret = "phase9-key-passphrase";
    const view = render(
      <SessionTree
        {...({
          groups,
          sessions,
          onSaveSession,
          onSaveCredential,
          onSelectSshKeyFile,
        } as unknown as ComponentProps<typeof SessionTree>)}
      />,
    );

    await click(button(view.container, "编辑会话 生产跳板机"));
    await chooseSelect(view.container, "认证方式", "key");
    await click(button(view.container, "选择身份文件"));

    expect(onSelectSshKeyFile).toHaveBeenCalledTimes(1);
    expect(input(view.container, "身份文件").value).toBe("C:\\Users\\ops\\.ssh\\id_ed25519");
    expect(input(view.container, "密钥密码").type).toBe("password");
    await click(button(view.container, "显示密钥密码"));
    expect(input(view.container, "密钥密码").type).toBe("text");
    change(input(view.container, "密钥密码"), secret);
    await click(button(view.container, "保存会话"));

    expect(onSaveCredential).toHaveBeenCalledWith({
      name: "生产跳板机 SSH 密钥密码",
      kind: "ssh_key_passphrase",
      secret,
    });
    expect(onSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ssh-prod",
        type: "ssh",
        auth_mode: "key",
        credential_ref: "credential:ssh-prod-key-passphrase",
        ssh_options: expect.objectContaining({
          identity_file: "C:\\Users\\ops\\.ssh\\id_ed25519",
        }),
      }),
    );
    expect(view.container.textContent).not.toContain(secret);

    view.unmount();
  });

  it("keeps fixed fallback text when selecting an SSH key file fails with a non-Error value", async () => {
    const onSelectSshKeyFile = vi.fn().mockRejectedValue("raw key select failure");
    const view = render(
      <SessionTree
        {...({
          groups,
          sessions,
          onSelectSshKeyFile,
        } as unknown as ComponentProps<typeof SessionTree>)}
      />,
    );

    await click(button(view.container, "编辑会话 生产跳板机"));
    await chooseSelect(view.container, "认证方式", "key");
    await click(button(view.container, "选择身份文件"));

    expect(onSelectSshKeyFile).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("选择身份文件失败");
    expect(view.container.textContent).not.toContain("raw key select failure");

    view.unmount();
  });
});
