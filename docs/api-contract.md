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
| `sessions_save_session` | `SavedSessionDraft` | `SavedSession` | 保存 SSH/Local/RDP 会话 |
| `sessions_delete_session` | `{ id }` | `{ deleted: true }` | 删除会话 |
| `sessions_test_connection` | `SavedSessionDraft`, `secret?` | `{ ok, message }` | 真实连接测试：SSH 建立短命令 exec；RDP 验证端口连通和凭据可读但不启动 `mstsc.exe`；Local 校验实际终端 profile 可执行文件和工作目录 |

`SavedSession.type` 支持 `ssh`、`local`、`rdp`。SSH `ssh_options` 支持 `connect_timeout_ms`、`keepalive_interval_ms`、`identity_file`、兼容旧数据的 `proxy_command`、`jump_hosts`、`tunnels` 和 `container`；`jump_hosts` 保持字符串数组，打开终端时会按 `username@host` 匹配本地已保存 SSH 会话，读取匹配跳板机的 keyring secret 并按 OpenSSH prompt 目标自动填充；隧道类型为 `local`、`remote`、`dynamic`、`remote_dynamic`，可选 `mode` 表达 `host_service`、`local_service`、`local_network`、`socks` 业务用途，可选 `name` 用于 UI 回显，`auto_open=true` 时随 SSH 连接生成 OpenSSH 转发参数；`local` 生成 `-L [bind:]local_port:remote_host:remote_port`，`remote` 生成 `-R [bind:]local_port:remote_host:remote_port`，`dynamic` 生成 `-D [bind:]local_port`，`remote_dynamic` 生成远端 SOCKS `-R [bind:]local_port`；`auth_mode=key` 且 `identity_file` 非空时生成 OpenSSH `-i` 参数；`container.enabled=true` 只表示右侧容器工具可用，普通 `terminal_open` 仍进入远端宿主机；旧 `container.container` 字段仅保留 wire 兼容，不作为普通打开或新 UI 的默认容器目标。`sessions_test_connection` 可接收仅用于本次测试的 `secret`，用于未保存的 SSH/RDP 密码或 SSH 密钥密码，不写入 SQLite 或 OS keyring；未提供 `secret` 时通过 `credential_ref` 读取 OS keyring。SSH 测试使用已有 SSH command service 真实连接目标并执行短命令；Local 使用 `local_options.profile_id`、`working_directory` 和 `environment`，测试时验证将要使用的 profile 可执行文件和工作目录。RDP 使用 `rdp_options.domain`、`width`、`height`、`color_depth`、`redirect_clipboard`、`fullscreen`，密码通过 `credential_ref` 指向 zTerm OS keyring；测试时只验证 RDP 端口连通和凭据可读取，不启动 `mstsc.exe`，也不声明远端登录凭据已被服务器接受；打开 RDP 时后端从 keyring 读取 secret，写入 Windows Credential Manager 的 `TERMSRV/<full address>` PasswordCredential，临时 `.rdp` 文件不写 `password 51` 字段。

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

`AppSettings.workspace_restore_strategy` 支持 `visible_first`、`connect_all`、`layout_only`，旧设置 JSON 缺字段时默认 `visible_first`。`visible_first` 先显示布局，再优先恢复当前可见 pane/tab；`connect_all` 显示布局后尽快低并发连接全部标签；`layout_only` 只恢复布局和 queued 状态，不自动打开终端。`settings_get` 和 `settings_reset` 返回的 `AppSettings.shortcuts` 会合并当前 `shortcut_registry_list` 中缺失的动作，调用方应以返回值作为 UI 展示和后续保存的有效配置。

`AppSettings.mcp` 为 `{ enabled, port? }`，旧设置缺字段时默认 `{ enabled: false, port: null }`。MCP token 是运行期 secret，只通过 `McpServerStatus.token` 返回给本地设置页复制或轮换，不写入 SQLite settings JSON。`McpServerStatus` 为 `{ enabled, endpoint?, token? }`，关闭时 `endpoint/token=null`。

## Terminal Profiles

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `terminal_profile_list` | 无 | `TerminalProfile[]` | 列出终端 profile，空时自动检测 |
| `terminal_profile_detect` | 无 | `TerminalProfile[]` | 按 `pwsh.exe -> powershell.exe -> cmd.exe -> bash.exe -> wsl.exe` 重新检测并保存 |
| `terminal_profile_set_default` | `TerminalProfileDraft` | `TerminalProfile` | 设置默认终端；主界面新建标签页使用该终端 |

## External Launch

| Command / Event | 入参 / Payload | 返回 | 说明 |
| --- | --- | --- | --- |
| `external_launch_take_pending` | 无 | `ExternalSshLaunchEvent[]` | 取走当前进程启动参数解析出的外部一次性 SSH 请求；返回值不包含 password、key passphrase 或任何 secret |
| `zterm:external-ssh-launch` | `ExternalSshLaunchEvent` | 事件 | 供后续 single-instance / deep-link 接入时向已运行前端投递一次性 SSH 请求；当前启动参数路径以前端取 pending 为主 |

