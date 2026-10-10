# 工程验证与维护

修改 Agent 生命周期、rz/sz 或原生文件框前，先读 [终端回归经验](analysis/terminal-regression-lessons.md)。提交前至少覆盖受影响入口、结束/取消/失败/关闭路径；协议以真实双端验证字节和握手，原生窗口以运行库对照和安装版实测验证。一次优化不扩大为启动方式重写，未经实测支持的兼容尝试应撤销。

## 本地检查

使用 Node.js 22.13 或以上版本。Windows Rust 使用 stable MSVC 与 Visual Studio C++ Build Tools；脚本通过 rustup 的 cargo.exe 调用，不依赖同名第三方包装器。

```powershell
npm ci
npm run version:check
npm run check
npm run test:rust
powershell -NoProfile -File scripts/run-cargo-msvc.ps1 fmt --check
powershell -NoProfile -File scripts/run-cargo-msvc.ps1 clippy --lib -- -D warnings
```

Windows 测试 runner 为测试可执行文件写入 Common Controls v6 manifest，避免 GUI 依赖的 `TaskDialogIndirect` 入口缺失；正式应用沿用 Tauri 的 manifest。

<a id="webview2-152-指针兼容"></a>

### WebView2 152 及后续版本的指针兼容

Windows 上检测到 WebView2 主版本大于或等于 152 时，zTerm 主窗口禁用 `HideCursorWhileTyping`，避免键入 rz/sz 后打开原生文件框时指针持续不可见。兼容参数只作用于本应用，保留已有浏览器参数，不写系统鼠标设置、不固定或降级 WebView2。文件选择仍沿用 dialog 插件。151 及更早版本、版本查询失败或无法解析时不添加兼容参数。

