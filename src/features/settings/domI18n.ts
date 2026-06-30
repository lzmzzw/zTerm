// Author: Liz
import { useEffect } from "react";

import type { AppLanguage } from "./settingsStore";

const originalText = new WeakMap<Text, string>();
const ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;

const exact: Record<string, string> = {
  "设置分类": "Settings Sections",
  "工作区": "Workspace",
  "会话": "Sessions",
  "打开设置": "Open Settings",
  "添加文件夹": "Add Folder",
  "左侧管理": "Left Navigation",
  "左侧管理切换": "Left Navigation Switcher",
  "工作区管理": "Workspace Manager",
  "会话管理": "Session Manager",
  "模型管理": "Model Manager",
  "模型": "Models",
  "已添加模型列表": "Added Models",
  "暂无模型": "No models",
  "默认模型": "Default Model",
  "设为默认模型": "Set Default Model",
  "编辑": "Edit",
  "删除": "Delete",
  "模型配置": "Model Configuration",
  "关闭模型配置": "Close Model Configuration",
  "编辑模型": "Edit Model",
  "新增模型": "New Model",
  "模型名称": "Model Name",
  "协议类型": "Protocol",
  "模型 URL": "Model URL",
  "模型标识": "Model ID",
  "API Key（可选）": "API Key (Optional)",
  "留空则保留已保存 Key": "Leave blank to keep saved key",
  "启用": "Enabled",
  "测试输入": "Test Input",
  "测试输出": "Test Output",
  "等待测试输出": "Waiting for test output",
  "测试中": "Testing",
  "测试中...": "Testing...",
  "测试模型": "Test Model",
  "保存中": "Saving",
  "保存模型": "Save Model",
  "删除模型": "Delete Model",
  "取消删除模型": "Cancel Delete Model",
  "删除 AI 会话": "Delete AI Conversation",
  "取消删除 AI 会话": "Cancel Delete AI Conversation",
  "AI 输入区": "AI Composer",
  "取消": "Cancel",
  "确认删除": "Confirm Delete",
  "模型已保存": "Model saved",
  "保存模型失败": "Failed to save model",
  "请填写模型名称、模型 URL 和模型标识": "Fill in model name, model URL, and model ID",
  "Anthropic 模型需要 API Key": "Anthropic models require an API Key",
  "请填写测试输入": "Fill in test input",
  "模型测试通过": "Model test passed",
  "模型未返回文本": "Model returned no text",
  "测试模型失败": "Failed to test model",
  "默认模型已更新": "Default model updated",
  "设置默认模型失败": "Failed to set default model",
  "模型已删除": "Model deleted",
  "删除模型失败": "Failed to delete model",
  "连接类型": "Connection Type",
  "连接配置分组": "Connection Sections",
  "关闭会话编辑": "Close Session Editor",
  "新建 SSH 会话": "New SSH Session",
  "编辑 SSH 会话": "Edit SSH Session",
  "新建 LOCAL 会话": "New Local Session",
  "编辑 LOCAL 会话": "Edit Local Session",
  "新建 RDP 会话": "New RDP Session",
  "编辑 RDP 会话": "Edit RDP Session",
  "属性": "Properties",
  "连接属性": "Connection",
  "显示属性": "Display",
  "跳板机": "Jump Hosts",
  "隧道": "Tunnels",
  "容器": "Container",
  "环境变量": "Environment",
  "会话名称": "Session Name",
  "分组": "Group",
  "未分组": "Ungrouped",
  "主机": "Host",
  "端口": "Port",
  "用户名": "Username",
  "描述": "Description",
  "认证方式": "Authentication",
  "密码": "Password",
  "密钥": "Key",
  "认证状态": "Authentication Status",
  "请选择密码或密钥认证": "Select password or key authentication",
  "身份文件": "Identity File",
  "选择或输入 SSH 身份文件路径": "Select or enter SSH identity file path",
  "选择身份文件": "Select Identity File",
  "密钥密码": "Key Passphrase",
  "显示密码": "Show Password",
  "隐藏密码": "Hide Password",
  "显示密钥密码": "Show Key Passphrase",
  "隐藏密钥密码": "Hide Key Passphrase",
  "连接超时(ms)": "Connection Timeout (ms)",
  "连接超时": "Connection Timeout",
  "已有 SSH 主机": "Existing SSH Host",
  "请选择 SSH 主机": "Select SSH Host",
  "添加跳板机": "Add Jump Host",
  "暂无其他 SSH 主机": "No other SSH hosts",
  "暂无跳板机": "No jump hosts",
  "上移": "Move Up",
  "下移": "Move Down",
  "添加": "Add",
  "添加隧道": "Add Tunnel",
  "隧道用途": "Tunnel Purpose",
  "访问主机服务": "Access Host Service",
  "把主机服务映射到本机端口": "Map host service to a local port",
  "暴露本机服务": "Expose Local Service",
  "把本机服务暴露到主机端口": "Expose local service to a host port",
  "主机使用本机网络": "Host Uses Local Network",
  "让主机命令通过本机代理访问外部": "Let host commands access external networks through local proxy",
  "SOCKS / 高级": "SOCKS / Advanced",
  "创建 SOCKS 代理入口": "Create a SOCKS proxy entry",
  "暂无隧道": "No tunnels",
  "在连接时自动打开": "Open Automatically On Connect",
  "删除隧道": "Delete Tunnel",
  "用途": "Purpose",
  "名称": "Name",
  "主机目标地址": "Host Target Address",
  "主机目标端口": "Host Target Port",
  "本机监听范围": "Local Listen Scope",
  "本机监听端口": "Local Listen Port",
  "本机服务地址": "Local Service Address",
  "本机服务端口": "Local Service Port",
  "主机监听范围": "Host Listen Scope",
  "主机监听端口": "Host Listen Port",
  "本机代理地址": "Local Proxy Address",
  "本机代理端口": "Local Proxy Port",
  "主机代理入口范围": "Host Proxy Entry Scope",
  "主机代理入口端口": "Host Proxy Entry Port",
  "SOCKS 入口位置": "SOCKS Entry Location",
  "本机 (-D)": "Local (-D)",
  "主机 (remote -R)": "Host (remote -R)",
  "SOCKS 监听范围": "SOCKS Listen Scope",
  "SOCKS 监听端口": "SOCKS Listen Port",
  "启用容器": "Enable Container",
  "连接后进入容器": "Enter container after connection",
  "运行时": "Runtime",
  "容器运行时": "Container Runtime",
  "容器 ID 或名称": "Container ID or name",
  "容器 Shell": "Container Shell",
  "容器用户": "Container User",
  "容器工作目录": "Container Workdir",
  "终端 Profile": "Terminal Profile",
  "使用默认终端": "Use Default Terminal",
  "工作目录": "Working Directory",
  "留空使用终端默认目录": "Leave blank to use terminal default directory",
  "环境变量名": "Environment Variable Name",
  "环境变量值": "Environment Variable Value",
  "删除环境变量": "Delete Environment Variable",
  "暂无环境变量": "No environment variables",
  "域": "Domain",
  "凭据引用": "Credential Reference",
  "凭据引用（可选）": "Credential Reference (Optional)",
  "宽度": "Width",
  "高度": "Height",
  "色深": "Color Depth",
  "全屏": "Fullscreen",
  "剪贴板重定向": "Clipboard Redirection",
  "测试连接": "Test Connection",
  "保存会话": "Save Session",
  "请填写名称、主机、用户名和端口": "Fill in name, host, username, and port",
  "当前无法保存 SSH 密码凭据": "Cannot save SSH password credential",
  "请填写 SSH 密码": "Fill in SSH password",
  "当前无法保存 SSH 密钥密码凭据": "Cannot save SSH key passphrase credential",
  "当前无法保存 RDP 密码凭据": "Cannot save RDP password credential",
  "请填写 RDP 密码": "Fill in RDP password",
  "保存会话失败": "Failed to save session",
  "测试连接失败": "Connection test failed",
  "当前无法读取已保存的 SSH 密码 凭据": "Cannot read saved SSH password credential",
  "当前无法读取已保存的 SSH 密钥密码 凭据": "Cannot read saved SSH key passphrase credential",
  "读取已保存的 SSH 密码 失败": "Failed to read saved SSH password",
  "读取已保存的 SSH 密钥密码 失败": "Failed to read saved SSH key passphrase",
  "选择身份文件失败": "Failed to select identity file",
  "请选择": "Select",
  "搜索选择项": "Search Options",
  "搜索": "Search",
  "没有匹配项": "No matches",
  "底部面板": "Bottom Panel",
  "命令": "Command",
  "发送命令": "Send Command",
  "终端标签": "Terminal Tabs",
  "新增标签": "New Tab",
  "关闭标签": "Close Tab",
  "关闭分栏": "Close Pane",
  "横向分栏": "Split Horizontally",
  "纵向分栏": "Split Vertically",
  "终端分栏操作": "Terminal Pane Actions",
  "RDP 连接能力将在第二阶段启用": "RDP connection support will be enabled in phase two",
  "当前仅保存并展示 RDP 会话配置。": "Currently only saving and displaying RDP session configuration.",
  "已断开": "Disconnected",
  "最小化": "Minimize",
  "全屏切换": "Maximize",
  "恢复": "Restore",
  "关闭": "Close",
  "SSH 会话": "SSH Session",
  "Local 会话": "Local Session",
  "RDP 会话": "RDP Session",
};

