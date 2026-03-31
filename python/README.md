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
ag-bridge-py ask "请只回复 OK" --model auto
ag-bridge-py session-create --model claude-4-sonnet
```