外部启动推荐命令为 `zTerm.exe --external-ssh --host <host> --port <port> --user <user> --password <password> --sftp auto --remote-path /`。兼容 PuTTY 常见参数子集：`-ssh`、`-P`、`-l`、`-pw`、`-i`、`user@host`；兼容 SecureCRT 一次性 SSH 子集：`/SSH2`、`/L`、`/P`、`/PASSWORD`、`/I`、`host`；兼容 Xshell `-url ssh://user:password@host:port`、`-newwin ssh://user@host:port`、`-i <identity_file>`，以及云平台常见 `ssh://b64%3E%3E<base64>@gateway:port` 包装，内层 payload 形如 `<caller>:<password>@<ssh_user>@<ssh_host>:<ssh_port>:SSH2` 且 URL 未携带 password 时按内层目标创建一次性连接；当 Xshell URL 为 `ssh://"b64>>...":"en::..."@gateway:port` 这类 BHost 网关格式时，保留网关 host/port、解码后的 `b64>>...` username 和 URL password 作为 SSH 凭据，并标记 `channel_policy="single_channel"`。兼容 MobaXterm `-newtab "ssh -p <port> -l <user> <host>"` / `-exec "ssh ..."` 的内层 OpenSSH 子集，也兼容 `ssh`、`-p`、`user@host` 被拆成多个 argv 的形态；当平台把 zTerm 作为 MobaXterm 路径并传入 `.moba` session 文件时，按文件内 `#109#` SSH session 字段解析 host/port/username，文件内 username 为空时从 session 名前缀推断；若父进程是 BHost `bhmultauth.exe`，再从父进程命令行合并网关 host/port、`b64>>...` username 和 `en::...` password。通用目标接受 `ssh://user:password@host:port` 形式。解析后后端创建 `external:<uuid>` transient SSH session，password 只保存在进程内 secret resolver，不写入 SQLite、OS keyring、日志、事件 payload 或工作区定义。命令行传 password 会在本机进程列表中短暂可见；MobaXterm `.moba` 文件和父进程命令行都不含 password 时无法补出 transient password，SecureCRT `/ENCRYPTEDPASSWORD` 私有密文和更高安全级别场景应改用后续 `--password-stdin`、临时票据或云平台 token 换取模式。`ExternalSshLaunchEvent` 为 `{ id, name, host, port, username, auto_open_sftp, remote_path, channel_policy }`，其中 `channel_policy` 为 `unknown`、`multi_channel` 或 `single_channel`，`id` 即可传入 Terminal/SFTP/Transfer 当前会话相关 command 的 `savedSessionId` 参数。前端对旧事件缺少 `channel_policy` 时会基于有效 `b64>>` username 兜底识别单通道临时 SSH。

`external_launch_update_ssh_options` 只允许更新当前进程内 transient session 的 `tunnels` 和 `container` 运行期配置，不改变 host、port、username、auth 或 identity file。`channel_policy="single_channel"` 的临时 SSH 只允许保存 0 或 1 条本地 `local` 隧道；超过一条隧道或远端/动态隧道返回 `Validation`，前端同步禁用继续添加入口。

## Workspaces

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `workspace_list` | 无 | `WorkspaceSummary[]` | 列出已保存工作区定义和标签数量 |
| `workspace_get` | `{ workspaceId }` | `WorkspaceDefinition` | 读取单个工作区布局快照；若引用的保存会话已删除，终端标签返回 `connection_source="missing"` 且清空 `saved_session_id` |
| `workspace_save` | `{ draft: WorkspaceDefinitionDraft }` | `WorkspaceDefinition` | 新增或更新显式工作区定义；后端保存前清除 runtime id、恢复状态和恢复错误，并统一保存为 `closed`；显式传入 `id="default-workspace"` 返回 `Validation` |
| `workspace_delete` | `{ workspaceId }` | `{ deleted: true }` | 关闭工作区定义，将 `status` 标为 `closed`；不物理删除布局快照 |
| `workspace_remove` | `{ workspaceId }` | `{ deleted: true }` | 物理删除非默认工作区定义和布局快照；`default-workspace` 返回 `Validation` |