const prefixes: Array<[string, string]> = [
  ["删除 AI 会话 ", "Delete AI Conversation "],
  ["确认删除 AI 会话", "Delete AI conversation"],
  ["编辑模型 ", "Edit Model "],
  ["删除模型 ", "Delete Model "],
  ["默认模型 ", "Default Model "],
  ["设为默认模型 ", "Set Default Model "],
  ["确认删除模型", "Delete model"],
  ["上移跳板机 ", "Move Jump Host Up "],
  ["下移跳板机 ", "Move Jump Host Down "],
  ["删除跳板机 ", "Delete Jump Host "],
  ["编辑会话 ", "Edit Session "],
  ["删除会话 ", "Delete Session "],
  ["分组操作 ", "Group Actions "],
  ["确认删除会话", "Delete session"],
  ["终端区域 ", "Terminal Area "],
  ["关闭标签 ", "Close Tab "],
  ["终端标签 ", "Terminal Tab "],
];

let applying = false;
let currentLanguage: AppLanguage = "zhCN";
const pendingRoots = new Set<Node>();
let pendingFlush = false;

export function useDomI18n(language: AppLanguage | null | undefined) {
  currentLanguage = language ?? "zhCN";
  useEffect(() => {
    if (typeof document === "undefined") return;
    currentLanguage = language ?? "zhCN";
    applyDomLanguage(currentLanguage);
    const observer = new MutationObserver((mutations) => {
      if (applying) return;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => scheduleTranslate(node));
        } else if (mutation.type === "attributes" || mutation.type === "characterData") {
          scheduleTranslate(mutation.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTES],
    });
    return () => observer.disconnect();
  }, [language]);
}

