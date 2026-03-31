from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from typing import Any, Callable

from .client import BridgeClient, BridgeClientError

JsonDict = dict[str, Any]


@dataclass(slots=True)
class TurnResult:
    state: str
    session: JsonDict


def execute_turn(
    client: BridgeClient,
    session_id: str,
    text: str,
    *,
    requested_model: str | None = None,
    show_thinking: bool = True,
    workspace_path: str | None = None,
    poll_interval: float = 0.2,
) -> TurnResult:
    session = client.ensure_live_session(session_id, workspace_path=workspace_path)
    active_session_id = str(session["id"])
    since = int(session.get("eventCount", 0))
    client.send_message(active_session_id, text, model=requested_model)

    seen_assistant_step_text: dict[int, str] = {}
    seen_thinking_by_step: dict[int, str] = {}
    seen_stdout_by_step: dict[int, str] = {}
    seen_stderr_by_step: dict[int, str] = {}

    while True:
        events = client.get_events(active_session_id, since=since)
        if events:
            since = int(events[-1]["seq"])

        for event in events:
            event_type = str(event.get("type", ""))
            data = event.get("data", {})
            if not isinstance(data, dict):
                data = {}

            if event_type == "cascade.status":
                print(
                    f"[status] {data.get('previousStatus')} -> {data.get('status')}",
                    file=sys.stderr,
                )
                continue

            if event_type == "cascade.step.new":
                print(
                    f"[step] #{data.get('stepIndex')} {data.get('stepType')} {data.get('description')}",
                    file=sys.stderr,
                )
                continue

            if event_type == "cascade.step.updated":
                print(
                    f"[step:update] #{data.get('stepIndex')} {data.get('previousStatus')} -> {data.get('status')}",
                    file=sys.stderr,
                )
                continue

            if event_type == "cascade.text.delta":
                _write_delta(
                    store=seen_assistant_step_text,
                    step_index=_step_index(data),
                    current_text=_as_text(data.get("fullText")),
                    fallback_delta=_as_text(data.get("delta")),
                    out=sys.stdout,
                )
                continue

            if event_type == "cascade.thinking.delta":
                if show_thinking:
                    _write_delta(
                        store=seen_thinking_by_step,
                        step_index=_step_index(data),
                        current_text=_as_text(data.get("fullText")),
                        fallback_delta=_as_text(data.get("delta")),
                        out=sys.stderr,
                    )
                continue

            if event_type == "cascade.command.output":
                stream = _as_text(data.get("stream")) or "stdout"
                out = sys.stderr if stream == "stderr" else sys.stdout
                store = seen_stderr_by_step if stream == "stderr" else seen_stdout_by_step
                _write_delta(
                    store=store,
                    step_index=_step_index(data),
                    current_text=_as_text(data.get("fullText")),
                    fallback_delta=_as_text(data.get("delta")),
                    out=out,
                )
                continue

            if event_type == "cascade.approval.needed":
                print(
                    f"\n[approval] step={data.get('stepIndex')} type={data.get('approvalType')} {data.get('description')}",
                    file=sys.stderr,
                )
                session = client.get_session(active_session_id)
                return TurnResult(state="approval", session=session)

            if event_type == "cascade.error":
                print(f"\n[error] {data.get('message')}", file=sys.stderr)
                session = client.get_session(active_session_id)
                return TurnResult(state="error", session=session)

            if event_type == "cascade.done":
                print("", file=sys.stdout)
                session = client.get_session(active_session_id)
                return TurnResult(state="done", session=session)

        time.sleep(poll_interval)


