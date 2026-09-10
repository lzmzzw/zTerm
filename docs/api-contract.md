---
文档类型: API 说明
适用任务: 修改 Tauri IPC command、前端 invoke 调用、事件 payload 或模型 wire shape 前阅读
必读前置: AGENTS.md, docs/README.md
禁止场景: 只修改纯样式、纯文案或不影响接口契约的内部实现时不必阅读
权威等级: 工程规则
当前状态: 生效
---

# zTerm API Contract

本文记录当前 MVP 已实现的 Tauri IPC 和事件契约。结构化模型字段使用 snake_case；前端调用单个 Rust 参数时按现有 Tauri invoke 约定使用 camelCase 包装键，例如 `savedSessionId` 对应 Rust `saved_session_id`。所有 command 返回 `Result<T, AppError>`，错误由 Rust `AppError` 序列化，敏感内容在进入错误消息前脱敏。

## Sessions

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `sessions_list` | 无 | `{ groups, sessions }` | 加载会话树 |
| `sessions_save_group` | `SessionGroupDraft` | `SessionGroup` | 新增或更新分组 |
| `sessions_delete_group` | `{ id }` | `{ deleted: true }` | 删除空分组；非空返回 `Validation` |
| `sessions_save_session` | `SavedSessionDraft` | `SavedSession` | 保存 SSH/Local/RDP/FTP/SFTP 会话 |
| `sessions_delete_session` | `{ id }` | `{ deleted: true }` | 删除会话 |
| `sessions_test_connection` | `SavedSessionDraft`, `secret?` | `{ ok, message }` | 真实连接测试：SSH/SFTP 建立短命令 exec；FTP 登录并读取工作目录；RDP 验证端口连通和凭据可读但不启动 `mstsc.exe`；Local 校验实际终端 profile 可执行文件和工作目录 |
| `sessions_export_csv` | `{ targetPath: string }` | `{ path, exported_records }` | 仅在用户于会话树明确确认明文风险并通过系统保存对话框选择 `.csv` 路径后调用；后端将所有分组和连接写入 CSV，凭据仅在写入阶段从 OS keyring 读取，明文不会经 IPC 返回、写入 SQLite 或日志 |

`SavedSession.type` 支持 `ssh`、`local`、`rdp`、`ftp`、`sftp`；默认端口分别为 22、1、3389、21、22。FTP 使用 `ftp_options` 保存 `connect_timeout_ms`、`initial_directory`、`passive_mode` 和 `anonymous`；FTP 是明文协议，本契约不将 FTPS 隐式合并到 FTP。SFTP 复用 `ssh_options` 的密码/密钥、连接超时、keepalive、ProxyCommand 和跳板机配置，但不开放终端隧道或容器入口。SSH `ssh_options` 支持 `connect_timeout_ms`、`keepalive_interval_ms`、`identity_file`、兼容旧数据的 `proxy_command`、`jump_hosts`、`tunnels` 和 `container`；`jump_hosts` 保持字符串数组，打开终端时会按 `username@host` 匹配本地已保存 SSH 会话，读取匹配跳板机的 keyring secret 并按 OpenSSH prompt 目标自动填充；隧道类型为 `local`、`remote`、`dynamic`、`remote_dynamic`，可选 `mode` 表达 `host_service`、`local_service`、`local_network`、`socks` 业务用途，可选 `name` 用于 UI 回显，`auto_open=true` 时随 SSH 连接生成 OpenSSH 转发参数；`local` 生成 `-L [bind:]local_port:remote_host:remote_port`，`remote` 生成 `-R [bind:]local_port:remote_host:remote_port`，`dynamic` 生成 `-D [bind:]local_port`，`remote_dynamic` 生成远端 SOCKS `-R [bind:]local_port`；`auth_mode=key` 且 `identity_file` 非空时生成 OpenSSH `-i` 参数；`container.enabled=true` 只表示右侧容器工具可用，普通 `terminal_open` 仍进入远端宿主机；旧 `container.container` 字段仅保留 wire 兼容，不作为普通打开或新 UI 的默认容器目标。`sessions_test_connection` 可接收仅用于本次测试的 `secret`，用于未保存的 SSH/RDP 密码或 SSH 密钥密码，不写入 SQLite 或 OS keyring；未提供 `secret` 时通过 `credential_ref` 读取 OS keyring。SSH 测试使用已有 SSH command service 真实连接目标并执行短命令；Local 使用 `local_options.profile_id`、`working_directory` 和 `environment`，测试时验证将要使用的 profile 可执行文件和工作目录。RDP 使用 `rdp_options.domain`、`width`、`height`、`color_depth`、`redirect_clipboard`、`fullscreen`，密码通过 `credential_ref` 指向 zTerm OS keyring；测试时只验证 RDP 端口连通和凭据可读取，不启动 `mstsc.exe`，也不声明远端登录凭据已被服务器接受；打开 RDP 时后端从 keyring 读取 secret，写入 Windows Credential Manager 的 `TERMSRV/<full address>` PasswordCredential，临时 `.rdp` 文件不写 `password 51` 字段。

## Settings

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `settings_get` | 无 | `AppSettings` | 读取语言、主题、字号、默认右侧工具、工作区恢复策略和快捷键 |
| `settings_save` | `AppSettings` | `AppSettings` | 保存应用设置 |
| `settings_reset` | `{ section: "general" \| "shortcuts" }` | `AppSettings` | 立即恢复并保存指定设置页默认值；`general` 保留快捷键，`shortcuts` 保留通用设置 |
| `shortcut_registry_list` | 无 | `ShortcutDefinition[]` | 返回应用内可配置快捷键动作 |
| `mcp_server_status` | 无 | `McpServerStatus` | 返回本机 MCP 服务运行态；若设置已启用但服务未启动，会懒启动 |
| `mcp_server_set_enabled` | `{ enabled, port? }` | `McpServerStatus` | 启用或关闭本机 MCP Streamable HTTP 服务，并同步保存 `AppSettings.mcp` |
| `mcp_server_rotate_token` | 无 | `McpServerStatus` | 轮换当前运行期 Bearer token；token 不写入 `AppSettings` |
| `mcp_tool_catalog_list` | 无 | `McpToolDefinition[]` | 返回 MCP 专用 allowlist、风险信息和输入 schema，供设置页展示 |
| `agent_codex_open` | `{ tabId, targetRuntimeSessionId, targetSavedSessionId?, targetLabel }` | `AgentCodexSession` | 按目标普通 SSH 的 `saved_session_id` 复用或启动唯一的本机 Codex CLI PTY（无标识或容器终端按 runtime 隔离）；`tabId` 仅保留参数兼容，不作为会话身份，注入 Visible Terminal Profile 的会话级 MCP 身份，并显式设置 `TERM=xterm-256color`、`COLORTERM=truecolor` 与 `TERM_PROGRAM=zTerm`，避免继承宿主的 `TERM=dumb` 导致交互式 TUI 降级；初始绑定目标可省略 runtime 参数；初始普通 SSH runtime 关闭后仅回退到相同连接的普通 SSH runtime，无可用目标时返回错误，容器目标不回退；显式指定 runtime 时按该目标校验，不自动替换。不会覆盖 Codex CLI 模型配置；会话启动时禁用用户配置中除 scoped `zterm` 外的 MCP，并将 scoped zTerm 工具设为客户端直接批准，由 zTerm 连接策略承担唯一最终审批 |
| `agent_set_active_terminal` | `{ runtimeSessionId: string \| null }` | `null` | 主窗口同步活动 SSH/SSH Container runtime 的内存观测值；无活动 SSH 时清空；无效 ID 先清空再报错。不改变 Agent 绑定、待审批参数或执行目标 |
| `agent_codex_unbind` | `{ agentSessionId }` | `null` | 兼容清理接口；活动共享会话拒绝单独解绑，须调用 `agent_codex_close` 一并关闭 PTY 与撤销绑定 |
| `agent_codex_close` | `{ agentSessionId, runtimeSessionId }` | `null` | 校验 Agent 与 PTY 配对后关闭共享会话并撤销绑定；前端仅在最后一个关联标签关闭或用户关闭/重启 Agent 时调用 |