`WorkspaceDefinition` 包含 `id`、`name`、`status`（读取持久化定义时为 `closed`；`running` 只由前端进程内 runtime 覆盖展示）、`active_tab_id`、`tabs[]`、`sort_order`、`created_at_ms`、`updated_at_ms`。`tabs[].root` 为带 `kind` 的分栏树：`leaf` 节点保存 `id`、`title`、`active_terminal_tab_id`、`terminal_tabs[]`；`split` 节点保存 `direction`、`ratio`、`first`、`second`。`WorkspaceTerminalTab` 保存 `id`、`title`、`saved_session_id?`、`connection_source?`（`saved_session` / `ssh_container` / `default_local` / `external_ssh` / `missing`）、`container_target? { id, name? }`、`path?`、`startup_command?`、运行态 `restore_status?` 和 `restore_error?`；运行态 `restore_status` 可为 `queued`、`pending`、`connected`、`failed`。SQLite 只保存关闭态可恢复定义：布局、连接引用、容器目标、显式路径和连接后指令；不保存 `runtime_session_id`、恢复状态/错误、终端输出或任何 secret。前端保存运行态工作区时会把 `connection_source="external_ssh"` 的一次性连接转为 `missing`，清空 `saved_session_id` 和 `runtime_session_id`，并写入不可恢复提示，不把 `external:<uuid>` 持久化为可恢复连接。`default-workspace` 只作为前端隐藏内存草稿区使用，后端保留主记录用于兼容初始化，但迁移会清理其 `workspace_tabs`，且不允许通过 `workspace_save` 保存默认区布局。用户保存当前工作区时，前端不向 Local/SSH runtime 发送 cwd 探测命令；路径和连接后指令均来自工作区编辑弹窗中的显式配置。

## Terminal

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `terminal_open` | `{ savedSessionId, paneId, workingDirectory? }` | `RuntimeSessionInfo` | SSH/Local 创建 PTY runtime；`savedSessionId` 可为已保存会话 ID 或外部启动生成的 `external:<uuid>`；Local 会话可用 `workingDirectory` 覆盖工作目录；RDP 写入 Windows `TERMSRV/<full address>` PasswordCredential，生成临时 `.rdp` 文件启动系统 `mstsc.exe` 并创建 placeholder runtime |
| `terminal_open_ssh_container` | `{ savedSessionId, paneId, containerId, containerName? }` | `RuntimeSessionInfo` | 基于已保存 SSH 会话和所选容器新建 PTY runtime，执行 `docker` / `podman` / `nerdctl exec -it` 进入容器；标题为 `容器: <name>` 或短 ID；外部一次性 SSH 进入容器不走该命令 |
| `terminal_open_default_local` | `{ paneId, workingDirectory? }` | `RuntimeSessionInfo` | 使用默认终端 profile 打开本机 PTY，可用 `workingDirectory` 覆盖工作目录 |
| `terminal_write` | `{ runtimeSessionId, data }` | `{ accepted: true }` | 写入终端并捕获命令历史 |
| `terminal_write_bytes` | `{ runtimeSessionId, data }` | `{ accepted: true }` | 写入原始终端字节；仅用于 ZMODEM，不捕获命令历史 |
| `terminal_zmodem_read_files` | `{ paths }` | `{ name, size, mtime_ms, data }[]` | 读取用户选择的本机文件，供远端 `rz` 上传 |
| `terminal_zmodem_save_file` | `{ directory, fileName, data }` | `{ path, bytes }` | 净化远端文件名并保存 `sz` 下载内容；同名文件自动追加序号 |
| `terminal_resize` | `{ runtimeSessionId, cols, rows }` | `{ resized: true }` | 调整 runtime 尺寸 |
| `terminal_close` | `{ runtimeSessionId }` | `{ closed: true }` | 关闭 runtime 并释放资源 |

`RuntimeSessionInfo` 返回 `runtime_session_id`、`saved_session_id?`、`history_scope_kind?`、`history_scope_id?`、`pane_id`、`title`、`kind`、`cols` 和 `rows`。`kind` 支持 `local`、`ssh`、`ssh_container`、`rdp_placeholder`。SSH 和 SSH 容器 runtime 的历史作用域为 `saved_session:<session_id>`；外部一次性 SSH runtime 不返回历史作用域，不写命令历史 scope，关闭对应 runtime 时释放进程内 transient session 和 secret；Local runtime 的历史作用域为 `local_profile:<profile_id>`；RDP placeholder 不返回历史作用域。SSH/Local/SSH 容器 PTY runtime 支持 ZMODEM rz/sz。后端在 `terminal:data` 中保留字符串 `data` 供普通终端输出和上下文截尾，同时提供 `data_base64` 原始字节给前端 ZMODEM sentry；前端识别到远端 `rz` 时选择本机文件并通过 `terminal_write_bytes` 上传，识别到远端 `sz` 时选择保存目录并调用 `terminal_zmodem_save_file` 写盘。ZMODEM 字节写入不进入命令历史；RDP placeholder 仍不接受任何终端输入。

## SSH Containers

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `ssh_container_list` | `{ savedSessionId }` | `SshContainerInfo[]` | 对已启用容器入口的 SSH 会话执行远端 runtime `ps -a`，返回全部容器 |
| `ssh_container_enter_runtime` | `{ savedSessionId, runtimeSessionId, containerId }` | `{ accepted: true }` | 仅用于 `external:<uuid>` 外部一次性 SSH；复用当前已建立的 SSH runtime，校验 runtime 属于同一 transient session 后向当前终端写入 `docker` / `podman` / `nerdctl exec -it` 命令进入容器 |

