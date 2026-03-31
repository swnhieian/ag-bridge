# Changelog

## Unreleased

- Added GitHub Actions CI and tag-based Open VSX release automation.
- Added a first-class Node CLI entrypoint through `bin/ag-bridge.js`.
- Expanded the Python SDK / CLI to cover session resume, stream, chat, ask session reuse, and Node-aligned command aliases.
- Restored repository-aware documentation links now that the GitHub repository metadata is configured.
- Added `--create-if-missing` for CLI session-oriented flows so named sessions can be auto-created on demand.

- 新增 GitHub Actions CI，以及基于 tag 的 Open VSX 自动发布流程。
- 通过 `bin/ag-bridge.js` 提供了更明确的 Node CLI 入口。
- 扩展了 Python SDK / CLI，补齐 session resume、stream、chat、ask 复用 session，以及与 Node 对齐的命令别名。
- 在配置好 GitHub 仓库元数据之后，恢复了 README 中面向仓库的文档链接。
- 为 CLI 的会话型命令补充了 `--create-if-missing`，可以在按名称指定 session 时按需自动创建。

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
