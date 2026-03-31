# AG Bridge

语言： [English](README.md) | [简体中文](README.zh-CN.md)

`AG Bridge` 是一个面向 VS Code / Antigravity 的扩展。它会启动一个轻量的本地 bridge 服务，把 Antigravity Language Server 通过稳定的 HTTP 和 SSE 接口暴露出来，方便做自动化、会话接管、前端联调和脚本集成。

## 概览

- 在扩展宿主里启动本地 bridge 服务
- 提供状态面板，展示监听地址、端口、数据目录和 session
- 支持复制当前 bridge 的 base URL
- 可以同步 Antigravity 里已有的会话，并继续向这些会话发消息
- 通过 HTTP / SSE 输出文本、thinking、命令输出、审批请求和完整 step 详情
- 支持导出完整 session 数据
- 支持 CLI、Python SDK 和外部脚本接入
- 提供自动审批控制，适合半自动或全自动流程

## 典型用途

- 从你自己的前端或服务端读取 AG 会话流
- 通过脚本直接向 AG 发消息，而不是操作桌面 UI
- 把 AG 的输出接到测试、代理、工作流编排或其他工具
- 拿到完整 step 数据，而不仅仅是最终文本

## 环境要求

推荐环境：

- macOS
- 已安装 Antigravity.app
- 至少登录过一次 Antigravity
- Node.js 22+

当前默认模式是 `connect`，也就是连接已经运行中的 Antigravity Language Server。

## 安装

如果扩展已经发布到 `Open VSX`，优先建议直接从 Antigravity / VS Code 扩展市场安装。

你也可以直接从 VSIX 安装。

1. 打开扩展面板。
2. 点击右上角 `...`。
3. 选择 `Install from VSIX...`。
4. 选中 `ag-bridge-0.1.1.vsix`。

命令行安装：

```bash
code --install-extension ag-bridge-0.1.1.vsix --force
```

安装完成后，建议执行一次 `Developer: Reload Window`。

## 快速开始

扩展默认会自动启动本地 bridge 服务。

默认配置：

- Host: `127.0.0.1`
- Port: `9464`

如果默认端口被占用，扩展会自动切换到后续可用端口。

你可以通过下面方式打开状态页：

- `AG Bridge: 查看状态`
- `AG Bridge: 打开状态面板`
- 点击状态栏里的 `AG Bridge`

状态面板会显示：

- 当前监听地址
- 请求端口与实际端口
- 数据目录
- 当前工作区
- session 统计
- session 列表
- 自动审批设置

## 命令

- `AG Bridge: 启动服务`
- `AG Bridge: 停止服务`
- `AG Bridge: 查看状态`
- `AG Bridge: 打开状态面板`

## 常用 API 示例

查看服务状态：

```bash
curl http://127.0.0.1:9464/status
```

创建会话：

```bash
curl -X POST http://127.0.0.1:9464/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "connect",
    "workspacePath": "/absolute/path/to/project",
    "model": "claude-4-sonnet"
  }'
```

发送消息：

```bash
curl -X POST http://127.0.0.1:9464/sessions/<sessionId>/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "Please reply with OK only.",
    "model": "auto"
  }'
```

订阅实时事件：

```bash
curl -N http://127.0.0.1:9464/sessions/<sessionId>/stream
```

同步已有 AG 会话：

```bash
curl -X POST http://127.0.0.1:9464/ag-sessions/sync \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Session 标识

`session.id` 是 bridge 自己生成的，用于 bridge 路由、持久化目录以及 CLI / HTTP 的后续操作。

`cascadeId` 是 AG 原生返回的会话标识。

`trajectoryId` 可能会出现在 AG session 发现结果里，但它不是 bridge session id。

`POST /sessions` 现在可以接收可选的 `sessionId`。如果不传，bridge 仍然会自动生成。

已有 session 可以通过 `POST /sessions/:id/resume` 恢复，CLI 也支持 `resume` 和 `chat --last`。

如果是在 CLI 里指定某个 `session id` 来继续对话，也可以配合 `--create-if-missing`；当这个 session 还不存在时，会自动按这个 id 创建。

## Step 详情支持

如果你要在前端完整展示 AG 的 step，建议直接消费 `cascade.step.new` 和 `cascade.step.updated`。

这两个事件里的 `data.step` 会带完整 step 详情，包括摘要字段、当前 oneof payload，以及 protobuf 风格的原始 JSON。

## 模型选择

CLI、HTTP 和 Python SDK 都支持通过 `model` 字段指定模型。

常见写法：

- `claude-4-sonnet`
- `google-gemini-2-5-pro`
- `auto`
- `recommended`

查看当前语言服务器实际返回的模型：

```bash
node ./bin/ag-bridge.js list-models
```

恢复最近一个 session：

```bash
node ./bin/ag-bridge.js resume --last
```

仓库现在也内置了一个正式的 Node CLI 入口 `bin/ag-bridge.js`，这样无论是源码环境、本地脚本还是 CI，都可以直接复用同一套命令，而不需要显式依赖 `dist/` 路径。

## 更多文档

- [English README](README.md)
- [更新记录](CHANGELOG.md)
- [构建与使用](docs/构建与使用.md)
- [接口文档](docs/接口文档.md)
- [设计方案](docs/设计方案.md)
- [Architecture](docs/architecture.md)
- [API Reference](docs/api.md)

版本更新记录维护在 `CHANGELOG.md`。

## 自动化发布

仓库已经带上 GitHub Actions CI，会在 push 和 pull request 时校验扩展构建、VSIX 打包和 Python CLI 的基本可用性。

在仓库里配置好 `OVSX_TOKEN` 这个 repository secret 之后，推送类似 `v0.1.1` 这样的 tag，就可以自动触发发布到 `Open VSX`。

对应的工作流文件分别在 `.github/workflows/ci.yml` 和 `.github/workflows/release-openvsx.yml`。

## 开发说明

如果你是来做源码构建、重新打包或发布到 `Open VSX` 的，建议直接从下面这些文档开始。

- [构建与使用](docs/构建与使用.md)
- [接口文档](docs/接口文档.md)

## 仓库归属说明

本仓库用于维护 `AG Bridge` 扩展的源码、打包配置、文档和发布说明，也可以作为扩展归属和 namespace claim 的公开仓库依据。
