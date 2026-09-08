---
文档类型: 文档索引
适用任务: AI 辅助开发前的任务分流、规则检索、业务说明定位
必读前置: AGENTS.md
禁止场景: 已有更精确任务入口且不需要跨目录判断时，不要把本文件当作业务说明
权威等级: 索引入口
当前状态: 生效
---

# docs 文档索引

本文件是 `zTerm` 的 AI 辅助开发文档入口。AI 代理完成任务分类后，先通过本文件确认最小读取路径，再进入具体业务说明、规则或外部 workflow。

## 1. 项目识别结果

| 项目事实 | 结果 |
|----------|------|
| 后端技术栈 | Rust 2021 / Tauri 2 桌面后端 |
| 前端技术栈 | React 19 / TypeScript / Vite 7 |
| 测试工具 | Vitest, Cargo test |
| 数据库线索 | SQLite，见 `src-tauri/src/storage/sqlite.rs` 与 migrations |
| 缓存线索 | 未识别 |
| CI 线索 | GitHub Actions，见 `.github/workflows/release.yml` |
| 容器线索 | 未识别 |
| 目录线索 | src/test |
| 旧业务目录 | 未检测到旧 `docs/logic/`。 |

### 运行、部署与验证线索

- 子模块线索：
- `.：Node 前端模块（证据：package.json）`
- `src-tauri/：Rust/Tauri 桌面后端模块（证据：src-tauri/Cargo.toml）`
- 运行时与产物：
- Node.js `>=22.13`；Tauri Windows 桌面包由 `src-tauri/tauri.conf.json` 和 `npm run tauri:build` 生成
- 部署与容器：
- 暂未识别部署或 compose 线索，请按 README、CI 或运维配置补充
- 分模块验证：
- 前端：`npm run typecheck`, `npm run test:frontend`, `npm run build`
- Tauri/Rust：`cd src-tauri && cargo fmt --check`, `cd src-tauri && cargo test`
- 敏感配置：
- `src-tauri/Cargo.toml：敏感配置键线索 keyring；只允许提交占位值或模板`

## 2. 目录用途

| 目录 | 用途 | 读取条件 | 权威等级 |
|------|------|----------|----------|
| `docs/analysis/` | 总体模块拆分、职责边界、影响分析、跨模块/跨功能关联逻辑；索引见本文“分析文档索引” | 影响模块边界、调用链或跨域关系时 | 结构分析 |
| `docs/business/` | 具体功能业务逻辑、业务规则、流程和不变量；索引见本文“业务域索引” | 修改或解释业务链路前 | 业务真理 |
| `docs/api-contract.md` | Tauri IPC、事件、模型 wire shape 和错误契约 | 修改 command、invoke 或事件 payload 前 | 工程规则 |
| `docs/verification.md` | 分阶段验证命令、结果、产物和未覆盖风险 | 交付、发布检查或追溯验证证据时 | 历史证据 |
| `docs/rules/` | 编码、测试、安全、文档规则 | 执行对应工程活动前 | 工程规则 |
| `docs/plans/active/` | 开发中计划 | 执行未完成方案或继续拆解任务时 | 临时计划 |
| `docs/plans/archive/` | 已完成、废弃或历史计划 | 追溯历史事实时 | 历史记录 |
| `.agents/` | lz 工作台骨架、项目 Context 与轻量 Skill Adapter | 执行任务或命中专项约束时 | 执行入口；骨架由 `lz init` 维护，Context 由 `bwy-project-context-init` 维护 |

## 3. 读取原则

- 先判断任务类型，再读取最小必要文档。
- 不默认全文读取 `docs/business/` 或 `docs/rules/`；先读索引，再按任务进入最小业务域文件。
- 老项目业务说明必须由 AI 代理全仓库审计后沉淀；脚本事实包不能直接当成业务真理。
- 项目 `.agents/skills/*.yaml` 只是指向 canonical active 全局 Skill 的轻量 Adapter；业务细节进入 `docs/business/`，工程约束进入 `docs/rules/`。
- `.codex/` 属于个人级/全局级配置，不存放项目业务知识。

## 4. 常见任务入口

| 任务 | 第一入口 | 后续读取 |
|------|----------|----------|

| 前端修改 | `docs/README.md` | 对应页面/业务域单文件与 `docs/rules/frontend_rules.md` |
| 业务域修改 | `docs/README.md` | 对应 `docs/business/<domain>.md` 单文件和必要工程规则 |
| 新增或修改测试 | `docs/rules/unit_test_rules.md` 或 `docs/rules/integration_test_rules.md` | 按测试层级读取业务域验证清单 |
| 文档元数据维护 | `docs/rules/document_metadata_rules.md` | 给新增或修改的关键文档补统一头部 |
| IPC 或事件契约修改 | `docs/api-contract.md` | 同步前端 invoke、Rust command、事件 payload 和测试 |
| AI tool、MCP、pending/confirm/audit 或 secret 输入 | `.agents/skills/bwy-ai-tool-security-guard-adapter.yaml` | `docs/business/zterm-workbench.md`、`docs/rules/security_config_rules.md` 与相关 Rust 服务 |
| Tauri command、capability、本地文件、keyring 或安装包 | `.agents/skills/bwy-tauri-desktop-standard-adapter.yaml` | `docs/api-contract.md`、相关业务文档和 Rust 测试 |
| 发布前验证 | `docs/verification.md` | 对照 README 和 active plan 复核验证命令 |
| 模块边界或影响分析 | `docs/README.md` | 对应模块拆分、职责边界或影响分析文档 |
| 开发计划执行 | `docs/plans/active/` | 对应计划；完成后归档到 `docs/plans/archive/` |
| 上下文成本审计 | `docs/README.md` 与相关索引 | 检查过读、重复规则和历史全文误读；Context 与 Adapter 由 `bwy-project-context-init` 维护 |

## 5. 业务域索引

| 业务域 | 文档 | 一句话说明 |
| --- | --- | --- |
| zTerm 工作台 | `docs/business/zterm-workbench.md` | 当前首屏工作台、窗口壳、静态终端/会话/文件/AI 入口和已实现边界。 |

## 6. 分析文档索引

| 分析主题 | 文档 | 一句话说明 |
| --- | --- | --- |
| 终端优化回归与预防 | [终端回归经验](analysis/terminal-regression-lessons.md) | Agent 输出、rz/sz 协议边界、WebView2 指针问题与验收证据分层。 |

## 7. 业务说明维护

初始化骨架只在本文保留业务域与分析文档导航。AI 代理必须基于目标项目代码事实继续生成或补齐：

- 真实业务说明：入口、主流程、业务规则、状态机、数据不变量、边界异常、修改指南、验证清单、历史决策和风险。默认业务域单文件。
- 项目专属规则：模型命名、模块归属、异常、事务、配置、测试隔离等目标项目约束。
- 专项能力：根据触发边界使用 `.agents/skills/*.yaml` Adapter 连接全局 Skill，不在项目内复制 `SKILL.md`。

空项目或证据不足时，只记录证据缺口和后续补充清单，不编造业务结论。

---

## bwy-project-context-init 补充入口

本项目按 `analysis / business / rules` 分层维护 AI 辅助开发文档资产。新增或修改文档时，优先补齐元数据头，并明确适用任务、禁止场景和权威等级。