`SshContainerInfo` 包含 `id`、`name`、`image`、`status`、`running`。列表按运行中优先、名称或 ID 排序。首版支持 Docker-compatible 命令族：`docker`、`podman`、`nerdctl`；配置值 `containerd` 会映射为 `nerdctl`。运行时命令缺失、SSH 会话未启用容器入口、非 SSH 会话、远端命令失败均返回明确错误。停止容器只展示状态，前端禁用进入按钮；zTerm 不启动、停止、删除容器，也不提供容器文件管理或容器资源监控。外部一次性 SSH 的容器列表和进入默认复用当前连接；当临时 SSH 被识别为 `channel_policy="single_channel"` 时，前端隐藏容器入口，后端 `ssh_container_list` / `ssh_container_enter_runtime` 也拒绝执行，避免占用唯一交互 channel。

## Command Completion

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `command_completion_suggest` | `{ request: { runtime_session_id, input, cursor, limit? } }` | `CommandCompletionCandidate[]` | 按当前 runtime 输入前缀返回命令补全候选；Local/SSH 支持，RDP 占位不返回候选 |

`CommandCompletionCandidate` 包含 `provider`（`history` 或 `system`）、`replacement_text`、`suffix`、`replacement_range { start, end }`、`score` 和 `source_label`。候选由后端聚合当前会话历史、系统命令和全局历史；历史候选过滤明显敏感命令；本地系统命令来自 PATH/PATHEXT 和常见内建命令；SSH 系统命令在连接后后台探测远端 PATH 并缓存，探测失败时静默降级为历史候选；SSH 容器 runtime 不使用宿主机远端命令缓存，首版只提供会话历史、全局历史和基础 POSIX builtins。前端只用最佳候选展示幽灵后缀，`Tab` 接受时只写入缺失 suffix。

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
| `server_info_snapshot` | `{ savedSessionId }` | `ServerInfoSnapshot` | 对指定已保存 SSH 会话执行一次远程宿主机系统信息和资源快照采集；Local/RDP/缺失会话返回错误 |

`server_info_snapshot` 使用前端 camelCase 包装键 `{ savedSessionId }`，Rust 模型字段仍为 `saved_session_id` 和 snake_case 响应字段。采集通过 native 非交互 SSH exec channel 执行短生命周期 POSIX shell 脚本，密码、密钥口令和跳板机凭据只从 OS keyring 读取，不进入命令行参数、日志或 SQLite。首版监控远程宿主机，不跟随 `ssh_options.container` 进入容器。面板折叠或切换工具后前端停止自动轮询。

`ServerInfoSnapshot` 包含连接标识 `host_id`、`host_name`、`host`、`port`、`username`，系统字段 `hostname`、`os`、`architecture`、`kernel`、`uptime_seconds`、`load_average`，CPU 字段 `cpu_usage_percent`、`cpu_count`、`cpu_model`、`cpu_core_usage_percents`，内存和 Swap 字段 `memory_total_bytes`、`memory_used_bytes`、`memory_available_bytes`、`memory_buffers_bytes`、`memory_cached_bytes`、`swap_total_bytes`、`swap_used_bytes`，磁盘字段 `disk_total_bytes`、`disk_used_bytes`、`disk_available_bytes`、`disk_mount`、`disks[]`，网络字段 `network_rx_bytes`、`network_tx_bytes`、`network_interfaces[]`，进程字段 `process_count`、`running_process_count`、`top_processes[]`，GPU 字段 `gpu_probe_status`、`gpus[]`，以及采集时间 `captured_at`。GPU 依赖远端 `nvidia-smi` 或 `lspci`，缺失时返回降级状态和空设备列表。