def stream_session(
    client: BridgeClient,
    session_id: str,
    *,
    since: int | None = None,
    show_thinking: bool = True,
    workspace_path: str | None = None,
) -> None:
    session = client.ensure_live_session(session_id, workspace_path=workspace_path)
    active_session_id = str(session["id"])
    print(f"[ready] {session['id']} cascade={session['cascadeId']}", file=sys.stderr)

    for message in client.stream_events(active_session_id, since=since):
        if message.event != "event":
            continue
        event = message.data
        event_type = _as_text(event.get("type"))
        data = event.get("data", {})
        if not isinstance(data, dict):
            data = {}

        if event_type == "cascade.thinking.delta":
            if show_thinking:
                sys.stderr.write(_as_text(data.get("delta")))
                sys.stderr.flush()
            continue

        if event_type == "cascade.text.delta":
            sys.stdout.write(_as_text(data.get("delta")))
            sys.stdout.flush()
            continue

        if event_type == "cascade.command.output":
            out = sys.stderr if _as_text(data.get("stream")) == "stderr" else sys.stdout
            out.write(_as_text(data.get("delta")))
            out.flush()
            continue

        if event_type == "cascade.status":
            print(f"[status] {data.get('previousStatus')} -> {data.get('status')}", file=sys.stderr)
            continue

        if event_type == "cascade.step.new":
            print(
                f"[step] #{data.get('stepIndex')} {data.get('stepType')} {data.get('description')}",
                file=sys.stderr,
            )
            continue

        if event_type == "cascade.step.updated":
            print(
                f"[step:update] #{data.get('stepIndex')} {data.get('previousStatus')} -> {data.get('status')}",
                file=sys.stderr,
            )
            continue

        if event_type == "cascade.approval.needed":
            print(
                f"\n[approval] step={data.get('stepIndex')} type={data.get('approvalType')} {data.get('description')}",
                file=sys.stderr,
            )
            continue

        if event_type == "cascade.done":
            print("", file=sys.stdout)
            break

        if event_type == "cascade.error":
            print(f"\n[error] {data.get('message')}", file=sys.stderr)
            break


def open_chat(
    client: BridgeClient,
    *,
    session_id: str,
    workspace_path: str | None = None,
    requested_model: str | None = None,
    show_thinking: bool = True,
) -> None:
    current_session = client.ensure_live_session(session_id, workspace_path=workspace_path)
    current_session_id = str(current_session["id"])
    current_workspace = workspace_path or _as_text(current_session.get("workspacePath")) or None
    current_model = requested_model or _as_text(current_session.get("requestedModel")) or None

    print("Interactive chat ready. Type /help for commands.")
    print(f"Current session: {current_session_id}")

    while True:
        try:
            answer = input(f"ag:{_short_session_id(current_session_id)}> ").strip()
        except EOFError:
            print("")
            return

        if not answer:
            continue

        if answer.startswith("/"):
            result = _handle_slash_command(
                client,
                answer,
                current_session_id=current_session_id,
                current_workspace=current_workspace,
                current_model=current_model,
                show_thinking=show_thinking,
            )
            if result["exit"]:
                return
            current_session_id = result["session_id"]
            current_workspace = result["workspace_path"]
            current_model = result["requested_model"]
            show_thinking = result["show_thinking"]
            continue

        turn = execute_turn(
            client,
            current_session_id,
            answer,
            requested_model=current_model,
            show_thinking=show_thinking,
            workspace_path=current_workspace,
        )
        current_session_id = str(turn.session["id"])
        if turn.state == "approval":
            print("Turn paused waiting for approval. Use /approve <stepIndex> [scope].")


