# zTerm 开发文档

zTerm 使用 React 19、TypeScript、Vite 7 和 Tauri 2 / Rust，提供会话管理、分栏终端、文件传输、监控、历史与 Codex 侧栏。产品功能见 [中文说明](../README.zh-CN.md) 或 [English](../README.md)。

## 阅读入口

| 文档 | 内容 |
| --- | --- |
| [工程验证与维护](engineering.md) | 本地检查、Windows 构建、界面约定、终端渲染及原生验收边界 |
| [API 契约](api-contract.md) | Tauri IPC、终端事件、输出游标、ZMODEM 与错误约定 |
| [终端回归经验](analysis/terminal-regression-lessons.md) | Agent 历史、传输协议、WebView2 指针问题的排查与验收 |

本文只链接仓库中实际维护的文档。个人 `.agents/` 配置不随仓库发布，不作为公开工程规范的依赖。

## 代码职责

| 位置 | 职责 |
| --- | --- |
| `src/app/` | 应用外壳、标题栏、工具面板、快捷键与跨功能操作编排 |
| `src/features/terminal-layout/` | 标签、分栏、拖拽、布局持久化与恢复 |
| `src/features/terminal/` | xterm 渲染、输出消费、输入、命令提示与 ZMODEM |
| `src/features/sessions/`、`files/`、`history/`、`monitor/`、`ai/`、`settings/` | 各业务功能的界面、状态与 API 适配 |
| `src/components/`、`src/lib/` | 通用控件与基础能力；Tauri invoke/event 统一经过 `tauriClient.ts` |
| `src/styles/` | 主题 token、基础样式、外壳、功能样式及设计覆盖层 |
| `src-tauri/src/commands/` | Tauri 命令入口、参数与事件适配 |
| `src-tauri/src/services/` | 终端、SSH/SFTP、进程、传输、监控和 MCP 服务 |
| `src-tauri/src/storage/`、`models/` | SQLite 持久化、迁移与数据模型 |
| `src-tauri/tests/`、`src/**/*.test.*` | 后端集成测试与前端回归测试 |

基础层不得反向依赖 feature/app；feature 不依赖 app。接口归属与导出引用由 `npm run quality:check` 检查。修改 IPC 时同步核对 TypeScript、Rust serde model、command 注册和权限；修改终端时覆盖输出、取消、关闭和资源释放。

## 验证与发布

在仓库根目录执行 `npm run check` 和 `npm run version:check`。Windows 使用 `npm run test:rust` 与 MSVC 包装脚本进行 Rust 检查；具体命令及原生验收限制见 [工程文档](engineering.md#本地检查)。浏览器 Mock 与 jsdom 不代表真实 WebView2、SSH/SFTP 或安装包验收通过。

版本通过 `npm run version:set -- <major.minor.patch>` 同步。推送 `v<version>` tag 后，[Release workflow](../.github/workflows/release.yml) 先执行 Check，再构建 Windows x64、Linux x64/Arm64、macOS Arm64 与 updater 产物。Windows 使用 NSIS；本地打包和签名发布的区别见 [打包说明](engineering.md#本地打包与正式发布)。