## SFTP And Transfers

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `sftp_list` | `{ savedSessionId, path }` | `FileEntry[]` | 列出远程目录；`savedSessionId` 可为已保存 SSH 会话 ID 或当前进程内 `external:<uuid>`；文件面板默认从 `/` 加载 |
| `sftp_mkdir` | `{ savedSessionId, path }` | `{ created: true }` | 新建远程目录；根目录 `/` 作为目标会返回 `Validation` |
| `sftp_classify_local_paths` | `{ paths }` | `{ path, kind }[]` | 按本地文件系统把路径分类为 `file` 或 `directory`，用于上传前计划生成 |
| `sftp_check_transfer_conflicts` | `{ savedSessionId, items: { direction, localPath, remotePath, kind }[] }` | `{ direction, path }[]` | 批量检查上传远程目标或下载本地目标是否已存在 |
| `sftp_upload` | `{ savedSessionId, localPath, remotePath, kind?, conflictPolicy? }` | `TransferTask` | 入队上传并异步执行；`kind` 为 `file`/`directory`，旧调用缺省为后端推断；`conflictPolicy` 缺省 `overwrite` |
| `sftp_download` | `{ savedSessionId, remotePath, localPath, kind?, conflictPolicy? }` | `TransferTask` | 入队下载并异步执行；`kind` 为 `file`/`directory`，旧调用缺省为后端推断；`conflictPolicy` 缺省 `overwrite` |
| `sftp_delete` | `{ savedSessionId, path, recursive }` | `{ deleted: true }` | 删除文件或目录；目录删除必须显式 `recursive=true`；根目录 `/` 显式拒绝 |
| `sftp_rename` | `{ savedSessionId, from, to }` | `{ renamed: true }` | 重命名远程路径；根目录 `/` 显式拒绝 |
| `file_transfer_default_local_path` | 无 | `string` | 返回文件传输栏本机端点默认目录 |
| `file_transfer_local_roots` | 无 | `string[]` | 返回本机端点可选根目录；Windows 返回可访问盘符根目录，其他平台返回 `/` |
| `file_transfer_list_endpoint` | `{ endpoint }` | `FileEntry[]` | 列出本机或 SSH 会话端点目录；SSH 端点可接受已保存会话 ID 或当前进程内 `external:<uuid>` |
| `file_transfer_check_conflicts` | `{ items: { destination, kind }[] }` | `{ path }[]` | 批量检查通用端点目标是否已存在 |
| `file_transfer_enqueue` | `{ source, destination, kind?, conflictPolicy? }` | `TransferTask` | 入队独立文件传输栏任务；本机到本机拒绝；远端到远端由 zTerm 通过双 SFTP 连接流式中转 |
| `file_transfer_list` | `{ limit? }` | `TransferTask[]` | 查询全局传输任务列表，包含旧 SFTP 栏和独立文件传输栏任务 |
| `transfer_list` | `{ savedSessionId?, limit? }` | `TransferTask[]` | 查询传输任务；传入 `savedSessionId` 时只返回旧 SFTP 栏 `sftp_panel` 来源任务，保持当前会话 Dock 兼容 |
| `transfer_retry` | `{ taskId }` | `TransferTask` | 重试 failed 任务 |
| `transfer_pause` | `{ taskId }` | `TransferTask` | 暂停当前进程内有控制句柄的 queued/running 任务；没有当前运行期控制句柄时返回 `Validation`，不承诺重启后断点续传 |
| `transfer_resume` | `{ taskId }` | `TransferTask` | 恢复 paused 任务；没有当前运行期控制句柄时返回 `Validation` |
| `transfer_cancel` | `{ taskId }` | `TransferTask` | 取消 queued/running/paused 任务，状态写为 `cancelled` |
| `transfer_delete` | `{ taskId }` | `{ deleted: true }` | 删除任务记录；queued/running/paused 会先取消再删除，已删除任务的迟到事件由前端忽略 |

`TransferEndpoint` wire shape 为 `{ kind: "local", saved_session_id?: null, path }` 或 `{ kind: "ssh", saved_session_id, path }`。`TransferTask` 包含 `kind: "file" | "directory" | null`、`conflict_policy: "overwrite" | "skip" | "rename"`、`task_origin: "sftp_panel" | "file_transfer"`、`source_endpoint`、`destination_endpoint` 和 `status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled"`；旧 SQLite 任务迁移后 `kind=null`、`conflict_policy="overwrite"`、`task_origin="sftp_panel"`，并由旧 `direction/local_path/remote_path/saved_session_id` 回填端点快照。前端批量上传/下载在入队前统一弹出冲突策略选择，取消时不创建任务。右侧 SFTP 面板只展示当前活动 SSH 会话的 `sftp_panel` 任务，传输任务 Dock 支持暂停、恢复、取消、删除和失败重试；左侧 rail 的 `文件传输` 按钮位于 `会话` 下方，点击后打开居中文件传输弹窗，弹窗展示全局任务，左右端点独立于当前终端会话，并支持两栏间拖拽或方向按钮触发传输。本机端点首版只用于浏览、选择、刷新、显示隐藏项和传输源/目标，不提供删除、重命名或新建；SSH 端点选择 UI 仍以已保存 SSH 会话为主，但 API 层可处理当前进程内 `external:<uuid>`。暂停只保留当前进程内运行期控制，不保存可跨重启恢复的断点；使用 `external:<uuid>` 的传输任务若持久化到 SQLite，应用重启后因 transient session 和 secret 已释放，重试会失败，需要重新由云平台发起一次性连接。SFTP 连接复用 SSH command service 的 native 链路：认证支持 `password`、`none`、`key + ssh_options.identity_file` 和 `agent`，密钥口令从 `credential_ref` 指向的 OS keyring 或当前进程 transient resolver 读取；`jump_hosts` 按已保存 SSH 会话解析并读取跳板机凭据；`ProxyCommand` 通过本机 shell 启动 stdio 代理并支持 `%h`、`%p`、`%r`、`%%` token。

