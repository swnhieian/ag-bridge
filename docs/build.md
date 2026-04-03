# Build, Package, and Install

# 构建、打包与安装

This document focuses on source builds, packaging, installation, release flow, and runtime layout.

这份文档聚焦源码构建、打包、安装、发布流程以及运行时布局。

For CLI usage, see:

如果你主要关心 CLI 用法，请看：

- [Node CLI](node-cli.md)
- [Python CLI](python-cli.md)

For HTTP endpoints and request details, see:

如果你主要关心 HTTP 接口和请求细节，请看：

- [API Reference](api.md)
- [接口文档](接口文档.md)

## 1. Requirements

Recommended environment:

推荐环境：

- macOS
- Antigravity.app installed
- Logged into Antigravity at least once
- Node.js 22+
- npm 10+
- Python 3.10+ if you plan to use the Python SDK
- VS Code 1.85+

- 已安装 Antigravity.app
- 至少登录过一次 Antigravity
- Node.js 22+
- npm 10+
- 如果准备使用 Python SDK，建议 Python 3.10+
- VS Code 1.85+

Current validation is focused on `connect` mode, which attaches to an already running Antigravity Language Server.

当前主要验证的是 `connect` 模式，也就是连接已经运行中的 Antigravity Language Server。

## 2. Build from Source

Run these commands at the repository root:

在仓库根目录执行：

```bash
npm install
npm run build
```

Type-check only:

只做类型检查：

```bash
npm run check
```

This generates the following artifacts:

这一步会生成下面这些产物：

- `dist/`: compiled runtime and extension code
- `extension.cjs`: VS Code extension entry wrapper
- `bin/ag-bridge.js`: repository-local Node CLI entrypoint
- `artifacts/cli/`: generated native CLI binaries after running the binary packaging step

- `dist/`：编译后的运行代码
- `extension.cjs`：VS Code 扩展入口包装器
- `bin/ag-bridge.js`：仓库内使用的 Node CLI 入口
- `artifacts/cli/`：执行二进制打包后生成的 CLI 可执行文件目录

## 3. Package as VSIX

Build the extension package with:

直接执行下面命令即可打包：

```bash
npm run package:vsix
```

The resulting file is written to the repository root, for example:

成功后会在项目根目录生成 `.vsix`，例如：

```bash
ag-bridge-0.1.3.vsix
```

The package is self-contained and includes runtime dependencies, so a larger file size is expected.

这版 `vsix` 是自包含的，已经带上运行时依赖，所以体积偏大是正常现象。

The Node CLI and Python CLI are bundled in the repository for local tooling and automation, but they are not published as standalone packages in the current release flow.

Node CLI 和 Python CLI 目前都是作为仓库内的本地工具一起维护的，当前发布流程不会把它们单独发布成独立包。

## 4. Package the Node CLI as a Native Binary

If you want a single executable for the current machine, run:

如果你希望为当前机器直接生成一个可执行文件，可以执行：

```bash
npm run package:cli:binary
```

The output is written to `artifacts/cli/`, and includes both the raw executable and a compressed archive, for example:

产物会输出到 `artifacts/cli/`，同时包含原始可执行文件和压缩包，例如：

```bash
artifacts/cli/ag-bridge-cli-darwin-arm64
artifacts/cli/ag-bridge-cli-0.1.3-darwin-arm64.tar.gz
```

Build a common release set:

如果要生成常用发布组合：

```bash
npm run package:cli:binary:all
```

You can also choose explicit targets:

也可以显式指定目标平台和架构：

```bash
node ./scripts/package-cli-binary.mjs --target linux-x64
node ./scripts/package-cli-binary.mjs --targets darwin-arm64,darwin-x64,linux-x64,win32-x64
```

Supported targets:

