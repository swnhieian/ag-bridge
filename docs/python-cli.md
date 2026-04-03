# Python SDK and CLI

# Python SDK 与 CLI

This document focuses on using AG Bridge from Python code and the bundled Python CLI.

这份文档聚焦如何从 Python 代码以及仓库内附带的 Python CLI 调用 AG Bridge。

For build, packaging, and installation of the extension itself, see:

如果你主要关心扩展本体的构建、打包和安装，请看：

- [Build, Package, and Install](build.md)

For HTTP endpoints, see:

如果你主要关心 HTTP 接口，请看：

- [API Reference](api.md)
- [接口文档](接口文档.md)

## 1. Why Python

This is the recommended way to call the bridge from other projects.

这是当前更推荐的“给别的项目调用”的方式。

Why:

原因：

- the bridge core remains in TypeScript / the VS Code extension
- Python only calls the local HTTP API
- it works well for scripts, backend jobs, and automation pipelines

- bridge 核心仍然在 TypeScript / VS Code 扩展里
- Python 只负责调用本地 HTTP 接口
- 对脚本、后端任务和自动化流水线更友好

## 2. Install

```bash
pip install -e python
```

The client resolves the base URL from the explicit argument first, then `AG_BRIDGE_URL`, then falls back to `http://127.0.0.1:9464`.

Python 客户端会优先使用显式传入的地址，其次读取 `AG_BRIDGE_URL`，最后回退到 `http://127.0.0.1:9464`。

## 3. Python SDK Example

```python
from ag_bridge_client import BridgeClient

client = BridgeClient("http://127.0.0.1:9465")
status = client.status()
print(status["address"])

models = client.list_models()
print(models[0]["name"])

synced = client.sync_ag_sessions()
print([session["id"] for session in synced["attached"]])

result = client.ask("请只回复 OK")
print(result["text"])

session = client.create_session(
    workspace_path="/绝对路径/项目",
    model="claude-4-sonnet",
)
print(session["requestedModel"])
```

## 4. Python CLI Example

```bash
ag-bridge-py status
ag-bridge-py session-list
ag-bridge-py list-models
ag-bridge-py model-list
ag-bridge-py model-list --workspace /绝对路径/项目
ag-bridge-py ag-session-list
ag-bridge-py ag-session-sync
ag-bridge-py session-create --workspace /绝对路径/项目 --model claude-4-sonnet --session-id demo_session_001
ag-bridge-py ask "请只回复 OK" --model auto --thinking off
ag-bridge-py ask "继续这个会话" --session demo_session_001
ag-bridge-py ask "如果没有这个 session 就自动创建" --session demo_session_001 --create-if-missing
ag-bridge-py resume --last
ag-bridge-py resume demo_session_001 --create-if-missing
ag-bridge-py chat --last
ag-bridge-py chat --session demo_session_001 --create-if-missing
ag-bridge-py send demo_session_001 "Hello" --create-if-missing
ag-bridge-py stream demo_session_001 --thinking off
```

## 5. Notes

- `list-models` and `model-list` are both supported
- `ask`、`chat`、`resume`、`send` support `--create-if-missing`
- the Python side is an SDK / CLI wrapper over the local bridge HTTP API

- `list-models` 和 `model-list` 都可以使用
- `ask`、`chat`、`resume`、`send` 支持 `--create-if-missing`
- Python 侧仍然是对本地 bridge HTTP API 的 SDK / CLI 包装层