`AppSettings.workspace_restore_strategy` 支持 `visible_first`、`connect_all`、`layout_only`，旧设置 JSON 缺字段时默认 `visible_first`。`visible_first` 先显示布局，再优先恢复当前可见 pane/tab；`connect_all` 显示布局后尽快低并发连接全部标签；`layout_only` 只恢复布局和 queued 状态，不自动打开终端。`settings_get` 和 `settings_reset` 返回的 `AppSettings.shortcuts` 会合并当前 `shortcut_registry_list` 中缺失的动作，调用方应以返回值作为 UI 展示和后续保存的有效配置。

`AppSettings.mcp` 为 `{ enabled, port? }`，旧设置缺字段时默认 `{ enabled: false, port: null }`；`port=null` 优先使用稳定默认端口 `9419`。启用状态会在 zTerm 启动时恢复监听，不依赖打开设置页；启动请求单飞，停止会等待监听任务退出并 drain 已接收连接，监听退出会清理运行态；单连接 HTTP 请求读取有 10 秒超时，避免半开连接永久占用。多开实例发现目标端口已占用时自动监听系统分配的本机可用端口，实际地址以该实例返回的 `McpServerStatus.endpoint` 为准，保存的首选端口不被覆盖。MCP token 只写入 OS keyring，不写入 SQLite settings JSON；首次升级且 keyring 尚无 MCP token 时可从 `ZTERM_MCP_TOKEN` 环境变量迁移，之后以 keyring 为准。token 只通过 `McpServerStatus.token` 返回给本地设置页复制或轮换。`McpServerStatus` 为 `{ enabled, endpoint?, token? }`，关闭时 `endpoint/token=null`。

MCP 设置页的工具详情默认折叠，首次展开时通过只读命令 `mcp_tool_catalog_list` 读取 MCP 专用 allowlist；结果按工具 ID 命名空间分组展示，并缓存到本次设置页会话。加载过程提供 loading、空清单、失败和重试状态，不读取或展示 MCP Bearer token 之外的 secret。

MCP 采用统一执行/审批/审计底层上的两个工具 Profile。外部 bearer 获得 Headless Profile，不暴露任何 `terminal.*`；侧栏会话 bearer 获得 Visible Terminal Profile，只返回 `sessions.list`、`terminal.list/open/read/write/close`。侧栏 `terminal.read/write/close` 省略 `runtime_session_id` 时由后端注入初始绑定 runtime，指定 runtime 时只允许 zTerm 当前可见的 SSH/SSH Container 终端。旧 `terminal_ref`、`A1`/`A2` 和前端编号映射均不再使用。

## Terminal Profiles

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `terminal_profile_list` | 无 | `TerminalProfile[]` | 列出终端 profile，空时自动检测 |
| `terminal_profile_detect` | 无 | `TerminalProfile[]` | 按 `pwsh.exe -> powershell.exe -> cmd.exe -> bash.exe -> wsl.exe` 重新检测并保存 |
| `terminal_profile_set_default` | `TerminalProfileDraft` | `TerminalProfile` | 设置默认终端；主界面新建标签页使用该终端 |

## External Launch

| Command / Event | 入参 / Payload | 返回 | 说明 |
| --- | --- | --- | --- |
| `external_launch_take_pending` | 无 | `ExternalSshLaunchEvent[]` | 取走当前进程启动参数解析出的外部一次性 SSH 或 FileZilla 格式 FTP/SFTP 请求；返回值不包含 password、key passphrase 或任何 secret |
| `zterm:external-ssh-launch` | `null` | 事件 | 带外部连接参数的 single-instance 回调完成参数解析和进程内入队后，仅通知已运行前端重新调用 `external_launch_take_pending`；沿用兼容事件名，事件不携带连接信息或 secret |

zTerm 仅在开发调试构建中允许多开，便于与安装版并行测试；正式和发布构建使用 single-instance。正式版未运行时由首个进程解析外部连接参数并建立临时连接；正式版已运行时，普通重复启动只恢复并聚焦已有主窗口，带外部连接参数的启动会转发到当前进程，前端重新取走 pending 请求，不保留第二个 zTerm 进程。

FileZilla 格式文件传输可直接使用 `zTerm.exe "sftp://user:password@host:22/path"` 或 `zTerm.exe "ftp://user:password@host:21/path"`。省略端口时分别使用 22/21；URL 用户名、密码和路径按 percent-encoding 解码；FTP 缺少用户名时按 anonymous 连接。前端收到这类请求后直接打开文件传输窗，将默认本地目录放在左侧、临时 FTP/SFTP 会话与 URL 路径放在右侧，不创建终端标签。事件增加可选 `file_transfer_protocol: "ftp" | "sftp"`；普通外部 SSH 省略该字段。password 只保存在进程内临时会话，但仍会在本机进程命令行中短暂可见。