支持的目标：

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64`
- `linux-x64`
- `win32-arm64`
- `win32-x64`

The current implementation still uses Node SEA, so the raw binary itself remains relatively large, but the generated archive is much more suitable for distribution.

当前实现仍然基于 Node SEA，所以原始二进制本体依然会比较大，但新增的压缩包会更适合分发。

## 5. GitHub Actions and Open VSX Release

The repository includes:

仓库里现在带了两条 GitHub Actions 工作流：

- `.github/workflows/ci.yml`
- `.github/workflows/release-openvsx.yml`

Behavior:

行为说明：

- pushes to `main` and pull requests run type-check, build, VSIX packaging, and Python CLI smoke checks
- pushing a tag such as `v0.1.3` triggers an Open VSX publish workflow
- the tag version must match `package.json`
- you need to configure the repository secret `OVSX_TOKEN`

- 向 `main` push 或发起 pull request 时，会执行类型检查、构建、VSIX 打包和 Python CLI 基本校验
- 推送类似 `v0.1.3` 的 tag 时，会触发发布到 Open VSX 的工作流
- tag 版本必须与 `package.json` 中的版本一致
- 需要提前在 GitHub 仓库里配置 `OVSX_TOKEN` 这个 secret

## 6. Install the Extension

If the extension has been published to `Open VSX`, installing it from the Antigravity / VS Code marketplace is recommended.

如果扩展已经发布到 `Open VSX`，优先建议直接从 Antigravity / VS Code 扩展市场安装。

Antigravity currently uses `Open VSX`, and once installed from the marketplace, future updates should normally be handled by the host marketplace flow.

Antigravity 当前使用的是 `Open VSX`，从市场安装之后，后续版本一般也交给宿主的市场更新机制处理。

The extension no longer includes a separate in-product remote update source or download button.

插件内部已经不再保留单独的远端更新源或下载入口。

### 6.1 Install from VSIX

1. Open the Extensions view.
2. Click the `...` menu.
3. Select `Install from VSIX...`.
4. Choose `ag-bridge-0.1.3.vsix`.

1. 打开扩展面板。
2. 点击右上角 `...`。
3. 选择 `Install from VSIX...`。
4. 选中 `ag-bridge-0.1.3.vsix`。

### 6.2 Install from Command Line

```bash
code --install-extension ag-bridge-0.1.3.vsix --force
```

Running `Developer: Reload Window` once after installation is recommended.

安装完成后，建议执行一次 `Developer: Reload Window`。

### 6.3 Install from Marketplace

If the extension is already published to `Open VSX`, search for either of the following:

如果扩展已经发布到 `Open VSX`，可以直接搜索下面任意一个：

- `AG Bridge`
- `weinan.ag-bridge`

## 7. What Happens After Startup

The extension starts the local bridge service automatically by default.

默认情况下，扩展激活后会自动启动本地 bridge 服务。

Default configuration:

默认配置：

- Host: `127.0.0.1`
- Port: `9464`

Available settings:

可配置项：

- `agBridge.autoStart`
- `agBridge.server.host`
- `agBridge.server.port`

### 7.1 Automatic Port Fallback

If the requested port is already occupied, the bridge automatically moves to the next available port.

如果默认端口被占用，服务会自动切到后续可用端口。

Example:

例如：

- Requested port: `9464`
- Actual port: `9465`

- 期望端口：`9464`
- 实际端口：`9465`

You can see the actual port in the following places:

实际端口可以在下面这些位置看到：

- status bar
- `AG Bridge: 查看状态`
- `AG Bridge: 打开状态面板`
- `GET /status`

- 状态栏
- `AG Bridge: 查看状态`
- `AG Bridge: 打开状态面板`
- `GET /status`

### 7.2 Command Palette

Available commands:

安装扩展后可用的命令：

- `AG Bridge: 启动服务`
- `AG Bridge: 停止服务`
- `AG Bridge: 查看状态`
- `AG Bridge: 打开状态面板`

### 7.3 Dashboard

The dashboard shows:

状态面板会展示：

- current listening address
- requested port and actual port
- data directory
- current workspace
- total, live, and persisted session counts
- session list
- last startup error
- one-click copy for the current base URL
- one-click sync for all AG sessions

- 当前监听地址
- 期望端口和实际端口
- 数据目录
- 当前工作区
- session 总数、live 数和持久化数
- session 列表
- 最近一次启动错误
- 一键复制当前 `base URL`
- 一键同步当前所有 AG sessions

## 8. Persistence Layout

Default locations:

默认情况下：

- the standalone CLI server uses `~/.ag-bridge`
- the VS Code extension uses its own `globalStorage` directory

- CLI server 使用 `~/.ag-bridge`
- VS Code 扩展使用自己的 `globalStorage` 目录

Typical structure:

目录结构大致如下：

```text
dataDir/
  meta.json
  sessions/
    <sessionId>/
      snapshot.json
      events.jsonl
```

Notes:

说明：

- `snapshot.json` stores the latest session snapshot
- `events.jsonl` stores the full event stream
- sessions are restored from here after restart

- `snapshot.json` 保存最后一次 session 快照
- `events.jsonl` 保存完整事件流
- 服务重启后会从这里恢复历史 session

## 9. Verified Behavior

The current implementation has already been validated for the following:

这套代码目前已经验证过下面这些能力：

- `npm run check`
- `npm run build`
- `npm run package:vsix`
- extension commands work
- automatic port fallback works
- `GET /status` works
- real sessions can be created
- JS CLI `ask` can receive a final AG reply
- Python SDK `ask` can receive a final AG reply
- existing AG conversations can be synced into the bridge
- session data is written to disk and restored after restart
- when reactive streaming is unavailable, polling fallback is used automatically
- auto-approval still works for approvals detected from polling fallback, including inline file-permission waits

- `npm run check` 成功
- `npm run build` 成功
- `npm run package:vsix` 成功
- 扩展命令可用
- 端口冲突时会自动切换
- `GET /status` 正常
- 可以创建真实 session
- 可以通过 JS CLI `ask` 拿到 AG 最终回复
- 可以通过 Python SDK `ask` 拿到 AG 最终回复
- 可以把 AG 里已有的手工会话同步进 bridge
- session 会写入磁盘并在重启后恢复
- reactive stream 关闭时会自动切到轮询 fallback
- 即使是轮询 fallback 里识别到的审批步骤，自动审批也仍然会继续工作，包括内联文件权限等待

## 10. Current Limitations

- `launch` mode has not received full regression coverage yet
- there is no dedicated artifact file API yet
- the interactive CLI is still single-line input only
- the Python side is an SDK / CLI wrapper, not a reimplementation of the bridge core
- newly created AG sessions that were never attached may require another `ag-sessions/sync`

- `launch` 模式还没有做完整回归
- 还没有单独的 artifact 文件接口
- 交互式 CLI 目前仍然是单行输入
- Python 侧现在是 SDK / CLI 包装层，不是 bridge 核心重写版
- 新开的 AG 会话如果之前没被 bridge attach，可能还需要再调用一次 `ag-sessions/sync`
