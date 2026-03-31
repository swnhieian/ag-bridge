# ag-bridge-client

`ag-bridge-client` 是给 `AG Bridge` 本地 HTTP 服务准备的一层 Python SDK / CLI。

它不重写 Antigravity 的桥接逻辑，而是直接调用本地扩展启动出来的接口，因此更适合在自动化脚本、测试工具、后端任务里复用。

## 安装

```bash
pip install -e python
```

## 使用

```python
from ag_bridge_client import BridgeClient

client = BridgeClient()
status = client.status()
print(status["address"])

models = client.list_models()
print([model["name"] for model in models])
print(models[0]["label"])

synced = client.sync_ag_sessions()
print([session["id"] for session in synced["attached"]])

result = client.ask("请只回复 OK")
print(result["text"])

session = client.create_session(model="claude-4-sonnet")
print(session["requestedModel"])
```

## CLI

```bash
ag-bridge-py status
ag-bridge-py session-list
ag-bridge-py model-list
ag-bridge-py model-list --workspace /绝对路径/项目
ag-bridge-py ag-session-list
ag-bridge-py ag-session-sync
ag-bridge-py session-create --model claude-4-sonnet --session-id demo_session_001
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

补充说明：

- 这套 Python CLI 直接调用本地 AG Bridge HTTP API
- 命令面尽量和仓库里的 Node CLI 保持一致
- 对 `ask`、`chat`、`resume`、`send` 这类会话型命令，可以通过 `--create-if-missing` 自动补建指定 session
- 当前它只作为仓库内的本地工具维护，不走单独的 PyPI 发布流程