## Credentials And AI Provider

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `credentials_list` | 无 | `CredentialRecord[]` | 列凭据元数据，不返回 secret |
| `credentials_save` | `CredentialDraft` | `CredentialRecord` | secret 写入 OS keyring，SQLite 只保存引用；`kind` 支持 `ssh_password`、`ssh_key_passphrase`、`rdp_password`、`ai_api_key` |
| `credentials_read_secret` | `{ credentialRef }` | `{ secret }` | 按 `credential_ref` 从 OS keyring 读取 secret；仅用于用户显式点击查看或受控自动填充路径，不得用于列表回显 |
| `credentials_delete` | `{ id }` | `{ deleted: true }` | 删除凭据元数据和对应 keyring secret |
| `credentials_test` | `{ id }` | `{ ok: true }` | 验证 keyring secret 可读 |
| `llm_provider_list` | 无 | `AiProviderProfile[]` | 列 Provider，不返回 API Key 明文 |
| `llm_provider_save` | `AiProviderProfileDraft` | `AiProviderProfile` | API Key 存在时写入 OS keyring，SQLite 保存 `api_key_ref`；OpenAI-compatible Provider 可保存空 key |
| `llm_provider_delete` | `{ id }` | `{ deleted: true }` | 删除 Provider 和 owned API Key secret |
| `llm_provider_test` | `{ id }` | `{ ok, message }` | 使用真实轻量请求测试 Provider，错误消息脱敏；OpenAI-compatible 空 key 请求不发送 `Authorization` |
| `llm_provider_test_draft` | `{ request: { draft, prompt } }` | `{ ok, message, output }` | 使用当前表单 Provider 配置和用户输入发起真实模型调用；不保存 Provider、不写入 keyring、不创建 AI 会话 |
| `llm_provider_test_draft_stream` | `{ request: { draft, prompt } }` | `{ test_id }` | 启动当前表单 Provider 的单轮真实流式测试；通过事件返回增量文本和完成状态 |
| `llm_provider_test_draft_cancel` | `{ testId }` | `{ cancelled }` | 按 `test_id` 取消正在进行的 draft 流式测试 |

SSH 新建/编辑 UI 仅允许选择 `password` 或 `key`。密码认证时，用户输入的密码通过 `credentials_save(kind=ssh_password)` 写入 OS keyring，保存后的 `credential_ref` 进入会话；密钥认证时，用户选择的身份文件路径写入 `ssh_options.identity_file`，输入的密钥密码通过 `credentials_save(kind=ssh_key_passphrase)` 写入 OS keyring。UI 不再暴露手工编辑 `credential_ref` 的项目；旧数据中已有 `credential_ref` 仍作为后续登录的 keyring lookup key 兼容读取。编辑已有 SSH 会话时，密码和密钥密码字段 value 不预填真实 secret，但在存在 `credential_ref` 时默认用 `******` 占位掩码展示；只有用户点击查看按钮时才通过 `credentials_read_secret` 显式读取并显示已保存 secret。RDP 新建/编辑 UI 使用同样的密码保存和查看规则：输入密码通过 `credentials_save(kind=rdp_password)` 写入 OS keyring，编辑已有 RDP 会话时默认只显示 `******` 占位掩码，点击查看才读取真实 secret。

`AiProviderProfile.kind` wire 值支持 `openai_chat`、`openai_responses`、`anthropic`，并兼容旧 serde 形态 `open_ai_chat`、`open_ai_responses`；`is_default=true` 的 enabled Provider 优先用于 AI Chat。`openai_chat`、`openai_responses` 允许 `api_key_ref=""`，请求时仅在 key 存在时发送 `Authorization: Bearer ...`；`anthropic` 仍要求 API Key 并通过 `x-api-key` 发送。OpenAI-compatible `base_url` 既可保存服务根路径如 `/v1`，也可保存完整端点如 `/v1/responses`，后端会避免重复拼接 path。OpenAI Responses 解析优先读取 `output_text`，并扫描 `output[]` 中全部 message/content 的 `{ type: "output_text", text }`；`content` 兼容数组和单对象两种形态，可兼容响应中先出现 `reasoning` 的结构。成功响应按完整 body 解析，避免较长 JSON 被错误摘要截断；非 2xx 错误消息只展示脱敏后的响应摘要。Draft 测试使用前端传入的 `draft` 和 `prompt` 构造临时 Provider：`api_key` 非空时只用于本次请求，`api_key_ref` 非空时从 OS keyring 读取已保存 secret，二者都为空时仅 OpenAI-compatible 允许无 key 调用；测试输出只作为响应或流式事件返回，不写入 Provider、credential、AI conversation 或 tool audit。流式 draft 测试支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic 原生 SSE 增量文本；事件 payload 均携带 `test_id`，前端必须只接收当前测试 ID 的事件并在关闭或取消时清理监听。

## AI Chat, Conversation And Tools