function applyDomLanguage(language: AppLanguage) {
  applying = true;
  try {
    translateElement(document.body, language);
  } finally {
    applying = false;
  }
}

function scheduleTranslate(root: Node) {
  pendingRoots.add(root);
  if (pendingFlush) return;
  pendingFlush = true;
  globalThis.queueMicrotask(() => {
    pendingFlush = false;
    if (applying || typeof document === "undefined") return;
    applying = true;
    try {
      for (const pendingRoot of pendingRoots) {
        translateNode(pendingRoot, currentLanguage);
      }
      pendingRoots.clear();
    } finally {
      applying = false;
    }
  });
}

function translateElement(root: Element, language: AppLanguage) {
  if (shouldSkipElement(root)) return;
  translateAttributes(root, language);
  root.childNodes.forEach((child) => {
    translateNode(child, language);
  });
}

function shouldSkipElement(element: Element) {
  if (["SCRIPT", "STYLE", "TEXTAREA"].includes(element.tagName)) return true;
  return element.matches(".xterm, .terminal, [data-no-i18n]");
}

function shouldSkipText(node: Text) {
  const parent = node.parentElement;
  if (!parent) return true;
  if (["SCRIPT", "STYLE", "TEXTAREA"].includes(parent.tagName)) return true;
  if (parent.closest(".xterm, .terminal, [data-no-i18n]")) return true;
  return !node.textContent?.trim();
}

function shouldTranslateAttribute(element: Element) {
  return !element.closest(".xterm, .terminal, [data-no-i18n]");
}

function translateAttributes(element: Element, language: AppLanguage) {
  if (!shouldTranslateAttribute(element)) return;
  ensureIconButtonTitle(element);
  for (const attr of ATTRIBUTES) {
    if (!element.hasAttribute(attr)) continue;
    const marker = `data-zt-i18n-${attr}`;
    const current = element.getAttribute(attr) ?? "";
    const previousSource = element.getAttribute(marker);
    const expectedTranslation = previousSource ? translate(previousSource) : null;
    const source = previousSource && (current === previousSource || current === expectedTranslation) ? previousSource : current;
    if (source !== previousSource) element.setAttribute(marker, source);
    const next = language === "enUS" ? translate(source) : source;
    if (element.getAttribute(attr) !== next) element.setAttribute(attr, next);
  }
}

function ensureIconButtonTitle(element: Element) {
  if (element.tagName !== "BUTTON") return;
  if (element.hasAttribute("title")) return;
  if (!element.querySelector("svg")) return;
  const label = element.getAttribute("aria-label");
  if (!label?.trim()) return;
  element.setAttribute("title", label);
}

function translateNode(root: Node, language: AppLanguage) {
  if (root instanceof Text) {
    translateTextNode(root, language);
    return;
  }
  if (root instanceof Element) {
    translateElement(root, language);
  }
}

function translateTextNode(node: Text, language: AppLanguage) {
  if (shouldSkipText(node)) return;
  const current = node.textContent ?? "";
  const previousSource = originalText.get(node);
  const expectedTranslation = previousSource ? translate(previousSource) : null;
  const source = previousSource && (current === previousSource || current === expectedTranslation) ? previousSource : current;
  if (!originalText.has(node) || source !== previousSource) originalText.set(node, source);
  const next = language === "enUS" ? translate(source) : source;
  if (node.textContent !== next) node.textContent = next;
}

function translate(value: string) {
  const trimmed = value.trim();
  const leading = value.slice(0, value.indexOf(trimmed));
  const trailing = value.slice(value.indexOf(trimmed) + trimmed.length);
  const exactMatch = exact[trimmed];
  if (exactMatch) return `${leading}${exactMatch}${trailing}`;
  for (const [from, to] of prefixes) {
    if (trimmed.startsWith(from)) return `${leading}${to}${trimmed.slice(from.length)}${trailing}`;
  }
  return value;
}