def _handle_slash_command(
    client: BridgeClient,
    answer: str,
    *,
    current_session_id: str,
    current_workspace: str | None,
    current_model: str | None,
    show_thinking: bool,
) -> dict[str, Any]:
    parts = answer[1:].split()
    command = parts[0] if parts else ""
    rest = parts[1:]

    if command == "help":
        print(_chat_help(), end="")
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "new":
        mode = "launch" if len(rest) > 0 and rest[0] == "launch" else "connect"
        workspace = rest[1] if len(rest) > 1 else current_workspace
        requested_model = rest[2] if len(rest) > 2 else current_model
        requested_session_id = rest[3] if len(rest) > 3 else None
        session = client.create_session(
            mode=mode,
            workspace_path=workspace,
            model=requested_model,
            session_id=requested_session_id,
        )
        print(f"Switched to {session['id']}")
        return _chat_state(str(session["id"]), workspace, requested_model, show_thinking)

    if command == "use":
        session_id = _require_arg(rest[0] if rest else None, "session id")
        session = client.resolve_session(
            session_id=session_id,
            workspace_path=current_workspace,
            create_if_missing=True,
            model=current_model,
        )
        print(f"Switched to {session['id']}")
        return _chat_state(
            str(session["id"]),
            _as_text(session.get("workspacePath")) or current_workspace,
            _as_text(session.get("requestedModel")) or current_model,
            show_thinking,
        )

    if command == "resume":
        use_last = len(rest) == 0 or rest[0] == "last"
        session = client.resolve_session(
            session_id=None if use_last else rest[0],
            use_last=use_last,
            workspace_path=current_workspace,
        )
        print(f"Switched to {session['id']}")
        return _chat_state(
            str(session["id"]),
            _as_text(session.get("workspacePath")) or current_workspace,
            _as_text(session.get("requestedModel")) or current_model,
            show_thinking,
        )

    if command == "sessions":
        _print_json({"sessions": client.list_sessions()})
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "ag-sessions":
        _print_json({"sessions": client.list_ag_sessions(workspace_path=current_workspace)})
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "sync":
        _print_json(client.sync_ag_sessions(workspace_path=current_workspace))
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "attach":
        cascade_id = _require_arg(rest[0] if rest else None, "cascade id")
        session = client.attach_ag_session(cascade_id, workspace_path=current_workspace)
        print(f"Attached {session['id']}")
        return _chat_state(
            str(session["id"]),
            _as_text(session.get("workspacePath")) or current_workspace,
            _as_text(session.get("requestedModel")) or current_model,
            show_thinking,
        )

    if command == "status":
        _print_json({"status": client.status(), "sessions": client.list_sessions()})
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "events":
        limit = int(rest[0]) if rest else 20
        _print_json({"events": client.get_events(current_session_id, limit=limit)})
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "export":
        _print_json(client.export_session(current_session_id))
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "approve":
        step_index = int(_require_arg(rest[0] if rest else None, "step index"))
        scope = rest[1] if len(rest) > 1 and rest[1] == "conversation" else "once"
        _print_json(client.approve(current_session_id, step_index, scope=scope))
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "cancel":
        _print_json(client.cancel(current_session_id))
        return _chat_state(current_session_id, current_workspace, current_model, show_thinking)

    if command == "thinking":
        next_show_thinking = False if rest and rest[0] == "off" else True
        print("Thinking output hidden." if not next_show_thinking else "Thinking output enabled.")
        return _chat_state(current_session_id, current_workspace, current_model, next_show_thinking)

    if command in {"quit", "exit"}:
        return {
            "exit": True,
            "session_id": current_session_id,
            "workspace_path": current_workspace,
            "requested_model": current_model,
            "show_thinking": show_thinking,
        }

    print(f"Unknown command: /{command}")
    print(_chat_help(), end="")
    return _chat_state(current_session_id, current_workspace, current_model, show_thinking)


def _chat_help() -> str:
    return (
        "/help\n"
        "/new [connect|launch] [workspacePath] [model] [sessionId]\n"
        "/use <sessionId>\n"
        "/resume [sessionId|last]\n"
        "/sessions\n"
        "/ag-sessions\n"
        "/sync\n"
        "/attach <cascadeId>\n"
        "/status\n"
        "/events [limit]\n"
        "/export\n"
        "/approve <stepIndex> [once|conversation]\n"
        "/cancel\n"
        "/thinking on|off\n"
        "/quit\n"
    )


def _chat_state(
    session_id: str,
    workspace_path: str | None,
    requested_model: str | None,
    show_thinking: bool,
) -> dict[str, Any]:
    return {
        "exit": False,
        "session_id": session_id,
        "workspace_path": workspace_path,
        "requested_model": requested_model,
        "show_thinking": show_thinking,
    }


def _write_delta(
    *,
    store: dict[int, str],
    step_index: int,
    current_text: str,
    fallback_delta: str,
    out: Any,
) -> None:
    previous = store.get(step_index, "")
    if current_text and current_text.startswith(previous):
        delta = current_text[len(previous) :]
        store[step_index] = current_text
    else:
        delta = fallback_delta or current_text
        store[step_index] = current_text or (previous + delta)
    if delta:
        out.write(delta)
        out.flush()


def _short_session_id(session_id: str) -> str:
    return session_id if len(session_id) <= 8 else session_id[-8:]


def _step_index(data: JsonDict) -> int:
    step_index = data.get("stepIndex")
    return int(step_index) if isinstance(step_index, int) else -1


def _as_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _require_arg(value: str | None, label: str) -> str:
    if not value:
        raise BridgeClientError(f"Missing {label}")
    return value


def _print_json(payload: object) -> None:
    import json

    print(json.dumps(payload, ensure_ascii=False, indent=2))