| Command | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `ai_chat` | `{ request: AiChatRequest }` | `AiChatResponse` | 使用默认 enabled Provider 发起原生 tool/function call；按会话审批模式自动执行或创建 pending，持久化用户/工具/助手消息 |
| `ai_chat_stream` | `{ request: AiChatRequest }` | `{ chat_id, conversation_id }` | 启动 AI 面板真实流式对话；立即持久化用户消息，后台通过事件返回助手增量、完成、错误或取消状态 |
| `ai_chat_cancel` | `{ chatId }` | `{ cancelled }` | 按 `chat_id` 取消正在进行的 AI 面板流式输出；取消后不持久化助手消息 |
| `ai_terminal_context_snapshot` | `{ request: AiTerminalContextRequest }` | `AiTerminalContextSnapshot` | 生成 AI 上下文快照；优先使用后端终端输出 ring buffer，`recent_output` 只返回最多 4000 字符尾部 |
| `ai_tool_registry_list` | 无 | `AiToolDefinition[]` | 返回 zTerm 限定工具注册表 |
| `ai_tool_prepare` | `{ request: AiToolPrepareRequest }` | `AiToolPendingInvocation` | 校验工具参数、生成预览、风险摘要并写入 pending |
| `ai_tool_confirm` | `{ request: AiToolConfirmRequest }` | `AiToolAuditRecord` | 用户确认或拒绝 pending 工具；执行结果写入审计并删除 pending |
| `ai_tool_pending` | 无 | `AiToolPendingInvocation[]` | 按创建时间倒序列出待确认工具 |
| `ai_tool_audit` | `{ request?: AiToolAuditListRequest }` | `AiToolAuditRecord[]` | 按完成时间倒序列出工具审计，默认最多 100 条 |
| `ai_conversation_create` | `{ request: AiConversationCreateRequest }` | `AiConversation` | 创建 AI 会话 |
| `ai_conversation_list` | `{ request?: AiConversationListRequest }` | `AiConversationSummary[]` | 列出会话，支持 `query` 和 `limit`，最大 200 |
| `ai_conversation_get` | `{ conversationId }` | `AiConversation` | 读取会话和按时间升序排列的消息 |
| `ai_conversation_delete` | `{ conversationId }` | `boolean` | 删除会话，消息随 SQLite 外键级联删除 |
| `ai_set_conversation_approval_mode` | `{ request: AiConversationApprovalModeUpdateRequest }` | `AiConversation` | 更新当前 AI 会话审批模式 |
| `ai_conversation_message_append` | `{ request: AiConversationMessageAppendRequest }` | `AiConversationMessage` | 追加一条 `user`、`assistant`、`system` 或 `tool` 消息 |

`AiChatRequest` 包含 `conversation_id?`、`message`、`approval_mode?`、`history[]` 和 `terminal_context?`。`AiChatResponse` 包含 `conversation_id`、Provider 信息、助手消息、`pending_invocations[]`、`executed_invocations[]`、`context_used`、`tool_count` 和 `generated_at_ms`。`ai_chat_stream` 保留同一请求体并新增事件契约：`ai-chat:chunk`、`ai-chat:done`、`ai-chat:error`、`ai-chat:cancelled` payload 均携带 `chat_id`，前端只接收当前 `chat_id`；完成事件携带最终助手消息、pending/已执行工具、上下文标记和生成时间，后端仅在完整完成时追加助手消息到会话。`AiConversation` 和 summary 包含 `approval_mode`，wire 值为 `request_approval`、`safe`、`full_access`，默认 `safe`；会话 scope 当前使用 `follow_focus`、`locked_pane`、`no_context` 等字符串和 JSON `scope_ref_json` 记录上下文引用；消息 `metadata_json` 必须是合法 JSON。`AiTerminalContextRequest/Snapshot` 可携带 `runtime_session_id`、`saved_session_id`、`pane_id`、`title`、`cwd`、最近输出、选中文本和输入缓冲；后端维护运行期终端输出 ring buffer，不跨重启持久化完整终端输出。

AI 工具注册表只暴露 zTerm 已有能力：`terminal.list/write/open/split/focus`、`workspace.open_tool`、`settings.get/update_ai_security`、`llm_provider.list/create/update/delete/test`、`session_groups.save/delete`、`sessions.list/save/delete/open/test`、`workspace.list/get/save/close/delete/restore`、`terminal_profile.list/set_default`、`transfer.list/retry/pause/resume/cancel/delete`、`server_info.snapshot`、`ssh_container.list`、`sftp.list/mkdir/upload/download/delete/rename`、`history.search/record/clear`、`zterm.context/search`。Provider tool/function call 适配 OpenAI Chat Completions、OpenAI Responses 和 Anthropic：工具名中的 `.` 以 `__` 作为 wire name 转义，返回后映射回 zTerm 工具 ID。新增或修改会创建、更新、删除资源的 AI 工具时，Provider tool schema 必须声明足以直接执行的参数结构、必填字段和默认值策略，并用测试覆盖 schema 与最小自然语言参数可执行路径；不得只暴露空 `properties` 后期待模型猜测 draft 结构。`sessions.save` 的 AI tool 参数支持 `draft.group_name` 或顶层 `group_name`，用于把用户指定的现有分组名解析为 `group_id`；匹配到同名分组时复用已有分组，不因缺少 `group_id` 再调用 `session_groups.save` 新建同名分组。审批策略按会话生效：`request_approval` 每次工具调用都创建 pending；`safe` 自动执行低/中风险工具，高/严重风险创建 pending；`full_access` 自动执行非强制确认工具并写审计。删除、清空、`settings.update_ai_security`、缺少本地 secret 的 Provider create/update 和高/严重风险 `terminal.write` 即使在 `full_access` 也强制 pending。工具参数递归拒绝 `api_key/password/token/secret` 等明文敏感字段；例外是 `sessions.save` 可接收 AI 提供的 SSH/RDP 一次性密码或 `ssh://user:password@host:port` / `rdp://user:password@host:port` 连接 URL，后端在准备工具调用时立即写入 OS keyring，替换为 `credential_ref`，并从 pending 参数、审计摘要和会话消息中移除明文。AI Provider secret 仍只能由本地确认 UI 写入 OS keyring；`AiToolConfirmRequest.secret_inputs.api_key` 仅用于本次确认执行，后端在内存中合并到 Provider draft 后交给 `CredentialService` 写入 OS keyring，不写入 `ai_tool_pending`、`ai_tool_audits`、AI 会话消息或 MCP 响应。

