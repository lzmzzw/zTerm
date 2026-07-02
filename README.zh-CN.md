# zTerm

[English](README.md)

zTerm 是一个基于 Tauri 的桌面终端工作台，面向 SSH、SFTP、命令历史、服务器监控和 AI 辅助运维场景。界面采用高密度工作区布局：左侧管理会话，中间使用分栏终端，右侧提供文件、历史、监控和 AI 工具。

![zTerm 工作台](assets/screenshots/workbench.png)

## 功能特性

- 保存、搜索、分组并打开 SSH/RDP/本地终端会话。
- SSH 会话通过系统 OpenSSH 客户端运行，并由 xterm 渲染输入输出。
- 支持终端标签、横向/纵向分栏和工作区恢复。
- 支持 SFTP 目录浏览、新建目录、上传、下载、重命名、删除和失败重试。
- 按会话或本地终端 profile 捕获命令历史，支持搜索、复制和重新发送。
- 凭据和 AI Provider API Key 写入操作系统 keyring，避免以明文保存在 SQLite 中。
- 右侧 AI 面板提供本地审批式候选命令、风险提示和终端上下文辅助。
- 支持 SSH 服务器 CPU、内存、磁盘、负载、运行时间和网络流量快照监控。

当前 RDP 功能是受控占位实现，不会发起真实 RDP 协议连接。云端模型调用和远程 Agent 工具编排不属于当前公开 MVP 范围。

## 界面截图

![四分屏终端工作区](assets/screenshots/split-terminals.png)

![文件传输](assets/screenshots/file-transfer.png)

![MCP 设置](assets/screenshots/mcp-settings.png)

## 环境要求

- Node.js `>=22.13`
- npm
- Rust stable toolchain
- 平台对应的 Tauri 系统依赖

Windows 构建建议使用 `x86_64-pc-windows-msvc` Rust target 和 Visual Studio Build Tools。

## 开发命令

```bash
npm install
npm run dev
npm run typecheck
npm run test:frontend
npm run build
```

Rust 和 Tauri 检查：

```bash
cd src-tauri
cargo fmt --check
cargo test
```

桌面安装包构建：

```bash
npm run tauri:build
```

## 发布

推送版本 tag 后，GitHub Actions 会自动构建 release 产物：

```bash
git tag v0.1.0
git push origin v0.1.0
```

发布 workflow 会构建四类目标：

- Windows x64
- Linux x64
- Linux Arm64
- macOS Arm64

未签名的 macOS 和 Windows 产物可能触发系统安全提示。后续可以通过 GitHub Actions 配置 Tauri 签名密钥来补充代码签名。

## 安全说明

不要提交真实主机、用户名、密码、API Key、私钥、token 或 smoke 测试环境文件。本地 AI agent 设置、内部项目说明、构建产物、运行时数据库和临时凭据默认会被忽略。

## 许可证

zTerm 使用 GNU General Public License version 3.0 only。详见 [LICENSE](LICENSE)。

第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
