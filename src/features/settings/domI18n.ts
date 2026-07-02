// Author: Liz
import { useEffect } from "react";

import type { AppLanguage } from "./settingsStore";

const originalText = new WeakMap<Text, string>();
const ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;

const exact: Record<string, string> = {
  "设置分类": "Settings Sections",
  "标题栏": "Title Bar",
  "工作区": "Workspace",
  "会话": "Sessions",
  "Session": "Session",
  "文件传输": "File Transfer",
  "打开设置": "Open Settings",
  "添加文件夹": "Add Folder",
  "左侧管理": "Left Navigation",
  "左侧管理切换": "Left Navigation Switcher",
  "右侧工具栏": "Right Tools",
  "工具切换": "Tool Switcher",
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
  "模型基础配置": "Model Base Configuration",
  "模型测试": "Model Test",
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
  "单轮测试": "Single Turn Test",
  "发送测试消息": "Send Test Message",
  "取消测试": "Cancel Test",
  "已取消": "Cancelled",
  "测试模型": "Test Model",
  "取消模型测试失败": "Failed to cancel model test",
  "保存中": "Saving",
  "保存模型": "Save Model",
  "删除模型": "Delete Model",
  "取消删除模型": "Cancel Delete Model",
  "删除 AI 会话": "Delete AI Conversation",
  "取消删除 AI 会话": "Cancel Delete AI Conversation",
  "AI 操作台": "AI Console",
  "当前绑定窗格": "Current Bound Pane",
  "AI 会话消息": "AI Conversation Messages",
  "AI 工具调用": "AI Tool Calls",
  "AI 输入区": "AI Composer",
  "取消": "Cancel",
  "确定": "OK",
  "确认": "Confirm",
  "确认删除": "Confirm Delete",
  "清屏": "Clear Screen",
  "复制": "Copy",
  "粘贴": "Paste",
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
  "添加连接": "Add Connection",
  "新建分组": "New Group",
  "新建连接": "New Connection",
  "建立新连接": "Open New Connection",
  "编辑组": "Edit Group",
  "新建组": "New Group",
  "文件夹名称": "Folder Name",
  "请填写文件夹名称": "Fill in folder name",
  "关闭分组编辑": "Close Group Editor",
  "会话树": "Session Tree",
  "未分组会话": "Ungrouped Sessions",
  "暂无会话": "No sessions",
  "删除会话": "Delete Session",
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
  "删除跳板机": "Delete Jump Host",
  "添加隧道": "Add Tunnel",
  "编辑隧道": "Edit Tunnel",
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
  "仅本机 (127.0.0.1)": "Local Only (127.0.0.1)",
  "所有网络 (0.0.0.0)": "All Networks (0.0.0.0)",
  "启用容器": "Enable Container",
  "启用容器入口": "Enable container entry",
  "运行时": "Runtime",
  "容器类型": "Container Type",
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
  "当前无法读取已保存的 RDP 密码凭据": "Cannot read saved RDP password credential",
  "读取已保存的 RDP 密码失败": "Failed to read saved RDP password",
  "当前无法读取已保存的 SSH 密码 凭据": "Cannot read saved SSH password credential",
  "当前无法读取已保存的 SSH 密钥密码 凭据": "Cannot read saved SSH key passphrase credential",
  "读取已保存的 SSH 密码 失败": "Failed to read saved SSH password",
  "读取已保存的 SSH 密钥密码 失败": "Failed to read saved SSH key passphrase",
  "选择身份文件失败": "Failed to select identity file",
  "选择 SSH 身份文件": "Select SSH Identity File",
  "请选择": "Select",
  "搜索选择项": "Search Options",
  "搜索": "Search",
  "没有匹配项": "No matches",
  "选择连接": "Select Connection",
  "关闭选择连接": "Close Connection Picker",
  "取消选择连接": "Cancel Connection Picker",
  "选择默认本地终端": "Select Default Local Terminal",
  "默认本地终端": "Default Local Terminal",
  "传输冲突": "Transfer Conflict",
  "关闭传输冲突": "Close Transfer Conflict",
  "取消传输冲突": "Cancel Transfer Conflict",
  "跳过冲突项": "Skip Conflicts",
  "自动重命名冲突项": "Auto Rename Conflicts",
  "覆盖冲突项": "Overwrite Conflicts",
  "跳过": "Skip",
  "自动重命名": "Auto Rename",
  "覆盖": "Overwrite",
  "底部面板": "Bottom Panel",
  "命令": "Command",
  "发送命令": "Send Command",
  "终端标签": "Terminal Tabs",
  "新增标签": "New Tab",
  "新建终端": "New Terminal",
  "创建连接": "Create Connection",
  "连接中": "Connecting",
  "等待连接": "Waiting to Connect",
  "连接失败": "Connection Failed",
  "正在连接": "Connecting",
  "正在准备": "Preparing",
  "关闭标签": "Close Tab",
  "关闭分栏": "Close Pane",
  "关闭当前标签": "Close Current Tab",
  "关闭当前分栏": "Close Current Pane",
  "横向分栏": "Split Horizontally",
  "纵向分栏": "Split Vertically",
  "终端分栏操作": "Terminal Pane Actions",
  "终端分栏": "Terminal Panes",
  "空终端分栏": "Empty Terminal Pane",
  "连接建立后终端会自动显示。": "The terminal will appear automatically after the connection is established.",
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
  "加载工作区失败": "Failed to load workspace",
  "自动关闭后台工作区失败": "Failed to auto-close background workspace",
  "当前没有可保存的工作区": "No workspace can be saved",
  "新建工作区": "New Workspace",
  "加载工作区编辑失败": "Failed to load workspace editor",
  "保存工作区失败": "Failed to save workspace",
  "关闭工作区运行时失败": "Failed to close workspace runtime",
  "关闭工作区失败": "Failed to close workspace",
  "默认工作区不能删除": "Default workspace cannot be deleted",
  "工作区不存在或已删除": "Workspace does not exist or has been deleted",
  "删除工作区运行时失败": "Failed to close workspace runtime before delete",
  "删除工作区失败": "Failed to delete workspace",
  "恢复工作区失败": "Failed to restore workspace",
  "加载工作区缩略图失败": "Failed to load workspace preview",
  "工作区标签": "Workspace Tabs",
  "工作区标签属性": "Workspace Tab Properties",
  "编辑工作区": "Edit Workspace",
  "关闭工作区编辑": "Close Workspace Editor",
  "保存工作区": "Save Workspace",
  "编辑工作区名称": "Edit Workspace Name",
  "暂无工作区": "No workspaces",
  "暂无工作区标签": "No workspace tabs",
  "选择一个分栏以编辑连接和路径": "Select a pane to edit connection and path",
  "连接": "Connection",
  "编辑标签连接": "Edit Tab Connection",
  "缺失连接": "Missing Connection",
  "路径": "Path",
  "编辑标签路径": "Edit Tab Path",
  "连接后指令": "Post-connect Command",
  "编辑连接后指令": "Edit Post-connect Command",
  "恢复失败": "Restore failed",
  "运行中": "Running",
  "已关闭": "Closed",
  "关闭工作区": "Close Workspace",
  "删除工作区": "Delete Workspace",
  "确认删除工作区": "Confirm Delete Workspace",
  "目标分栏不存在": "Target pane does not exist",
  "打开终端失败": "Failed to open terminal",
  "加载容器失败": "Failed to load containers",
  "进入容器失败": "Failed to enter container",
  "保存文件夹失败": "Failed to save folder",
  "打开 SSH 会话后显示远程文件": "Open an SSH session to show remote files",
  "远程路径": "Remote Path",
  "加载中": "Loading",
  "暂无文件": "No files",
  "远程文件列表": "Remote File List",
  "释放以上传到当前目录": "Release to upload to the current directory",
  "上传": "Upload",
  "新建目录": "New Folder",
  "刷新目录": "Refresh Directory",
  "不显示隐藏文件": "Hide Hidden Files",
  "显示隐藏文件": "Show Hidden Files",
  "新建文件夹": "New Folder",
  "文件夹路径": "Folder Path",
  "请填写文件夹路径": "Fill in folder path",
  "重命名": "Rename",
  "重命名为": "Rename To",
  "请填写新名称": "Fill in new name",
  "选择要上传的文件或文件夹": "Select files or folders to upload",
  "选择下载目录": "Select download directory",
  "传输任务": "Transfer Tasks",
  "传输任务列表": "Transfer Task List",
  "传输任务批量操作": "Transfer Batch Actions",
  "暂停全部传输任务": "Pause All Transfers",
  "恢复全部传输任务": "Resume All Transfers",
  "清理全部传输任务": "Clear All Transfers",
  "暂停全部": "Pause All",
  "恢复全部": "Resume All",
  "清理全部": "Clear All",
  "清理传输任务": "Clear Transfer Tasks",
  "清理全部任务会取消进行中的传输并删除任务记录，确认清理？": "Clearing all tasks will cancel active transfers and delete task records. Continue?",
  "确认清理": "Confirm Clear",
  "删除传输任务": "Delete Transfer Task",
  "删除运行中传输会先取消该任务，确认删除？": "Deleting a running transfer will cancel it first. Continue?",
  "展开传输任务": "Expand Transfer Tasks",
  "折叠传输任务": "Collapse Transfer Tasks",
  "暂无传输任务": "No transfer tasks",
  "暂停": "Pause",
  "重试": "Retry",
  "当前 SSH 连接": "Current SSH Connection",
  "刷新容器": "Refresh Containers",
  "刷新": "Refresh",
  "返回上级": "Go Up",
  "刷新文件列表": "Refresh File List",
  "上级目录": "Parent Directory",
  "下载": "Download",
  "文件操作失败": "File operation failed",
  "文件传输操作失败": "File transfer operation failed",
  "文件传输需要 Tauri 运行环境": "File transfer requires the Tauri runtime",
  "文件传输面板": "File Transfer Panel",
  "文件传输方向": "File Transfer Direction",
  "冲突策略": "Conflict Policy",
  "左侧": "Left",
  "右侧": "Right",
  "本机": "Local",
  "请选择 SSH 主机或本机端点": "Select an SSH host or local endpoint",
  "传输到右侧": "Transfer Right",
  "传输到左侧": "Transfer Left",
  "刷新任务": "Refresh Tasks",
  "刷新文件传输任务": "Refresh File Transfer Tasks",
  "正在加载容器...": "Loading containers...",
  "当前 SSH 连接没有容器": "Current SSH connection has no containers",
  "SSH 容器列表": "SSH Container List",
  "进入容器": "Enter Container",
  "临时隧道": "Transient Tunnel",
  "仅当前临时 SSH 连接有效": "Only valid for the current transient SSH connection",
  "配置已更新，重连后生效": "Configuration updated; reconnect to apply",
  "添加临时 SSH 隧道": "Add Transient SSH Tunnel",
  "重连": "Reconnect",
  "重连临时 SSH": "Reconnect Transient SSH",
  "当前 SSH 连接没有配置隧道": "Current SSH connection has no tunnels configured",
  "SSH 隧道列表": "SSH Tunnel List",
  "SSH 隧道": "SSH Tunnel",
  "临时 SSH 隧道": "Transient SSH Tunnel",
  "关闭临时 SSH 隧道编辑": "Close Transient SSH Tunnel Editor",
  "临时隧道保存后需要重连当前 SSH 才会生效。": "Reconnect the current SSH connection for transient tunnel changes to take effect.",
  "保存临时隧道": "Save Transient Tunnel",
  "手动打开": "Open Manually",
  "连接时自动打开": "Open On Connect",
  "监听": "Listen",
  "监听端口": "Listen Port",
  "目标": "Target",
  "工作区舞台": "Workspace Stage",
  "已断开连接": "Disconnected",
  "断开连接失败": "Failed to disconnect",
  "重新连接失败": "Failed to reconnect",
  "读取临时 SSH 配置失败": "Failed to read transient SSH configuration",
  "更新临时 SSH 容器类型失败": "Failed to update transient SSH container runtime",
  "保存临时 SSH 隧道失败": "Failed to save transient SSH tunnel",
  "当前没有活动终端": "No active terminal",
  "发送命令失败": "Failed to send command",
  "历史命令操作失败": "Command history operation failed",
  "会话操作失败": "Session operation failed",
  "删除分组失败": "Failed to delete group",
  "删除会话失败": "Failed to delete session",
  "恢复标签失败": "Failed to restore tab",
  "连接已缺失": "Connection missing",
  "保存会话不存在": "Saved session does not exist",
  "容器目标缺失": "Container target missing",
  "AI Agent 操作失败": "AI Agent operation failed",
  "AI 会话预览加载失败": "Failed to load AI conversation preview",
  "设置操作失败": "Settings operation failed",
  "请输入指令组名称": "Enter a command group name",
  "请输入至少一条命令": "Enter at least one command",
  "指令组保存失败": "Failed to save command group",
  "打开 SSH 会话后显示资源监控": "Open an SSH session to show resource monitoring",
  "正在读取服务器信息": "Reading server information",
  "正在读取服务器信息...": "Reading server information...",
  "等待首次采集": "Waiting for first sample",
  "服务器信息采集间隔": "Server info sampling interval",
  "刷新服务器信息": "Refresh Server Info",
  "手动": "Manual",
  "系统": "System",
  "主机名": "Hostname",
  "运行时间": "Uptime",
  "核心数": "Cores",
  "平均使用": "Average Usage",
  "未识别": "Unknown",
  "内存": "Memory",
  "磁盘": "Disk",
  "挂载点": "Mount",
  "已用": "Used",
  "可用": "Available",
  "总计": "Total",
  "网络": "Network",
  "等待网络采样": "Waiting for network sample",
  "采样中": "Sampling",
  "排行首位": "Top Interface",
  "上行": "Upload",
  "下行": "Download",
  "等待采样": "Waiting for sample",
  "进程": "Processes",
  "使用率": "Usage",
  "显存": "VRAM",
  "温度": "Temperature",
  "驱动": "Driver",
  "型号": "Model",
  "远端未返回 GPU 数据。": "The remote host returned no GPU data.",
  "远端没有 nvidia-smi 或 lspci，无法识别 GPU。": "The remote host has no nvidia-smi or lspci, so GPU detection is unavailable.",
  "nvidia-smi 未返回可用 NVIDIA GPU。": "nvidia-smi returned no available NVIDIA GPU.",
  "lspci 未发现显卡设备。": "lspci found no GPU device.",
  "仅通过 lspci 静态识别，无法采集显存和温度。": "Detected statically through lspci only; VRAM and temperature cannot be collected.",
  "RDP 连接占位": "RDP Connection Placeholder",
  "选择要通过 rz 上传的文件": "Select files to upload through rz",
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
  ["分组 ", "Group "],
  ["确认删除会话", "Delete session"],
  ["选择连接 ", "Select Connection "],
  ["切换工作区 ", "Switch Workspace "],
  ["编辑工作区 ", "Edit Workspace "],
  ["恢复工作区 ", "Restore Workspace "],
  ["关闭工作区 ", "Close Workspace "],
  ["删除工作区 ", "Delete Workspace "],
  ["工作区视图 ", "Workspace View "],
  ["工作区标签 ", "Workspace Tab "],
  ["切换工作区标签 ", "Switch Workspace Tab "],
  ["工作区 ", "Workspace "],
  ["终端区域 ", "Terminal Area "],
  ["关闭标签 ", "Close Tab "],
  ["终端标签 ", "Terminal Tab "],
  ["正在连接 ", "Connecting "],
  ["等待连接 ", "Waiting to Connect "],
  ["连接失败 ", "Connection Failed "],
  ["正在准备 ", "Preparing "],
  ["进入容器 ", "Enter Container "],
  ["暂停 ", "Pause "],
  ["恢复 ", "Resume "],
  ["取消 ", "Cancel "],
  ["重试 ", "Retry "],
  ["删除 ", "Delete "],
  ["复制 ", "Copy "],
  ["发送 ", "Send "],
  ["选择 ", "Select "],
];