外部启动推荐命令为 `zTerm.exe --external-ssh --host <host> --port <port> --user <user> --password <password> --sftp auto --remote-path /`。兼容 PuTTY 常见参数子集：`-ssh`、`-P`、`-l`、`-pw`、`-i`、`user@host`；兼容 SecureCRT 一次性 SSH 子集：`/SSH2`、`/L`、`/P`、`/PASSWORD`、`/I`、`host`；兼容 Xshell `-url ssh://user:password@host:port`、`-newwin ssh://user@host:port`、`-i <identity_file>`，以及云平台常见 `ssh://b64%3E%3E<base64>@gateway:port` 包装，内层 payload 形如 `<caller>:<password>@<ssh_user>@<ssh_host>:<ssh_port>:SSH2` 且 URL 未携带 password 时按内层目标创建一次性连接；当 Xshell URL 为 `ssh://"b64>>...":"en::..."@gateway:port` 这类 BHost 网关格式时，保留网关 host/port、解码后的 `b64>>...` username 和 URL password 作为 SSH 凭据，并标记 `channel_policy="single_channel"`。兼容 MobaXterm `-newtab "ssh -p <port> -l <user> <host>"` / `-exec "ssh ..."` 的内层 OpenSSH 子集，也兼容 `ssh`、`-p`、`user@host` 被拆成多个 argv 的形态；当平台把 zTerm 作为 MobaXterm 路径并传入 `.moba` session 文件时，按文件内 `#109#` SSH session 字段解析 host/port/username，文件内 username 为空时从 session 名前缀推断；若父进程是 BHost `bhmultauth.exe`，再从父进程命令行合并网关 host/port、`b64>>...` username 和 `en::...` password。通用目标接受 `ssh://user:password@host:port` 形式。解析后后端创建 `external:<uuid>` transient SSH session，password 只保存在进程内 secret resolver，不写入 SQLite、OS keyring、日志、事件 payload 或工作区定义。命令行传 password 会在本机进程列表中短暂可见；MobaXterm `.moba` 文件和父进程命令行都不含 password 时无法补出 transient password，SecureCRT `/ENCRYPTEDPASSWORD` 私有密文和更高安全级别场景应改用后续 `--password-stdin`、临时票据或云平台 token 换取模式。`ExternalSshLaunchEvent` 为 `{ id, name, host, port, username, auto_open_sftp, remote_path, channel_policy }`，其中 `channel_policy` 为 `unknown`、`multi_channel` 或 `single_channel`，`id` 即可传入 Terminal/SFTP/Transfer 当前会话相关 command 的 `savedSessionId` 参数。前端对旧事件缺少 `channel_policy` 时会基于有效 `b64>>` username 兜底识别单通道临时 SSH。

新注册的普通临时 SSH 标记为 `channel_policy="multi_channel"`，有效 `b64>>` 网关身份标记为 `single_channel`；旧事件缺少字段且无法识别时保持 `unknown`。单通道临时 SSH 的右侧 SFTP、容器和隧道入口不渲染，后端拒绝通过 `external_launch_update_ssh_options` 保存任何隧道；多通道临时 SSH 展示三个入口，但连接建立后默认保持右侧栏折叠，用户主动点击后才加载对应工具。`external_launch_update_ssh_options` 只允许更新当前进程内 transient session 的 `tunnels` 和 `container` 运行期配置，不改变 host、port、username、auth 或 identity file。

SSH 终端保活：未配置 `keepalive_interval_ms` 时使用 30 秒，正值保留自定义间隔，显式 `0` 关闭保活。临时连接默认同样为 30 秒。系统 SSH 使用 `ServerAliveInterval` 与 `ServerAliveCountMax=3`，native SSH 使用相同间隔与 `keepalive_max=3`，不设置任务执行时长上限。保活用于减少空闲链路超时，不能保证网络中断或远端主动关闭后继续运行。

## Workspaces

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `workspace_list` | 无 | `WorkspaceSummary[]` | 列出已保存工作区定义和标签数量 |
| `workspace_get` | `{ workspaceId }` | `WorkspaceDefinition` | 读取单个工作区布局快照；若引用的保存会话已删除，终端标签返回 `connection_source="missing"` 且清空 `saved_session_id`；历史快照中的 `external:` 临时标签直接移除，叶节点无其他标签时回退为空白标签 |
| `workspace_save` | `{ draft: WorkspaceDefinitionDraft }` | `WorkspaceDefinition` | 新增或更新显式工作区定义；后端保存前清除 runtime id、恢复状态、恢复错误和 `external:` 临时标签，并统一保存为 `closed`；显式传入 `id="default-workspace"` 返回 `Validation` |
| `workspace_delete` | `{ workspaceId }` | `{ deleted: true }` | 关闭工作区定义，将 `status` 标为 `closed`；不物理删除布局快照 |
| `workspace_remove` | `{ workspaceId }` | `{ deleted: true }` | 物理删除非默认工作区定义和布局快照；`default-workspace` 返回 `Validation` |

`WorkspaceDefinition` 包含 `id`、`name`、`status`（持久化兼容字段，保存和读取定义时始终为 `closed`）、`active_tab_id`、`tabs[]`、`sort_order`、`created_at_ms`、`updated_at_ms`。前端仅维护一个以 `default-workspace` 标识的独立实时工作台；已保存定义不会进入运行态，列表选择也不会改变工作台。`tabs[].root` 为分栏树，终端标签保存连接引用、容器目标、显式路径和连接后指令。SQLite 不保存 `runtime_session_id`、`restore_status`、`restore_error`、终端输出、secret 或 `external:` 临时连接标签；临时标签不会转换为失败占位。顶部手动保存从当前实时工作台构建草稿，右键编辑读取已保存定义；二者都不探测 Local/SSH 当前 cwd。`workspace_delete` 作为兼容 IPC 保留，但当前前端和 AI 工具目录不再提供“关闭工作区”入口。

## Terminal

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `terminal_open` | `{ savedSessionId, paneId, workingDirectory? }` | `RuntimeSessionInfo` | SSH/Local 创建 PTY runtime；`savedSessionId` 可为已保存会话 ID 或外部启动生成的 `external:<uuid>`；Local 会话可用 `workingDirectory` 覆盖工作目录；RDP 写入 Windows `TERMSRV/<full address>` PasswordCredential，生成临时 `.rdp` 文件启动系统 `mstsc.exe`，并创建持有该外部进程的 placeholder runtime |
| `terminal_open_ssh_container` | `{ savedSessionId, paneId, containerId, containerName? }` | `RuntimeSessionInfo` | 基于已保存 SSH 会话和所选容器新建 PTY runtime，执行 `docker` / `podman` / `nerdctl exec -it` 进入容器；标题为 `容器: <name>` 或短 ID；外部一次性 SSH 进入容器不走该命令 |
| `terminal_open_default_local` | `{ paneId, workingDirectory? }` | `RuntimeSessionInfo` | 使用默认终端 profile 打开本机 PTY，可用 `workingDirectory` 覆盖工作目录 |
| `terminal_write` | `{ runtimeSessionId, data }` | `{ accepted: true }` | 写入终端；普通 shell 同步捕获输入历史，启用 shell integration 的 PowerShell 由后续 PTY 事件捕获最终命令行 |
| `terminal_output_flow_open` | `{ runtimeSessionId }` | `{ generation }` | 为存在的 runtime 建立输出消费者；活动消费者重复打开保持同一代次 |
| `terminal_output_flow_ack` | `{ runtimeSessionId, generation, sequence }` | `{ accepted }` | 完成解析及可见渲染后累计确认；拒绝旧代次与超出已发送范围的序列 |
| `terminal_output_flow_close` | `{ runtimeSessionId, generation? }` | 无 | 释放输出等待；旧代次关闭不影响当前消费者 |
| `terminal_write_bytes` | `{ runtimeSessionId, data }` | `{ accepted: true }` | 写入原始终端字节；仅用于 ZMODEM，不捕获命令历史 |
| `terminal_zmodem_read_files` | `{ paths }` | `{ name, size, mtime_ms, data }[]` | 读取用户选择的本机文件，供远端 `rz` 上传；单文件超过 32 MiB 或本次批次总量超过 64 MiB 时拒绝，并引导改用 SFTP |
| `terminal_zmodem_save_file` | `{ directory, fileName, data }` | `{ path, bytes }` | 净化远端文件名并保存 `sz` 下载内容；单文件超过 32 MiB 或本次批次总量超过 64 MiB 时拒绝/跳过并引导改用 SFTP；同名文件自动追加序号 |
| `terminal_resize` | `{ runtimeSessionId, cols, rows }` | `{ resized: true }` | 调整 runtime 尺寸 |
| `terminal_close` | `{ runtimeSessionId, releaseExternalSession? }` | `{ closed: true }` | 关闭 runtime 并释放资源；RDP placeholder 会终止其持有的 `mstsc.exe` 子进程并删除临时 `.rdp` 文件；外部一次性 SSH 可在重连时传 `false` 保留 transient session |

