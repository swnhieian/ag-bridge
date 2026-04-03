# Node CLI

# Node CLI 使用

This document focuses on the repository-local Node CLI, including local service startup, discovery, sessions, and interactive workflows.

这份文档聚焦仓库内的 Node CLI，包括本地服务启动、discovery、session 和交互式用法。

For build, packaging, and installation, see:

如果你主要关心构建、打包和安装，请看：

- [Build, Package, and Install](build.md)

For HTTP endpoints, see:

如果你主要关心 HTTP 接口，请看：

- [API Reference](api.md)
- [接口文档](接口文档.md)

## 1. Entrypoints

The source-based entrypoint is `node ./bin/ag-bridge.js`.

源码形式的入口是 `node ./bin/ag-bridge.js`。

If you have already built a native binary, you can replace that prefix with the executable path under `artifacts/cli/`.

如果你已经生成了原生二进制，也可以把下面命令里的前缀替换成 `artifacts/cli/` 下对应的可执行文件路径。

## 2. Package a Native Binary

```bash
npm run package:cli:binary
```

Example output:

例如输出：

```bash
artifacts/cli/ag-bridge-cli-darwin-arm64
artifacts/cli/ag-bridge-cli-0.1.3-darwin-arm64.tar.gz
```

Build several common release targets in one go:

一次性生成几种常用发布目标：

```bash
npm run package:cli:binary:all
```

This command defaults to the current host target, but the script also supports `--target` and `--targets` for explicit platform / architecture selection.

这条命令默认生成当前机器对应的目标，但脚本也支持通过 `--target` 和 `--targets` 显式指定平台和架构。

## 3. Start the Local Service

```bash
node ./bin/ag-bridge.js serve
```

Publish the current workspace into local discovery:

把当前工作区发布到本地 discovery：

```bash
node ./bin/ag-bridge.js serve --workspace /absolute/path/to/project
```

Specify a custom data directory:

指定数据目录：

```bash
node ./bin/ag-bridge.js serve --data-dir /absolute/path/.ag-bridge
```

## 4. Base URL Resolution and Discovery

Without `--base-url`, the Node CLI resolves the bridge in this order:

如果不传 `--base-url`，Node CLI 会按这个顺序解析 bridge：

- `AG_BRIDGE_URL`
- local registry-based workspace discovery
- `http://127.0.0.1:9464`

- 基于本地 registry 的工作区 discovery
- `http://127.0.0.1:9464`

If the service is running on another port:

如果服务实际跑在别的端口：

```bash
node ./bin/ag-bridge.js --base-url http://127.0.0.1:9465 status
```

## 5. Check Status

```bash
node ./bin/ag-bridge.js status
```

## 6. List and Sync Native AG Sessions

```bash
node ./bin/ag-bridge.js ag:list
node ./bin/ag-bridge.js ag:sync
node ./bin/ag-bridge.js ag:attach <cascadeId>
```

## 7. List Available Models

```bash
node ./bin/ag-bridge.js list-models
```

The table output now includes an `ALIAS` column with friendly short names.

输出表格现在会额外带一个 `ALIAS` 列，用来展示友好短名。

Prefer a specific workspace-connected language server:

如果你想优先连接某个工作区关联的语言服务器：

```bash
node ./bin/ag-bridge.js list-models --workspace /absolute/path/to/project
```

Machine-readable JSON output:

如果你需要机器可读输出：

```bash
node ./bin/ag-bridge.js list-models --json
```

## 8. Create a Session

```bash
node ./bin/ag-bridge.js session:create --workspace /absolute/path/to/project
```

Specify a model:

指定模型：

```bash
node ./bin/ag-bridge.js session:create --workspace /absolute/path/to/project --model claude-4-sonnet
```

Specify a custom bridge session id:

指定自定义 bridge session id：

```bash
node ./bin/ag-bridge.js session:create --workspace /absolute/path/to/project --model claude-4-sonnet --session-id demo_session_001
```

The CLI supports `--mode`, `--workspace`, `--model`, and `--session-id`.

CLI 支持 `--mode`、`--workspace`、`--model` 和 `--session-id`。

## 9. One-Shot Ask

```bash
node ./bin/ag-bridge.js ask "Please reply with OK only."
```

Specify a model:

指定模型：

```bash
node ./bin/ag-bridge.js ask "Please reply with OK only." --model auto
```

Reuse an existing session:

复用已有 session：

```bash
node ./bin/ag-bridge.js ask --session demo_session_001 "Continue this conversation"
node ./bin/ag-bridge.js ask --last "Continue the latest session"
```

Create the requested session automatically when it does not exist yet:

如果指定的 session 还不存在，可以自动创建：

```bash
node ./bin/ag-bridge.js ask --session demo_session_001 --create-if-missing "Start a new conversation in this named session"
```

Control whether thinking output is shown:

控制是否输出 thinking 过程：

```bash
node ./bin/ag-bridge.js ask "Please reply with OK only." --thinking off
```

Continue automatically through approval steps:

遇到审批步骤时自动继续：

```bash
node ./bin/ag-bridge.js ask "Review this repo and keep going" --auto-approve
```

## 10. Interactive Chat and Resume

```bash
node ./bin/ag-bridge.js chat --model recommended
```

Auto-approve while chatting:

交互模式里自动审批：

```bash
node ./bin/ag-bridge.js chat --last --auto-approve
node ./bin/ag-bridge.js resume demo_session_001 --auto-approve
```

Resume the most recent session:

恢复最近一个 session：

```bash
node ./bin/ag-bridge.js chat --last
node ./bin/ag-bridge.js resume --last
```

Resume a specific session:

恢复指定 session：

```bash
node ./bin/ag-bridge.js resume demo_session_001
```

Auto-create a named session before entering chat:

如果指定 session 不存在，也可以先自动创建再进入交互：

```bash
node ./bin/ag-bridge.js resume demo_session_001 --create-if-missing
node ./bin/ag-bridge.js chat --session demo_session_001 --create-if-missing
node ./bin/ag-bridge.js send demo_session_001 "Hello" --create-if-missing
```

Useful interactive commands:

常用交互命令：

- `/help`
- `/new [connect|launch] [workspacePath] [model] [sessionId]`
- `/use <sessionId>`
- `/resume [sessionId|last]`
- `/sessions`
- `/ag-sessions`
- `/sync`
- `/attach <cascadeId>`
- `/status`
- `/events [limit]`
- `/export`
- `/approve <stepIndex> [once|conversation]`
- `/cancel`
- `/thinking on|off`
- `/quit`

## 11. Stream a Session

```bash
node ./bin/ag-bridge.js stream demo_session_001
node ./bin/ag-bridge.js stream demo_session_001 --auto-approve
```

## 12. Export a Session

```bash
node ./bin/ag-bridge.js export <sessionId>
```
