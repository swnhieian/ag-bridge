# AG Bridge API

## Overview

The bridge exposes a local HTTP API and an SSE stream.

Default server address:

- `http://127.0.0.1:9464`

The CLI uses the same API via `AG_BRIDGE_URL` or the default base URL above.

## Concepts

### Session

A bridge session maps to one Antigravity cascade.

The bridge-facing `sessionId` is distinct from the AG-native `cascadeId`.

面向 bridge 的 `sessionId` 与 AG 原生的 `cascadeId` 是两套不同标识。

### Snapshot

A snapshot is the latest known state of a session, including:

- run status
- latest text
- latest thinking
- unresolved approvals
- event count

### Event

An event is an append-only record in the session event log.

Every event has:

- `seq`
- `sessionId`
- `cascadeId`
- `timestamp`
- `recordedAt`
- `type`
- `data`

Time semantics:

- `timestamp`
  - canonical event time
  - prefers the timestamp recorded inside Antigravity when the bridge can recover it from protobuf metadata
  - falls back to bridge receive / append time when no AG-side timestamp exists
- `recordedAt`
  - when the bridge appended the event locally
- `sourceTimestamp`
  - optional
  - the recovered Antigravity timestamp for AG-originated events

## HTTP API

### `GET /health`

Returns bridge health and runtime statistics.

Example response:

```json
{
  "ok": true,
  "sessionCount": 1,
  "clientCount": 1,
  "defaultMode": "connect"
}
```

### `GET /sessions`

Returns all active session snapshots.

### `POST /sessions`

Creates a new session.

Request body:

```json
{
  "mode": "connect",
  "workspacePath": "/Users/me/project",
  "sessionId": "demo_session_001"
}
```

Fields:

- `mode`
  - optional
  - `connect` or `launch`
  - defaults to `connect`
- `workspacePath`
  - optional
  - forwarded to the underlying client selection / launch logic
- `model`
  - optional
  - default model for the session
- `sessionId`
  - optional
  - custom bridge session id
  - automatically generated when omitted

Response:

```json
{
  "session": {
    "id": "sess_123",
    "cascadeId": "cascade_456",
    "mode": "connect",
    "workspacePath": "/Users/me/project",
    "createdAt": "2026-03-28T07:30:00.000Z",
    "updatedAt": "2026-03-28T07:30:00.000Z",
    "bridgeCreatedAt": "2026-03-30T02:10:00.000Z",
    "bridgeUpdatedAt": "2026-03-30T02:10:00.000Z",
    "sourceCreatedAt": "2026-03-28T07:30:00.000Z",
    "sourceUpdatedAt": "2026-03-28T07:30:00.000Z",
    "runStatus": "idle",
    "latestText": "",
    "latestThinking": "",
    "eventCount": 1,
    "pendingApprovals": []
  }
}
```

Fields:

- `key`
  - stable display key
- `label`
  - display label from the LS
- `kind`
  - `model` or `alias`
- `name`
  - enum name such as `CLAUDE_4_SONNET` or `AUTO`
- `id`
  - numeric enum id
- `isPremium`
- `isRecommended`
- `disabled`

### `GET /sessions/:id`

Returns one session snapshot.

### `POST /sessions/:id/resume`

Resumes an existing session.

Behavior:

- if the session is already live, the current live session is returned
- if the session only exists on disk, the bridge re-attaches it using the stored `cascadeId`
- the bridge attempts to preserve the original `sessionId`

### `GET /sessions/:id/events`

Returns recorded events for a session.

Query params:

- `since`
  - optional integer
  - only returns events where `seq > since`

Response:

```json
{
  "events": [
    {
      "seq": 2,
      "sessionId": "sess_123",
      "cascadeId": "cascade_456",
      "timestamp": "2026-03-28T07:31:00.000Z",
      "recordedAt": "2026-03-30T02:11:00.000Z",
      "sourceTimestamp": "2026-03-28T07:31:00.000Z",
      "type": "cascade.text.delta",
      "data": {
        "stepIndex": 1,
        "delta": "Summary: ",
        "fullText": "Summary: ...",
        "sourceTimestamp": "2026-03-28T07:31:00.000Z",
        "latestTimestamp": "2026-03-28T07:31:00.000Z"
      }
    }
  ]
}
```