`RuntimeSessionInfo` 返回 `runtime_session_id`、`saved_session_id?`、`history_scope_kind?`、`history_scope_id?`、`pane_id`、`title`、`kind`、`cols`、`rows` 和 `initial_cwd?`。`kind` 支持 `local`、`ssh`、`ssh_container`、`rdp_placeholder`。Local runtime 返回实际 PTY 初始工作目录；Windows 上在不损失路径语义时使用兼容形式（如 `F:\work`），避免 PowerShell 把 `\\?\` 扩展路径显示为 `Microsoft.PowerShell.Core\FileSystem::` Provider 前缀；无法安全简化的特殊路径保持原样。其他 runtime 无可靠初始目录时返回空值。SSH 和 SSH 容器 runtime 的历史作用域为 `saved_session:<session_id>`；外部一次性 SSH runtime 不返回历史作用域，不写命令历史 scope，关闭对应 runtime 时释放进程内 transient session 和 secret；Local runtime 的历史作用域为 `local_profile:<profile_id>`；RDP placeholder 不返回历史作用域。交互式 `pwsh.exe` / `powershell.exe` profile 会安装 PSReadLine Enter handler，以 shell 最终缓冲区生成 Base64 OSC 事件；后端持久化后剥离该事件，避免污染 `terminal:data`、输出 replay 和终端画面。自定义 PowerShell profile 已包含 `-Command`、`-File`、`-EncodedCommand` 或 `-NonInteractive` 时不注入。终端右键、`Ctrl+V` 和 DOM paste 统一读取 `text/plain`，净化 ANSI/控制字符、BOM 和双向文本控制字符后写入终端，不保留原剪贴板样式。终端默认前景/背景的反色区域（如 Readline 粘贴高亮）使用与选中态相同的配色：深色主题为灰底浅字，浅色主题为浅灰底深字；显式 ANSI 配色保留原样。包含反色或显式背景的行不覆盖整行背景；样式复位时移除区域装饰。Xterm 使用 `minimumContrastRatio=4.5` 保护文字可读性。SSH/Local/SSH 容器 PTY runtime 支持 ZMODEM rz/sz；后端在 `terminal:data` 中保留字符串 `data` 供普通终端输出和上下文截尾，同时提供 `data_base64` 原始字节给前端 ZMODEM sentry；前端识别到远端 `rz` 时选择本机文件并通过 `terminal_write_bytes` 上传，识别到远端 `sz` 时选择保存目录并调用 `terminal_zmodem_save_file` 写盘。ZMODEM 字节写入不进入命令历史；RDP placeholder 仍不接受任何终端输入。

## SSH Containers

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `ssh_container_list` | `{ savedSessionId }` | `SshContainerInfo[]` | 对已启用容器入口的 SSH 会话执行远端 runtime `ps -a`，返回全部容器 |
| `ssh_container_enter_runtime` | `{ savedSessionId, runtimeSessionId, containerId }` | `{ accepted: true }` | 仅用于 `external:<uuid>` 外部一次性 SSH；复用当前已建立的 SSH runtime，校验 runtime 属于同一 transient session 后向当前终端写入 `docker` / `podman` / `nerdctl exec -it` 命令进入容器 |

`SshContainerInfo` 包含 `id`、`name`、`image`、`status`、`running`。列表按运行中优先、名称或 ID 排序。首版支持 Docker-compatible 命令族：`docker`、`podman`、`nerdctl`；配置值 `containerd` 会映射为 `nerdctl`。运行时命令缺失、SSH 会话未启用容器入口、非 SSH 会话、远端命令失败均返回明确错误。停止容器只展示状态，前端禁用进入按钮；zTerm 不启动、停止、删除容器，也不提供容器文件管理或容器资源监控。外部一次性 SSH 的容器列表和进入默认复用当前连接；当临时 SSH 被识别为 `channel_policy="single_channel"` 时，前端隐藏容器入口，后端 `ssh_container_list` / `ssh_container_enter_runtime` 也拒绝执行，避免占用唯一交互 channel。

## Command Completion

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `command_completion_suggest` | `{ request: { runtime_session_id, input, cursor, limit?, cwd? } }` | `CommandCompletionCandidate[]` | 按当前 runtime 输入前缀和已知 cwd 返回命令/路径补全候选；Local/SSH 支持，RDP 占位不返回候选；冷缓存时先返回可用候选并后台刷新 |
| `command_completion_resolve_cwd` | `{ request: { runtime_session_id, current_cwd?, target? } }` | `string?` | 仅解析简单 `cd` 目标；Local 使用本地 canonicalize，SSH 使用 SFTP canonicalize；无法安全验证时返回空值 |

`CommandCompletionCandidate` 包含 `provider`（`history`、`system` 或 `path`）、`replacement_text`、`suffix`、`replacement_range { start, end }`、`score` 和 `source_label`。候选由后端聚合当前会话历史、系统命令、全局历史和简单路径项；历史候选过滤明显敏感命令；本地系统命令来自 PATH/PATHEXT 和常见内建命令；SSH 系统命令在连接后后台探测远端 PATH 并缓存，路径列表按 `saved_session_id + canonical lookup directory` 缓存。路径补全覆盖 `cd/cp/mv/rm/ls/cat`、常用查看/编辑/元数据命令、`tar/zip/unzip` 和 `docker compose` 的路径参数；`cd/mkdir/rmdir` 只返回目录，文件型参数保留目录候选以继续下钻更深路径。相对/绝对/`.`/`..`/`~` 和带空格引号路径均受支持。缓存有短 TTL、数量上限、in-flight 去重和失败静默降级，冷缓存不阻塞终端输入。已知 cwd 来自 Local 初始工作目录、shell 发出的 OSC 7，以及经 zTerm 任意输入入口写入并通过 canonicalize 验证的简单 `cd`；连接后指令、指令组和同步输入与键盘直输共用同一 runtime cwd，复杂 shell 表达式不猜测。SSH 容器 runtime 不使用宿主机远端命令缓存，继续只提供会话历史、全局历史和基础 POSIX builtins。前端只用最佳候选展示幽灵后缀，位置按 xterm 当前光标和实际行列网格计算，并在光标、滚动或尺寸变化时同步；`Tab` 通常只写入缺失 suffix，需要补齐引号时按 `replacement_range` 重写当前路径 token。

## History

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `history_search` | `{ query?, scopeKind, scopeId, limit?, deduplicate? }` | `CommandHistoryEntry[]` | 搜索指定历史作用域内的命令历史，默认 limit 1000，最大 1000；`deduplicate=true` 时按 trim 后完整 `command` 精确去重，只返回每个命令最近一条 |
| `history_clear` | `{ scopeKind, scopeId }` | `{ cleared: true }` | 清理指定历史作用域；不删除指令组 |
| `history_command_group_list` | `{ scopeKind, scopeId }` | `SessionCommandGroup[]` | 列出指定历史作用域的指令组和组内命令 |
| `history_command_group_save` | `{ draft: SessionCommandGroupDraft }` | `SessionCommandGroup` | 新增或更新指定历史作用域的指令组；至少 1 条非空命令，单条命令上限 4096 字符 |
| `history_command_group_delete` | `{ groupId }` | `{ deleted: true }` | 删除指令组，组内命令随 SQLite 外键级联删除 |

历史作用域字段为 `scope_kind: "saved_session" | "local_profile"` 和 `scope_id: string`；`history_search` 与 `history_clear` 必须同时提供 `scopeKind/scopeId`。`CommandHistoryEntry` 包含 `runtime_session_id`、`scope_kind?`、`scope_id?`、`command`、`cwd?`、`exit_code?` 和时间字段；新写入的 Local/SSH 历史必须带 scope。`SessionCommandGroupDraft` 包含 `id?`、`saved_session_id?`、`scope_kind`、`scope_id`、`name` 和 `commands[]`。SSH 指令组保留 `saved_session_id` 以便删除保存会话时级联清理；Local profile 指令组使用 `saved_session_id=null`。`command_history` 写入后按历史作用域保留最近 1000 条，旧默认本地 runtime 的无 scope 历史不会迁入新 profile scope。

## Server Info And Resource Monitor

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `server_info_snapshot` | `{ savedSessionId: string \| null }` | `ServerInfoSnapshot` | `savedSessionId` 有值时采集指定已保存 SSH 会话的远程宿主机；为 `null` 时采集 zTerm 所在本机；RDP/缺失的非空会话返回错误 |

`server_info_snapshot` 使用前端 camelCase 包装键 `{ savedSessionId }`，Rust 模型字段仍为 `saved_session_id` 和 snake_case 响应字段。远程采集通过 native 非交互 SSH exec channel 执行短生命周期 POSIX shell 脚本，密码、密钥口令和跳板机凭据只从 OS keyring 读取，不进入命令行参数、日志或 SQLite；本机采集在阻塞任务中读取系统、CPU、内存、磁盘、网络和进程信息。远程监控不跟随 `ssh_options.container` 进入容器。面板折叠或切换工具后前端停止自动轮询。

`ServerInfoSnapshot` 包含连接标识 `host_id`、`host_name`、`host`、`port`、`username`，系统字段 `hostname`、`os`、`architecture`、`kernel`、`uptime_seconds`、`load_average`，CPU 字段 `cpu_usage_percent`、`cpu_count`、`cpu_model`、`cpu_core_usage_percents`，内存和 Swap 字段 `memory_total_bytes`、`memory_used_bytes`、`memory_available_bytes`、`memory_buffers_bytes`、`memory_cached_bytes`、`swap_total_bytes`、`swap_used_bytes`，磁盘字段 `disk_total_bytes`、`disk_used_bytes`、`disk_available_bytes`、`disk_mount`、`disks[]`，网络字段 `network_rx_bytes`、`network_tx_bytes`、`network_interfaces[]`，进程字段 `process_count`、`running_process_count`、`top_processes[]`，GPU 字段 `gpu_probe_status`、`gpus[]`，以及采集时间 `captured_at`。远端 GPU 依赖 `nvidia-smi` 或 `lspci`，缺失时返回降级状态和空设备列表；本机当前不采集 GPU，返回 `gpu_probe_status=not_collected`。

## SFTP And Transfers

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `sftp_list` | `{ savedSessionId, path }` | `FileEntry[]` | 列出远程目录；`savedSessionId` 可为已保存 SSH 会话 ID 或当前进程内 `external:<uuid>`；文件面板默认从 `/` 加载 |
| `sftp_mkdir` | `{ savedSessionId, path }` | `{ created: true }` | 新建远程目录；根目录 `/` 作为目标会返回 `Validation` |
| `sftp_classify_local_paths` | `{ paths }` | `{ path, kind }[]` | 按本地文件系统把路径分类为 `file` 或 `directory`，用于上传前计划生成 |
| `sftp_check_transfer_conflicts` | `{ savedSessionId, items: { direction, localPath, remotePath, kind }[] }` | `{ direction, path }[]` | 批量检查上传远程目标或下载本地目标是否已存在 |
| `sftp_upload` | `{ savedSessionId, localPath, remotePath, kind?, conflictPolicy?, groupId?, groupName? }` | `TransferTask` | 入队上传并异步执行；`kind` 为 `file`/`directory`，旧调用缺省为后端推断；`conflictPolicy` 缺省 `overwrite`；同一次批量操作的文件复用相同 `groupId/groupName` |
| `sftp_download` | `{ savedSessionId, remotePath, localPath, kind?, conflictPolicy?, groupId?, groupName? }` | `TransferTask` | 入队下载并异步执行；`kind` 为 `file`/`directory`，旧调用缺省为后端推断；`conflictPolicy` 缺省 `overwrite`；同一次批量操作的文件复用相同 `groupId/groupName` |
| `sftp_delete` | `{ savedSessionId, path, recursive }` | `{ deleted: true }` | 删除文件或目录；目录删除必须显式 `recursive=true`；根目录 `/` 显式拒绝 |
| `sftp_rename` | `{ savedSessionId, from, to }` | `{ renamed: true }` | 重命名远程路径；根目录 `/` 显式拒绝 |
| `file_transfer_default_local_path` | 无 | `string` | 返回文件传输栏本机端点默认目录 |
| `file_transfer_local_roots` | 无 | `string[]` | 返回本机端点可选根目录；Windows 返回可访问盘符根目录，其他平台返回 `/` |
| `file_transfer_view_state_get` | 无 | `FileTransferViewState \| null` | 读取上次使用的左右端点连接与对应路径；首次使用时返回 `null` |
| `file_transfer_view_state_save` | `{ viewState }` | `FileTransferViewState` | 独立保存左右端点连接与对应路径；远程端点必须引用非空已保存连接 ID |
| `file_transfer_list_endpoint` | `{ endpoint }` | `FileEntry[]` | 列出本机或已保存远程会话端点目录；远程会话支持 SSH/SFTP/FTP，SSH 端点也可接受当前进程内 `external:<uuid>` |
| `file_transfer_rename_endpoint` | `{ endpoint, to }` | `{ renamed: true }` | 重命名本机或 SSH 端点文件/目录；本机仅允许同目录改名，根目录显式拒绝 |
| `file_transfer_delete_endpoint` | `{ endpoint, recursive }` | `{ deleted: true }` | 删除本机或 SSH 端点文件/目录；目录递归删除必须显式 `recursive=true`，根目录显式拒绝 |
| `file_transfer_check_conflicts` | `{ items: { destination, kind }[] }` | `{ path }[]` | 批量检查通用端点目标是否已存在 |
| `file_transfer_enqueue` | `{ source, destination, kind?, conflictPolicy?, groupId?, groupName? }` | `TransferTask` | 入队独立文件传输栏任务；同一次批量操作的文件复用相同 `groupId/groupName`；本机到本机拒绝；SSH/SFTP 远端到远端通过双 SFTP 连接流式中转；FTP 参与的远端到远端直传暂不支持 |
| `file_transfer_list` | `{ limit? }` | `TransferTask[]` | 查询全局传输任务列表，包含旧 SFTP 栏和独立文件传输栏任务；当前进程内仍会返回临时连接任务，重启后不返回 |
| `transfer_list` | `{ savedSessionId?, limit? }` | `TransferTask[]` | 查询传输任务；传入 `savedSessionId` 时只返回旧 SFTP 栏 `sftp_panel` 来源任务，保持当前会话 Dock 兼容；`external:` 任务仅来自当前进程内存 |
| `transfer_retry` | `{ taskId }` | `TransferTask` | 重试 failed 任务 |
| `transfer_pause` | `{ taskId }` | `TransferTask` | 暂停当前进程内有控制句柄的 queued/running 任务；没有当前运行期控制句柄时返回 `Validation`，不承诺重启后断点续传 |
| `transfer_resume` | `{ taskId }` | `TransferTask` | 恢复 paused 任务；没有当前运行期控制句柄时返回 `Validation` |
| `transfer_cancel` | `{ taskId }` | `TransferTask` | 取消 queued/running/paused 任务，状态写为 `cancelled` |
| `transfer_delete` | `{ taskId }` | `{ deleted: true }` | 删除任务记录；queued/running/paused 会先取消再删除，已删除任务的迟到事件由前端忽略 |
| `transfer_clear_all` | 无 | `number` | 取消全部当前运行控制，并一次性清空所有内存临时任务和 SQLite 持久任务；不受任务列表 1000 条上限影响 |

`TransferEndpoint` wire shape 为 `{ kind: "local", saved_session_id?: null, path }` 或 `{ kind: "saved_session", saved_session_id, path }`；Rust 继续接受旧 wire 值 `kind: "ssh"`，SQLite 端点快照继续使用 `ssh` 作为兼容存储编码。`FileTransferViewState` 为 `{ left: TransferEndpoint, right: TransferEndpoint }`，文件传输弹窗在 SQLite 中独立记忆两侧最近一次端点和路径，下次打开时恢复；已保存远程连接不存在时，右侧回退到首个可用远程连接，左侧回退到本机默认目录。`TransferTask` 包含可选 `group_id/group_name`、`kind: "file" | "directory" | null`、`conflict_policy: "overwrite" | "skip" | "rename"`、`task_origin: "sftp_panel" | "file_transfer"`、`source_endpoint`、`destination_endpoint` 和 `status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled"`；旧 SQLite 任务迁移后 `group_id/group_name=null`、`kind=null`、`conflict_policy="overwrite"`、`task_origin="sftp_panel"`，并由旧 `direction/local_path/remote_path/saved_session_id` 回填端点快照。一次多选或包含目录的上传/下载先递归扫描来源目录，将所有后代文件扁平化为同一任务组的直接子任务；单文件操作继续作为顶层任务。任务组仅两层，显示聚合进度和状态，点击组行折叠/展开；每个子任务继续独立支持暂停、恢复、取消、删除和失败重试。前端批量上传/下载在入队前统一弹出冲突策略选择，取消时不创建任务。右侧 SFTP 面板只展示当前活动 SSH 会话的 `sftp_panel` 任务；左侧 rail 的 `文件传输` 按钮位于 `会话` 下方，点击后打开居中文件传输弹窗，弹窗展示全局任务，左右端点独立于当前终端会话，并支持两栏间拖拽或方向按钮触发传输。两栏文件列表均通过右键菜单对本机或 SSH 端点执行重命名和删除；重命名仅支持单项，删除支持当前选择集并在目录删除前确认。本机端点不提供新建目录；SSH 端点选择 UI 仍以已保存 SSH 会话为主，但 API 层可处理当前进程内 `external:<uuid>`。暂停只保留当前进程内运行期控制，不保存可跨重启恢复的断点；任何会话 ID 或端点引用 `external:<uuid>` 的任务只进入 `TransferQueue` 进程内存，不写入 SQLite，当前进程内仍可暂停、恢复、取消、删除和失败重试，应用重启后不再列出。持久化列表查询同时过滤旧版本遗留的 `external:` 任务记录。SFTP 连接复用 SSH command service 的 native 链路：认证支持 `password`、`none`、`key + ssh_options.identity_file` 和 `agent`，密钥口令从 `credential_ref` 指向的 OS keyring 或当前进程 transient resolver 读取；`jump_hosts` 按已保存 SSH 会话解析并读取跳板机凭据；`ProxyCommand` 通过本机 shell 启动 stdio 代理并支持 `%h`、`%p`、`%r`、`%%` token。