依据为同一 zTerm 程序与原数据目录的实际对照：152 默认参数异常，152 仅禁用此功能后正常；另以 151 验证可见。上游记录见 [WebView2 #5687](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5687)，功能定义见 [Chromium ui_base_features.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/base/ui_base_features.cc)。此前仅匹配 152 的条件会使 Evergreen 升级后自动失去保护，因此不再设置未经实测的版本上界。此 feature flag 属于临时兼容措施，不表示所有后续版本均已确认存在上游缺陷。上游修复后复测键入、文件框确认/取消及终端恢复，再收窄范围或移除兼容代码；升级 Wry 时同步核对默认浏览器参数。

兼容回归测试覆盖 152、153、154 与后续版本，以及已有参数保留和 feature 去重。发布验收应核对 zTerm 实际 WebView2 子进程包含 `HideCursorWhileTyping` 禁用参数，并实测键入 `sz` 后的目录选择、确认、取消与终端恢复；版本判断测试不能替代实际指针可见性验证。

真实服务器和模型 smoke 保持显式启用，不作为默认测试副作用。前端 jsdom 测试不代表 WebView2、剪贴板、真实 SSH 或安装包已验收。

## 本地打包与正式发布

- `npm run tauri:build`：使用 `tauri.local.conf.json` 关闭 updater 签名产物生成，供本地验证。主配置的 updater 校验与权限不变。
- `npm run tauri:release`：使用主配置，必须提供 `TAURI_SIGNING_PRIVATE_KEY`；不在配置、日志或文档记录密钥。
- GitHub Release 依赖 Check 工作流通过，再执行现有签名构建与发布。普通 PR、main/master 提交也执行前端检查、Rust 测试及 Clippy。
- 本地未签名安装包不能冒充正式自动更新产物；发布行为仍需明确授权。

## 维护边界

终端输出 cursor 是单调递增的 UTF-8 字节位置，缓存裁剪不重置。`truncated` 表示请求范围已有淘汰或返回长度受限，详见 [API 契约](api-contract.md)。输出调度按固定期限刷新，避免持续繁忙连接拖延其他连接。

活动 Agent 目标同步由 `useActiveAgentTerminalSync` 顺序执行；运行时缓存与清理由 `terminalRuntimeResources` 统一管理。核心终端写入、调整大小、关闭及 Agent 活动目标 IPC 使用 `invokeTypedTauri` 限定参数，其他命令渐进迁移，禁止绕过统一 IPC 入口。

交互失败在操作位置反馈。快捷键尊重输入控件、弹窗和输入法组合；历史批量发送遇首个失败停止；传输动作按任务去重并将错误归属到连接。

终端数据先经 ZMODEM 处理、后台 replay 解析，再由可见 Xterm 按序写入并确认。前端使用保序 chunk 队列，避免 React 合并更新丢失片段；缓存清理不截断尚未消费的原始协议数据。`rz/sz` 故障事件不直接回显原始二进制，传输失败后清理协议状态和残留发送，详见 API 契约。

## Agent CLI 渲染

Windows Agent 子进程通过 `WT_SESSION=zterm-agent-conpty` 兼容标识选择 Codex 的 FullScreen 历史写入策略，`TERM_PROGRAM` 仍为 `zTerm`，不修改父进程环境。已核对 Codex CLI 0.153.4 的 [`ScrollbackStrategy::detect`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/tui/scrollback.rs)：未识别的终端默认使用局部 DEC 滚动区域，ConPTY 下可能丢弃历史或留下临时 composer 重绘内容。该标识只用于当前上游检测器的兼容，不代表实际运行 Windows Terminal；上游提供明确 ConPTY 能力开关或支持 zTerm 后应改用该入口。升级 CLI 时重验历史编号、重复/空白行、任务结束后的上翻阅读；既有会话需要重开 Agent 才应用新环境，已损坏的历史不会被恢复。

本地 ConPTY 回归探针使用固定编号内容，不启动模型或连接服务器。在仓库根目录执行：

```powershell
./scripts/run-cargo-msvc.ps1 build --example conpty_history_probe
./src-tauri/target/debug/examples/conpty_history_probe.exe src-tauri/target/conpty-standard.json
./src-tauri/target/debug/examples/conpty_history_probe.exe src-tauri/target/conpty-fullscreen.json --fullscreen
node scripts/inspect-conpty-history-probe.mjs src-tauri/target/conpty-standard.json src-tauri/target/conpty-fullscreen.json
```

该对照检查局部滚动区域增长导致的编号历史丢失，并断言 FullScreen 保留编号；两组均检查末尾标记与结果数量。它不复现截图中的全部空白和 `Working` 逐字残片，不能替代真实 Codex/WebView2 任务完成后的滚轮、拖动滚动条与恢复到底部验证。捕获只保存在被 Git 忽略的 `target` 下。

Agent Codex CLI 使用 `XtermPane.applicationMode`：保留默认色文本的语义配色与应用 ANSI 色，关闭跟随光标变化的整行背景和光标 CSS 闪烁动画，保留光标位置、形状及显隐控制。同步输出帧未结束时暂缓装饰刷新，同轮已收到的 live chunks 合并后按序写入，每片最多 65,536 字符；不注入 ANSI 或声称跨 PTY 事件的整帧原子性。

`followOutput` 仅在 viewport 位于底部时跟随。滚轮或拖动滚动条上翻后保留阅读位置，回到底部恢复；输出解析回调读取当前跟随状态，不能按写入前的状态强拉回底部。初始及后续 fit 必须先检查宿主宽高大于零，隐藏面板不向 PTY 上报极小尺寸。

普通 Shell 保留原有行背景、光标默认闪烁和 4,096 字符分片。回归覆盖文字配色、移动光标不重建行背景、同步控制字节保序、隐藏恢复尺寸、历史阅读及异步写入间上翻。浏览器需实测滚轮、拖动滚动条与恢复跟随；合成输出测试不能替代真实 WebView2/Codex CLI 视觉验收。证据：`AgentCodexPanel.tsx`、`XtermPane.tsx`、`terminalSemanticHighlight.ts` 及对应测试。

Agent 输出期间通过 `terminalCursorPresentation` 暂时屏蔽 DOM 光标装饰，保留字符内容；队列排空且最后一片输出解析后静默 120 ms，再刷新所有行并在下一动画帧恢复。新输出、切换流或卸载必须取消旧恢复回调，同步输出模式未结束时继续等待。CSS 优先级必须高于 xterm 对稳态块光标的 `!important`，验证须在终端聚焦时读取实际样式；不得隐藏整个 cursor span 或注入显隐 ANSI。该静默窗口是呈现策略而非 TUI 帧边界：连续输出期间光标暂不显示，超过窗口的分片间隔仍需实际 CLI 复验。