### `POST /sessions/:id/messages`

Sends a user message to the session's cascade.

If the target session only exists on disk, CLI helpers typically resume it first before sending.

Request body:

```json
{
  "text": "Summarize the repo"
}
```

Response:

```json
{
  "ok": true
}
```

### `POST /sessions/:id/cancel`

Cancels the active cascade execution.

Response:

```json
{
  "ok": true
}
```

### `POST /sessions/:id/approvals/:stepIndex/approve`

Approves a pending interaction.

Request body:

```json
{
  "scope": "once"
}
```

Fields:

- `scope`
  - optional
  - currently relevant for file permission approvals
  - `once` or `conversation`

Response:

```json
{
  "ok": true
}
```

## SSE Stream

### `GET /sessions/:id/stream`

Streams events in SSE format.

Query params:

- `since`
  - optional integer
  - replays buffered events where `seq > since` before live streaming

Server event names:

- `ready`
- `event`

`ready` payload:

```json
{
  "session": {
    "id": "sess_123",
    "cascadeId": "cascade_456",
    "mode": "connect",
    "workspacePath": "/Users/me/project",
    "requestedModel": "model:CLAUDE_4_SONNET",
    "createdAt": "2026-03-28T07:30:00.000Z",
    "updatedAt": "2026-03-28T07:30:00.000Z",
    "bridgeCreatedAt": "2026-03-30T02:10:00.000Z",
    "bridgeUpdatedAt": "2026-03-30T02:12:00.000Z",
    "sourceCreatedAt": "2026-03-28T07:30:00.000Z",
    "sourceUpdatedAt": "2026-03-28T07:31:15.000Z",
    "runStatus": "idle",
    "latestText": "",
    "latestThinking": "",
    "eventCount": 1,
    "pendingApprovals": []
  }
}
```

`event` payload:

```json
{
  "seq": 5,
  "sessionId": "sess_123",
  "cascadeId": "cascade_456",
  "timestamp": "2026-03-28T07:31:15.000Z",
  "recordedAt": "2026-03-30T02:12:01.000Z",
  "sourceTimestamp": "2026-03-28T07:31:15.000Z",
  "type": "cascade.thinking.delta",
  "data": {
    "delta": "Analyzing the workspace...",
    "fullText": "Analyzing the workspace...",
    "stepIndex": 1,
    "sourceTimestamp": "2026-03-28T07:31:15.000Z",
    "latestTimestamp": "2026-03-28T07:31:15.000Z"
  }
}
```

## Event Types

### `session.created`

Data:

- `mode`
- `workspacePath`

### `message.sent`

Data:

- `text`
- optional `requestedModel`

### `cascade.status`

Data:

- `status`
- `previousStatus`

### `cascade.step.new`

Data:

- `stepIndex`
- `stepType`
- `category`
- `status`
- `rawStatus`
- `description`
- `hasInteraction`
- `step`
  - complete structured step detail
  - includes `payload` for the current oneof body
  - includes `raw` for the protobuf JSON expansion
  - includes `sourceTimestamp`, `latestTimestamp`, and `timing`
  - `timing.statusTransitions` expands AG internal status transition timestamps

### `cascade.step.updated`

Data:

- `stepIndex`
- `stepType`
- `category`
- `status`
- `rawStatus`
- `previousStatus`
- `description`
- `hasInteraction`
- `step`
  - complete structured step detail
  - includes `payload` for the current oneof body
  - includes `raw` for the protobuf JSON expansion
  - includes `sourceTimestamp`, `latestTimestamp`, and `timing`

### `cascade.text.delta`

Data:

- `stepIndex`
- `delta`
- `fullText`