const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^(.+) 副本$/, (match) => `${match[1]} Copy`],
  [/^确认删除工作区“(.+)”？删除后该工作区定义和布局快照将无法恢复。$/, (match) =>
    `Delete workspace "${match[1]}"? Its definition and layout snapshot cannot be restored after deletion.`],
  [/^检测到 (\d+) 个同名目标。$/, (match) => `Detected ${match[1]} target name conflict(s).`],
  [/^确认删除选中的 (\d+) 个项目$/, (match) => `Delete ${match[1]} selected item(s)`],
  [/^(\d+) 个进行中$/, (match) => `${match[1]} active`],
  [/^(\d+) 个任务$/, (match) => `${match[1]} task(s)`],
  [/^(.+) 进度$/, (match) => `${match[1]} progress`],
  [/^容器: (.+)$/, (match) => `Container: ${match[1]}`],
  [/^当前无法读取已保存的 (.+) 凭据$/, (match) => `Cannot read saved ${match[1]} credential`],
  [/^读取已保存的 (.+) 失败$/, (match) => `Failed to read saved ${match[1]}`],
  [/^(.+) SSH 密码$/, (match) => `${match[1]} SSH Password`],
  [/^(.+) SSH 密钥密码$/, (match) => `${match[1]} SSH Key Passphrase`],
  [/^(.+) RDP 密码$/, (match) => `${match[1]} RDP Password`],
  [/^(.+)刷新$/, (match) => `${translate(match[1])} Refresh`],
  [/^(.+)返回上级$/, (match) => `${translate(match[1])} Go Up`],
  [/^(.+)隐藏隐藏文件$/, (match) => `${translate(match[1])} Hide Hidden Files`],
  [/^(.+)显示隐藏文件$/, (match) => `${translate(match[1])} Show Hidden Files`],
  [/^收起(.+)详情$/, (match) => `Collapse ${translate(match[1])} Details`],
  [/^展开(.+)详情$/, (match) => `Expand ${translate(match[1])} Details`],
  [/^流量排行 (.+)$/, (match) => `Top traffic ${match[1]}`],
  [/^上次采集 (.+)$/, (match) => `Last sampled ${match[1]}`],
  [/^(.+) 张$/, (match) => `${match[1]} GPU(s)`],
  [/^(.+) 核$/, (match) => `${match[1]} core(s)`],
  [/^(.+) 个$/, (match) => `${match[1]} item(s)`],
  [/^(.+) 个 \/ 运行 (.+)$/, (match) => `${match[1]} item(s) / ${match[2]} running`],
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
  for (const [pattern, replace] of patterns) {
    const match = trimmed.match(pattern);
    if (match) return `${leading}${replace(match)}${trailing}`;
  }
  for (const [from, to] of prefixes) {
    if (trimmed.startsWith(from)) return `${leading}${to}${trimmed.slice(from.length)}${trailing}`;
  }
  return value;
}