自动或人工批准执行后写入 `ai_tool_audits`，记录 `affected_domains` 供前端按域刷新 Session、Model、Workspace、Terminal、History、Transfer 等状态。`terminal.write` 会等待终端输出短暂稳定并把回读摘要写入 tool message；会话/分组、Provider、工作区定义、终端 profile、传输控制、历史、服务器资源快照、SSH 容器列表和部分 SFTP 文件操作复用现有 storage/service 入口。前端运行态动作通过 `zterm:tool-action` 事件执行，例如打开工具面板、恢复工作区、分屏、聚焦 pane、打开会话和 SFTP 上传下载；后端只负责审批、审计和事件分发。

本机 MCP v1 采用 MCP 2025-11-25 Streamable HTTP，endpoint 固定为 `http://127.0.0.1:<port>/mcp`，默认关闭，不提供 stdio sidecar。服务验证 `Authorization: Bearer <token>` 和 `Origin`，仅允许无 Origin 或 localhost/127.0.0.1/::1/`tauri://localhost`。当前 JSON-RPC 支持 `initialize`、`tools/list`、`tools/call`；`tools/call` 与内置 AI 面板共用同一工具目录、审批策略、pending/audit 和 affected domains。MCP 删除、清空、高风险终端写入和 secret 相关调用返回 pending 状态，必须回到 zTerm 内确认。

## Events

| Event | Payload | 触发时机 |
| --- | --- | --- |
| `terminal:data` | `{ runtime_session_id, data, data_base64 }` | 后端收到终端输出；`data_base64` 保留 PTY 原始字节供 ZMODEM |
| `terminal:exit` | `{ runtime_session_id, exit_code, message }` | runtime 退出或连接中断 |
| `transfer:progress` | `TransferTask` | 传输状态或进度更新 |
| `transfer:done` | `TransferTask` | 传输完成、失败或取消 |
| `llm-provider-test:chunk` | `{ test_id, delta }` | draft 模型流式测试收到文本增量 |
| `llm-provider-test:done` | `{ test_id, message, output }` | draft 模型流式测试完成 |
| `llm-provider-test:error` | `{ test_id, message }` | draft 模型流式测试失败，消息已脱敏 |
| `llm-provider-test:cancelled` | `{ test_id }` | draft 模型流式测试被取消 |
| `ai-chat:chunk` | `{ chat_id, conversation_id, delta }` | AI 面板流式对话收到助手文本增量 |
| `ai-chat:done` | `{ chat_id, conversation_id, message, pending_invocations, executed_invocations, context_used, generated_at_ms }` | AI 面板流式对话完成并已持久化助手消息 |
| `ai-chat:error` | `{ chat_id, message }` | AI 面板流式对话失败，消息已脱敏 |
| `ai-chat:cancelled` | `{ chat_id, conversation_id }` | AI 面板流式对话被取消，助手消息不落库 |
| `zterm:tool-action` | `{ action, arguments, affected_domains }` | 后端 AI/MCP 工具通过审批后请求前端执行运行态动作 |

## Security Notes

- Secret、API Key、密码和私钥片段不得写入 SQLite、文档、日志或 UI 列表；AI 创建 SSH/RDP 连接时接收的密码只允许进入 OS keyring，SQLite 只保存 `credential_ref`。
- AI terminal context、用户消息、工具参数摘要、pending 工具和审计记录必须经过脱敏后才能持久化；前端乐观展示的用户消息也必须脱敏，避免当前对话窗口短暂显示密码。
- 未审批的 AI 工具写入不得进入终端；高危命令也不能绕过当前会话审批策略。
- OpenAI-compatible 无 key Provider 不得伪造空 `Bearer` 头；Anthropic 等原生 Provider 不得绕过 key 校验。
- AI 工具参数摘要和审计记录必须脱敏，pending 工具执行失败时返回结构化错误并保留审计。
- MCP Bearer token 不写入 SQLite、AI 会话、审计摘要或 Provider 请求；Origin 非本机时拒绝。
- ZMODEM 下载文件名只取安全 basename 后写入用户选择目录；上传只读取用户通过本次文件选择器选择的路径。ZMODEM 原始字节不写入命令历史或 SQLite。
