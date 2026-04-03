# Changelog

## Unreleased

## 0.1.3

Refined the release metadata and documentation layout, while hardening session recovery and auto-approval behavior for long-running bridge workflows.

整理了新一轮扩展打包与发布所需的版本元数据、文档结构，并增强了长时间 bridge 工作流中的会话补齐与自动审批行为。

- Bumped the extension and Python client package versions to `0.1.3`.
- Split the build, Node CLI, and Python CLI guides into dedicated documents while keeping the original entry page as an index.
- Updated `POST /ag-sessions/sync` so already attached live sessions also re-run history reconciliation, helping backfill turns missed after reactive stream gaps.
- Restored auto-approval coverage in polling fallback mode, including inline file-permission waits exposed directly from tool steps such as `viewFile`.

- 将扩展和 Python client 的版本号提升到 `0.1.3`。
- 将构建、Node CLI、Python CLI 说明拆分成独立文档，同时保留原入口页作为索引。
- 更新了 `POST /ag-sessions/sync` 的行为：已经 attach 的 live session 也会重新执行一次历史补齐，帮助修复 reactive stream 间歇缺口后遗漏的 turn。
- 恢复了 polling fallback 模式下的自动审批覆盖范围，包括 `viewFile` 这类 step 直接内嵌的文件权限等待。

## 0.1.2

Improved automation ergonomics for streaming, approvals, and local CLI usage.

增强了流式输出、审批处理和本地 CLI 使用体验。

- Added GitHub Actions CI and tag-based Open VSX release automation.
- Added a first-class Node CLI entrypoint through `bin/ag-bridge.js`.
- Added native binary packaging for the Node CLI through `npm run package:cli:binary`.
- Added compressed CLI archives and multi-target packaging support for the Node CLI binary flow.
- Expanded the Python SDK / CLI to cover session resume, stream, chat, ask session reuse, and Node-aligned command aliases.
- Restored repository-aware documentation links now that the GitHub repository metadata is configured.
- Added `--create-if-missing` for CLI session-oriented flows so named sessions can be auto-created on demand.
- Improved SSE flushing and moved Python turn handling from polling to direct stream consumption.
- Added `--auto-approve` to Node CLI streaming and turn-oriented flows so approval steps can continue without pausing.
- Added local bridge discovery by workspace through a registry-backed resolution flow in the Node CLI.
- Added friendly model aliases such as `flash`, `pro`, `sonnet`, `opus`, and `gpt-oss`.

- 新增 GitHub Actions CI，以及基于 tag 的 Open VSX 自动发布流程。
- 通过 `bin/ag-bridge.js` 提供了更明确的 Node CLI 入口。
- 新增 Node CLI 原生二进制打包能力，可通过 `npm run package:cli:binary` 生成本机可执行文件。
- 为 Node CLI 二进制打包补充了压缩分发包和多目标平台打包支持。
- 扩展了 Python SDK / CLI，补齐 session resume、stream、chat、ask 复用 session，以及与 Node 对齐的命令别名。
- 在配置好 GitHub 仓库元数据之后，恢复了 README 中面向仓库的文档链接。
- 为 CLI 的会话型命令补充了 `--create-if-missing`，可以在按名称指定 session 时按需自动创建。
- 改进了 SSE 刷新时机，并把 Python turn 流程从轮询改成了直接消费事件流。
- 为 Node CLI 的流式和 turn 类命令补充了 `--auto-approve`，遇到审批步骤时可以自动继续而不暂停。
- 为 Node CLI 增加了基于工作区的本地 bridge discovery 机制，通过 registry 自动解析目标实例。
- 补充了 `flash`、`pro`、`sonnet`、`opus`、`gpt-oss` 等友好模型别名。

## 0.1.1

Enhanced session management for bridge-driven workflows.

增强了面向 bridge 工作流的 session 管理能力。

- Added caller-defined bridge `sessionId` support when creating a session.
- Added session resume support through HTTP and CLI.
- Added `resume` and `--last` flows to make it easier to continue previous conversations.
- Extended the CLI `ask` command with session reuse and thinking-output controls.
- Improved bridge-side mapping between `session.id` and AG `cascadeId` for resumed sessions.
- Updated related documentation for session identity, resume behavior, and CLI usage.

- 支持在创建 session 时由调用方指定 bridge `sessionId`。
- 新增 HTTP 和 CLI 的 session 恢复能力。
- 新增 `resume` 和 `--last` 用法，便于继续上一次会话。
- 为 CLI `ask` 命令补充了复用 session 和控制 thinking 输出的能力。
- 强化了恢复场景下 bridge `session.id` 与 AG `cascadeId` 的映射关系。
- 同步更新了 session 标识、恢复行为和 CLI 用法相关文档。

## 0.1.0

Initial public release with the core bridge workflow.

首个公开版本，提供完整的基础 bridge 能力。

- Started a local HTTP / SSE bridge inside the Antigravity extension host.
- Exposed session creation, messaging, streaming, export, and AG session attach / sync APIs.
- Added a dashboard for service status, session overview, and automation controls.
- Added CLI and Python integration for scripts, automation, and local tooling.
- Exported full step detail, including text, thinking, command output, approvals, and protobuf-style raw payloads.

- 在 Antigravity 扩展宿主内启动本地 HTTP / SSE bridge 服务。
- 提供 session 创建、消息发送、事件流订阅、导出，以及 AG 会话 attach / sync 接口。
- 提供状态面板，用于查看服务状态、session 概览和自动化控制。
- 提供 CLI 和 Python 集成，方便脚本、自动化和本地工具调用。
- 导出完整的 step 详情，包括文本、thinking、命令输出、审批信息和 protobuf 风格的原始 payload。