目录扫描和冲突检查期间，文件传输弹窗显示准备状态并忽略重复触发；准备失败会直接显示错误。`TransferQueue` 全局同时只执行 1 个传输任务，其余任务保持 `queued`。同一 SSH/SFTP 会话下的连续上传和下载复用带安全连接 key 与空闲淘汰的 SFTP session；远端目录读取、冲突检查和传输执行发现缓存 session 已关闭、连接被重置或连接超时（含 Windows `10060`）时，先淘汰缓存并重连，传输开始前还会探测 session 是否可用。目录读取和冲突检查最多尝试 3 次，首次建立传输连接对明确的连接拒绝或连接超时错误最多执行 5 次指数退避重试。传输操作失败时立即淘汰该 session，下一任务重新建立；认证、凭据、权限和路径错误不重试。远端到远端中转继续使用独立双连接，避免同一 session 锁重入。

## Credentials

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `credentials_list` | 无 | `CredentialRecord[]` | 列凭据元数据，不返回 secret |
| `credentials_save` | `CredentialDraft` | `CredentialRecord` | secret 写入 OS keyring，SQLite 只保存引用；`kind` 支持 `ssh_password`、`ssh_key_passphrase`、`rdp_password` |
| `credentials_read_secret` | `{ credentialRef }` | `{ secret }` | 按 `credential_ref` 从 OS keyring 读取 secret；仅用于用户显式点击查看或受控自动填充路径，不得用于列表回显 |
| `credentials_delete` | `{ id }` | `{ deleted: true }` | 删除凭据元数据和对应 keyring secret |
| `credentials_test` | `{ id }` | `{ ok: true }` | 验证 keyring secret 可读 |