### `cascade.thinking.delta`

Data:

- `stepIndex`
- `delta`
- `fullText`

### `cascade.command.output`

Data:

- `stepIndex`
- `stream`
  - `stdout` or `stderr`
- `delta`
- `fullText`

## Models

### `GET /models`

Lists the models currently exposed by the connected Antigravity LS.

Query params:

- `workspacePath`
  - optional string
  - helps auto-detection prefer the LS associated with a workspace

Response:

```json
{
  "models": [
    {
      "key": "Claude_4_Sonnet",
      "label": "Claude 4 Sonnet",
      "kind": "model",
      "name": "CLAUDE_4_SONNET",
      "id": 281,
      "isPremium": true,
      "isRecommended": true,
      "disabled": false
    }
  ]
}
```

### `cascade.approval.needed`

Data:

- `stepIndex`
- `approvalType`
- `description`
- `autoRun`
- `needsApproval`
- optional `commandLine`
- optional `filePath`
- optional `isDirectory`
- optional `url`

### `cascade.approval.resolved`

Data:

- `stepIndex`
- `scope`

### `cascade.done`

Data:

- empty object

### `cascade.error`

Data:

- `message`

### `session.cancel.requested`

Data:

- empty object

## CLI

### `serve`

Starts the local bridge server.

Example:

```bash
npm run build
node ./bin/ag-bridge.js serve
```

Options:

- `--port <number>`
- `--host <ip-or-hostname>`

### `session:create`

Creates a new session.

Examples:

```bash
node ./bin/ag-bridge.js session:create
node ./bin/ag-bridge.js session:create --mode launch --workspace /Users/me/project
node ./bin/ag-bridge.js session:create --workspace /Users/me/project --session-id demo_session_001
```

### `resume [sessionId]`

Resumes an existing session and enters interactive chat.

Examples:

```bash
node ./bin/ag-bridge.js resume demo_session_001
node ./bin/ag-bridge.js resume --last
```

### `list-models`

Lists models currently exposed by the connected LS.

Examples:

```bash
node ./bin/ag-bridge.js list-models
node ./bin/ag-bridge.js list-models --workspace /Users/me/project
node ./bin/ag-bridge.js list-models --json
```

### `session:list`

Lists all active sessions.

### `session:get <sessionId>`

Returns one session snapshot.

### `send <sessionId> <text>`

Sends one message to a session.

The CLI auto-resumes persisted sessions before sending.

### `events <sessionId>`

Returns buffered events as JSON.

### `stream <sessionId>`

Streams live events over SSE and prints them to stdout.

The CLI auto-resumes persisted sessions before streaming.

### `cancel <sessionId>`

Cancels a running session.

### `approve <sessionId> <stepIndex>`

Approves a pending interaction.

### `ask <text>`

Convenience command:

1. creates a session
2. opens an SSE stream
3. sends the prompt
4. prints text deltas to stdout
5. prints thinking/status/approval info to stderr
6. exits after `cascade.done` or `cascade.error`

Useful options:

- `--session <sessionId>`
  - reuse a specific existing session
- `--last`
  - reuse the most recently updated session
- `--session-id <id>`
  - assign a custom bridge session id when creating a new session
- `--thinking on|off`
  - control whether thinking deltas are printed
- `--model <model>`
  - override the model for this turn
- `--workspace <path>`
  - prefer a workspace when creating or resuming

## Python CLI

The repository also ships a local Python CLI that targets the same HTTP API surface. It is intended for local scripts and automation, not a separate remote publishing flow.

Install locally:

```bash
pip install -e python
```

Examples:

```bash
ag-bridge-py list-models
ag-bridge-py session-create --session-id demo_session_001
ag-bridge-py ask "Please reply with OK only." --thinking off
ag-bridge-py ask "Continue this conversation" --session demo_session_001
ag-bridge-py resume --last
ag-bridge-py chat --last
ag-bridge-py stream demo_session_001 --thinking off
```
