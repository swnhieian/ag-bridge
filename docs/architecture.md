# AG Bridge Design

## Goals

- Build a stable local bridge for controlling Antigravity from scripts and the terminal.
- Prefer Antigravity's Language Server over DOM scraping, CDP clicks, or webview selectors.
- Expose a simple local server API plus a thin CLI.
- Preserve step-by-step execution data, including:
  - response text deltas
  - thinking deltas
  - status changes
  - command stdout/stderr
  - approval requests

## Non-goals

- Reproducing hidden chain-of-thought that is not exposed by the Language Server.
- Implementing browser/CDP automation as the main transport.
- Building a full multi-user service or remote authentication layer.

## Why `antigravity-client`

`antigravity-client` already gives us the most important stable primitives:

- attach to an existing Antigravity Language Server with `connect()`
- optionally launch an independent Language Server with `launch()`
- start and resume cascades
- send messages to a cascade
- cancel execution
- receive structured reactive updates
- approve command / file / browser interactions

Most importantly, it emits the event classes we need directly from the LS stream:

- `text:delta`
- `thinking:delta`
- `status_change`
- `approval:needed`
- `command_output`
- `done`

This is significantly more stable than DOM parsing because it avoids coupling to Antigravity's visible UI structure.

## Stability Strategy

### 1. LS-first architecture

The bridge talks to the Antigravity LS, not the chat DOM.

That means our primary compatibility surface is:

- LS process discovery
- Connect RPC
- protobuf/reactive diff schema

This is still unofficial and can break, but it is usually less fragile than CSS selectors and button text heuristics.

### 2. Server-first control plane

The local server is the single integration point.

External scripts do not talk to `antigravity-client` directly. They talk to the bridge server, which:

- owns session lifecycle
- normalizes LS events
- keeps in-memory state for active sessions
- exposes polling and streaming APIs

The CLI is intentionally thin and simply calls the local server.

### 3. Event-sourced session state

Each session stores:

- a session snapshot
- an append-only in-memory event list
- unresolved approvals

This gives us:

- script-friendly polling
- SSE streaming
- a clean foundation for future persistence to JSONL or SQLite

### 4. Two connection modes

- `connect`
  - Default mode
  - Attaches to an already running Antigravity LS
  - Best fit when the user is already inside Antigravity / VS Code
- `launch`
  - Optional advanced mode
  - Starts an independent LS through `antigravity-client`
  - Useful for headless experiments, but has more environment assumptions

For the first iteration, the bridge defaults to `connect`.

## Runtime Components

### `BridgeRuntime`

Owns long-lived clients and session registry.

Responsibilities:

- reuse a compatible `AntigravityClient` where possible
- create new cascade sessions
- resume persisted sessions by re-attaching stored cascades
- list/get sessions
- expose runtime health

### `BridgeSession`

Wraps one Antigravity cascade and translates LS events into normalized bridge events.

Responsibilities:

- send messages
- cancel current execution
- track latest text/thinking/status
- track unresolved approvals
- emit normalized bridge events

### HTTP Server

Owns the local automation surface.

Responsibilities:

- create/list/get sessions
- send messages
- approve steps
- stream events over SSE
- return JSON snapshots for polling clients

### CLI

A thin command-line wrapper over the local HTTP server.

Responsibilities:

- start the bridge server
- create sessions
- send messages
- stream output
- inspect status

## Data Flow

### Session creation

1. Client calls `POST /sessions`
2. `BridgeRuntime` resolves or creates an `AntigravityClient`
3. Runtime starts a new cascade
4. Runtime chooses a bridge `sessionId` from the caller-provided value or generates one automatically
5. `BridgeSession` subscribes to cascade events
6. Session is returned with `sessionId` and `cascadeId`

### Session resume

1. Client calls `POST /sessions/:id/resume`
2. Runtime looks up the persisted bridge session snapshot
3. Runtime re-attaches the stored `cascadeId`
4. The resumed session keeps the original bridge `sessionId` when possible

### Sending a message

1. Client calls `POST /sessions/:id/messages`
2. `BridgeSession.sendMessage()` calls `cascade.sendMessage()`
3. LS reactive stream emits updates
4. Session normalizes them into bridge events
5. Polling clients read `/events`; live clients read `/stream`

### Approvals

1. LS emits `approval:needed`
2. Session records a pending approval
3. Client calls `POST /sessions/:id/approvals/:stepIndex/approve`
4. Session invokes the underlying approval handler from `antigravity-client`
5. Pending approval is cleared and an approval resolution event is emitted

## Event Model

All runtime events share one envelope:

```json
{
  "seq": 12,
  "sessionId": "sess_abc",
  "cascadeId": "cascade_xyz",
  "timestamp": "2026-03-28T07:12:00.000Z",
  "type": "cascade.text.delta",
  "data": {
    "delta": "hello",
    "fullText": "hello world",
    "stepIndex": 3
  }
}
```

Current event types:

- `session.created`
- `message.sent`
- `cascade.status`
- `cascade.step.new`
- `cascade.step.updated`
- `cascade.text.delta`
- `cascade.thinking.delta`
- `cascade.command.output`
- `cascade.approval.needed`
- `cascade.approval.resolved`
- `cascade.done`
- `cascade.error`
- `session.cancel.requested`

## Current Tradeoffs

### What is stable now

- message sending
- streaming visible step data
- complete step detail in `cascade.step.new` / `cascade.step.updated`, including summarized fields, step payload, and protobuf-style raw JSON
- cancellation
- approval handling for exposed interactions
- connect mode against an already running Antigravity LS

### What is not guaranteed

- protobuf schema compatibility across future Antigravity releases
- independent `launch` mode on non-macOS systems
- long-term backward compatibility of unofficial LS RPCs

## Near-term Roadmap

- persist sessions to JSONL
- add WebSocket streaming as an alternative to SSE
- add resumable sessions by cascade id
- add artifact and history endpoints