SSH 新建/编辑 UI 仅允许选择 `password` 或 `key`。密码认证时，用户输入的密码通过 `credentials_save(kind=ssh_password)` 写入 OS keyring，保存后的 `credential_ref` 进入会话；密钥认证时，用户选择的身份文件路径写入 `ssh_options.identity_file`，输入的密钥密码通过 `credentials_save(kind=ssh_key_passphrase)` 写入 OS keyring。UI 不再暴露手工编辑 `credential_ref` 的项目；旧数据中已有 `credential_ref` 仍作为后续登录的 keyring lookup key 兼容读取。编辑已有 SSH 会话时，密码和密钥密码字段 value 不预填真实 secret，但在存在 `credential_ref` 时默认用 `******` 占位掩码展示；只有用户点击查看按钮时才通过 `credentials_read_secret` 显式读取并显示已保存 secret。RDP 新建/编辑 UI 使用同样的密码保存和查看规则：输入密码通过 `credentials_save(kind=rdp_password)` 写入 OS keyring，编辑已有 RDP 会话时默认只显示 `******` 占位掩码，点击查看才读取真实 secret。

## Codex Sidebar And MCP Approval

当前右侧 Agent 面板完全由本机已登录的 `codex` CLI 实现。每个可操作终端标签最多保留一个 Codex PTY；切换到没有 Codex 会话的标签时关闭侧栏，手动打开时新建进程，切回已有会话的标签时自动恢复显示。Codex 本地 sandbox 固定为 `read-only`，远程写入必须经过 zTerm MCP 和连接级审批链路。zTerm 不提供模型管理、内置模型请求或 AI Conversation IPC，也不向 Codex 注入自定义模型目录。

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `mcp_tool_confirm` | `{ request: AiToolConfirmRequest }` | `AiToolAuditRecord` | 用户确认或拒绝 MCP pending；执行结果写入审计、删除 pending，并唤醒等待该 invocation 的原 MCP 调用 |
| `mcp_tool_pending` | 无 | `AiToolPendingInvocation[]` | 按创建时间倒序列出待确认 MCP 工具 |
| `mcp_tool_audit` | `{ request?: AiToolAuditListRequest }` | `AiToolAuditRecord[]` | 按完成时间倒序列出 MCP 工具审计，默认最多 100 条 |
| `mcp_connection_approval_mode_get` | `{ savedSessionId }` | `AiConnectionApprovalPolicy` | 读取已保存 SSH 连接的审批模式；未配置时返回 `safe` |
| `mcp_connection_approval_mode_set` | `{ request: { saved_session_id, approval_mode } }` | `AiConnectionApprovalPolicy` | 保存 SSH 连接级审批模式；拒绝不存在或非 SSH 的连接 |

侧栏 Codex 的 Visible Terminal Profile 中，`sessions.list` 仅返回已保存 SSH 连接；`terminal.list` 返回可见 SSH/SSH Container runtime 及 `active_runtime_session_id`；后者来自主窗口活动分栏标签的内存观测，并在读取时核验仍存在于返回列表，无有效目标为 `null`。侧栏解析“当前连接／当前标签／激活标签”时先读取该字段，再显式指定 runtime；不使用初始绑定或本机 cwd 替代。读取后同一操作固定目标，省略 runtime 的旧绑定行为不变；`terminal.open(saved_session_id, placement?)` 只允许打开已保存 SSH 连接，`placement` 为 `tab`、`split_horizontal` 或 `split_vertical`。`terminal.read` 使用运行期 ring buffer，可读取最近输出或指定 cursor 后的最近增量；`max_chars` 默认 4000，允许正整数预算，实际最多 24000 字符，超出时自动收敛而不报错，响应 `effective_max_chars` 返回实际预算；零、负数及非整数仍拒绝；`terminal.write` 写入后等待输出短暂稳定并返回新 cursor。侧栏不暴露 `ssh.execute`，因此所有服务器命令与输出都进入目标滚动屏。

审批策略按目标已保存 SSH 连接生效：`request_approval`（每次批准）对每次工具调用创建 pending；默认 `safe`（高效审批）自动执行 low/medium 的巡检、传输和常规运维，high/critical 与显式不可逆工具创建 pending；`full_access`（完全自动）免除所有非 secret 输入审批，包括 critical、删除和其他写操作。需要本地 secret 的调用在任何模式下都保持 pending，因为 secret 只能由 zTerm 本地输入。命令型 `terminal.write`/`ssh.execute` 使用脚本内容动态风险分类；`service`、`firewall-cmd`、`iptables` 仅在真实变更子命令出现时提升为 high，只读状态查询不因命令名或输出标题误判。zTerm 仍是最终审批和审计拥有者；侧栏启动参数把 scoped zTerm MCP 设为客户端直接批准，外部 Codex App 也应信任本机 zTerm MCP，避免客户端自身再审批一次。

自动或人工批准执行后写入 `ai_tool_audits`，记录 `affected_domains` 供前端按域刷新 Session、Workspace、Terminal、History、Transfer 等状态。人工 pending 创建后会唤起 zTerm 主窗口并自动打开 Agent 审批面板；批准、拒绝或执行失败都通过进程内 completion broker 唤醒原 `tools/call`，结构化结果只在内存中短期保留，不写入审计表。表名作为既有 MCP 审计存储继续保留。`terminal.write` 会等待终端输出短暂稳定并返回回读摘要；会话/分组、工作区定义、终端 profile、传输控制、历史、服务器资源快照、SSH 容器列表和 SFTP/FTP 文件操作复用现有 storage/service 入口。

本机 MCP v1 采用 MCP 2025-11-25 Streamable HTTP，endpoint 固定为 `http://127.0.0.1:<port>/mcp`，默认端口为 `9419`，默认关闭，不提供 stdio sidecar；用户启用后会随 zTerm 启动自动监听。服务验证 `Authorization: Bearer <token>` 和 `Origin`，仅允许无 Origin 或 localhost/127.0.0.1/::1/`tauri://localhost`。当前 JSON-RPC 支持 `initialize`、`tools/list`、`tools/call`；客户端 notification（包括 `notifications/initialized`）返回 HTTP `202 Accepted` 空响应。外部 Headless Profile allowlist 开放 `approval.wait`、`sessions.list/save`、`ssh.execute`、`ssh.upload/download`、`sftp.upload/download`、`ftp.upload/download`、`transfer.list`；对 `terminal.*` 和目录外工具均返回 `-32601`。默认 `tools/call` 最多等待本地审批 10 分钟并直接返回结果；客户端发送 `Prefer: respond-async` 时立即取得 pending receipt，随后以 `approval.wait(invocation_id)` 等待或领取同一次完成结果，不得重放原副作用工具。审批未完成前，相同 MCP 主体、工具和标准化参数的重试复用原 invocation，不新建审批单。所有工具提供非空 input schema，未知参数返回 `-32602`。调用参数包含 `saved_session_id` 时按该连接读取审批策略；Visible Terminal Profile 的 runtime 目标先回溯其 `saved_session_id`。读取和保存操作通过 `structuredContent.result` 返回脱敏结构，不返回 `credential_ref` 或 secret。

外部 `ssh.execute` 输入 `saved_session_id` 和 `script`，通过 zTerm 保存连接复用密码、密钥、SSH Agent、跳板机和 SSH 连接缓存，返回 stdout、stderr、exit code、截断标记和耗时，不触碰终端滚动屏。侧栏 `terminal.open` 通过 `zterm:tool-action` 在前端打开保存连接；调用方随后轮询 `terminal.list` 获取新 runtime ID，再通过 `terminal.read/write/close` 操作对应滚动屏。`sessions.save.reuse_auth_from_session_id` 可复用另一连接的认证引用而不向 MCP 暴露引用；密码型新连接会创建 pending，并通过 `zterm:tool-pending` 让 zTerm Agent 面板刷新本地 secret 输入。MCP 参数递归拒绝 password、token、API Key、private key 等明文 secret。

`ssh.upload/download` 只接受 SSH 连接，`sftp.upload/download` 接受 SSH 或 SFTP 连接，`ftp.upload/download` 只接受 FTP 连接；统一参数为 `saved_session_id`、绝对 `local_path`、`remote_path`，可选 `kind=file|directory` 和 `conflict_policy=overwrite|skip|rename`。下载为 low、上传为 medium，在默认 `safe` 下直接创建持久化传输任务并复用现有连接与 keyring 凭据；`request_approval` 仍逐次确认。调用方用 `transfer.list` 按连接查询 `queued/running/paused/done/failed/cancelled` 状态和字节进度。审计成功表示任务已入队，不等同于远端传输完成；真实结果以传输任务状态为准。

## Events

| Event | Payload | 触发时机 |
| --- | --- | --- |
| `terminal:data` | `{ runtime_session_id, generation, sequence, data, data_base64 }` | 后端收到终端输出；`data_base64` 保留 PTY 原始字节供 ZMODEM |
| `terminal:exit` | `{ runtime_session_id, exit_code, message }` | runtime 退出或连接中断 |
| `terminal:history-changed` | `{ runtime_session_id }` | shell integration 提交并持久化最终命令行后，通知前端刷新对应历史作用域 |
| `transfer:progress` | `TransferTask` | 传输状态或进度更新 |
| `transfer:done` | `TransferTask` | 传输完成、失败或取消 |
| `zterm:tool-action` | `{ action, arguments, affected_domains }` | 后端 MCP 工具通过审批后请求前端执行运行态动作 |
| `zterm:tool-pending` | 无 | 外部 MCP 创建待确认工具后通知前端刷新 pending 列表、唤起主窗口并打开 Agent 审批面板，不携带参数或 secret |

## Security Notes

- Secret、API Key、密码和私钥片段不得写入 SQLite、文档、日志或 UI 列表；MCP 保存密码连接时，密码只允许经本地确认进入 OS keyring，SQLite 只保存 `credential_ref`。
- MCP 工具参数摘要、pending 和审计记录必须脱敏；`request_approval`/`safe` 下未审批的写入不得执行；`full_access` 的免审批是用户对该连接的显式策略，仍不能绕过工具 allowlist、目标校验、secret 输入隔离和审计。
- MCP Bearer token 不写入 SQLite 或审计摘要；Origin 非本机时拒绝。MCP 工具参数不得携带 SSH 密码、私钥正文、API Key 或其他明文 secret。
- ZMODEM 下载文件名只取安全 basename 后写入用户选择目录；上传只读取用户通过本次文件选择器选择的路径。ZMODEM 原始字节不写入命令历史或 SQLite。


### 终端输出游标与截断

`terminal.read/write` 返回的 `cursor` 是当前 runtime 内单调递增的 UTF-8 字节偏移，不随 24,000 字符滚动缓冲裁剪重置。`output`、`cursor` 和 `truncated` 来自同一次读取快照；`truncated=true` 表示请求起点已被保留窗口淘汰或返回长度限制省略了部分输出。读取长度不足时保留最新尾部，cursor 仍推进到快照末尾，因此被省略的历史不会由下一次读取自动补齐；需要较大上下文时应提前提高 `max_chars`。调用方应展示截断提示，并原样使用本次 cursor 继续读取，不按字符数自行累加；runtime 关闭后不可将旧 cursor 用于新 runtime。首读返回最近内容，历史已裁剪时也如实标记截断。

实时输出去重以片段序号为准：只有实际入队回放时已覆盖的片段可跳过。新到达的空格、重复字符、退格或光标控制序列，即使与旧快照尾部相同，也必须送入 xterm，避免回显与远端输入行错位。

### 输出消费与背压

每个有界输出事件携带 `generation` 与递增 `sequence`。前端须在原始 ZMODEM 字节被处理、后台 replay 解析完成且可见终端写入完成后按序 ACK；纯协议数据无需可见渲染。隐藏终端由后台解析消费，关闭终端会唤醒等待中的 reader。每 runtime 未确认原始输出窗口为 256 KiB；Native SSH 队列最多 128 个 8 KiB 分块，保留字节顺序。无窗口的 headless dispatcher 不等待前端。桌面 runtime 首次输出最多等待消费者握手 10 秒，超时以明确原因终止，避免无限积压。

### rz/sz 失败恢复

ZMODEM 协议发送串行执行。解析、原始字节解码或发送失败时中止活动会话、丢弃尚未发送的旧传输数据并清理控制器；故障事件的原始协议文本不回显到 Xterm，避免二进制/ANSI 污染终端。取消或关闭 runtime 后，过期文件选择与传输回调不能继续发送。后续正常事件重新建立 sentry。该机制不注入 shell 命令；真实远端 lrzsz 的取消响应仍需桌面互操作验证。

### Agent 与上传结束握手

Agent 侧栏只显示一行关联连接名称，不另列所属标签；Codex PTY 必须在接收第一段输出前建立输出消费者，不能依赖第一段输出触发握手。普通终端与 Agent 均遵守同一输出消费约定。

ZMODEM 上传的字节进度达到 100% 不等于会话关闭完成：文件结束后的 `ZRINIT` 与随后 `ZFIN`/`OO` 必须交给协议会话处理，不能当作重复启动头丢弃。用户取消选择上传文件时中止协议会话，避免在 `ZACK` 状态调用不适用的正常结束路径。

sz 等待用户选择保存目录时，重传的 `ZRQINIT` 不交给已确认的接收会话；启动头跨事件拆分或与其他字节合并时保持字节顺序，部分头缓存有界。文件传输开始后的数据与结束握手不使用目录等待期的重传过滤。

rz/sz 文件选择沿用 `@tauri-apps/plugin-dialog.open`，上传支持多选文件，下载选择单个保存目录；不修改系统光标设置。
