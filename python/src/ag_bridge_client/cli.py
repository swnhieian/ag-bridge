from __future__ import annotations

import argparse
import json
import sys

from .client import BridgeClient, BridgeClientError
from .interactive import execute_turn, open_chat, stream_session


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not hasattr(args, "handler"):
        parser.print_help()
        return

    client = BridgeClient(base_url=args.base_url)

    try:
        args.handler(client, args)
    except BridgeClientError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ag-bridge-py")
    parser.add_argument(
        "--base-url",
        default=None,
        help="AG Bridge base URL, defaults to AG_BRIDGE_URL or http://127.0.0.1:9464",
    )

    subparsers = parser.add_subparsers(dest="command")

    status_parser = subparsers.add_parser("status")
    status_parser.set_defaults(handler=run_status)

    models_parser = subparsers.add_parser("list-models", aliases=["model-list"])
    models_parser.add_argument("--workspace", default=None)
    models_parser.set_defaults(handler=run_list_models)

    ag_list_parser = subparsers.add_parser("ag:list", aliases=["ag-session-list"])
    ag_list_parser.add_argument("--workspace", default=None)
    ag_list_parser.set_defaults(handler=run_ag_list)

    ag_sync_parser = subparsers.add_parser("ag:sync", aliases=["ag-session-sync"])
    ag_sync_parser.add_argument("--workspace", default=None)
    ag_sync_parser.set_defaults(handler=run_ag_sync)

    ag_attach_parser = subparsers.add_parser("ag:attach", aliases=["ag-session-attach"])
    ag_attach_parser.add_argument("cascade_id")
    ag_attach_parser.add_argument("--workspace", default=None)
    ag_attach_parser.set_defaults(handler=run_ag_attach)

    ag_send_parser = subparsers.add_parser("ag:send", aliases=["ag-send"])
    ag_send_parser.add_argument("cascade_id")
    ag_send_parser.add_argument("text")
    ag_send_parser.add_argument("--workspace", default=None)
    ag_send_parser.add_argument("--model", default=None)
    ag_send_parser.set_defaults(handler=run_ag_send)

    create_parser = subparsers.add_parser("session:create", aliases=["session-create"])
    create_parser.add_argument("--mode", default="connect", choices=["connect", "launch"])
    create_parser.add_argument("--workspace", default=None)
    create_parser.add_argument("--model", default=None)
    create_parser.add_argument("--session-id", default=None)
    create_parser.set_defaults(handler=run_session_create)

    list_parser = subparsers.add_parser("session:list", aliases=["session-list"])
    list_parser.set_defaults(handler=run_session_list)

    get_parser = subparsers.add_parser("session:get", aliases=["session-get"])
    get_parser.add_argument("session_id")
    get_parser.set_defaults(handler=run_session_get)

    resume_parser = subparsers.add_parser("resume")
    resume_parser.add_argument("session_id", nargs="?")
    resume_parser.add_argument("--last", action="store_true")
    resume_parser.add_argument("--workspace", default=None)
    resume_parser.add_argument("--model", default=None)
    resume_parser.add_argument("--thinking", default="on", choices=["on", "off"])
    resume_parser.set_defaults(handler=run_resume)

    send_parser = subparsers.add_parser("send")
    send_parser.add_argument("session_id")
    send_parser.add_argument("text")
    send_parser.add_argument("--model", default=None)
    send_parser.add_argument("--workspace", default=None)
    send_parser.set_defaults(handler=run_send)

    events_parser = subparsers.add_parser("events")
    events_parser.add_argument("session_id")
    events_parser.add_argument("--since", type=int, default=0)
    events_parser.add_argument("--limit", type=int, default=None)
    events_parser.set_defaults(handler=run_events)

    stream_parser = subparsers.add_parser("stream")
    stream_parser.add_argument("session_id")
    stream_parser.add_argument("--since", type=int, default=None)
    stream_parser.add_argument("--thinking", default="on", choices=["on", "off"])
    stream_parser.add_argument("--workspace", default=None)
    stream_parser.set_defaults(handler=run_stream)

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("session_id")
    export_parser.set_defaults(handler=run_export)

    delete_parser = subparsers.add_parser("delete")
    delete_parser.add_argument("session_id")
    delete_parser.set_defaults(handler=run_delete)

    approve_parser = subparsers.add_parser("approve")
    approve_parser.add_argument("session_id")
    approve_parser.add_argument("step_index", type=int)
    approve_parser.add_argument("--scope", default="once", choices=["once", "conversation"])
    approve_parser.add_argument("--workspace", default=None)
    approve_parser.set_defaults(handler=run_approve)

    cancel_parser = subparsers.add_parser("cancel")
    cancel_parser.add_argument("session_id")
    cancel_parser.add_argument("--workspace", default=None)
    cancel_parser.set_defaults(handler=run_cancel)

    ask_parser = subparsers.add_parser("ask")
    ask_parser.add_argument("text")
    ask_parser.add_argument("--mode", default="connect", choices=["connect", "launch"])
    ask_parser.add_argument("--workspace", default=None)
    ask_parser.add_argument("--model", default=None)
    ask_parser.add_argument("--session", default=None)
    ask_parser.add_argument("--last", action="store_true")
    ask_parser.add_argument("--session-id", default=None)
    ask_parser.add_argument("--thinking", default="on", choices=["on", "off"])
    ask_parser.add_argument("--json", action="store_true")
    ask_parser.set_defaults(handler=run_ask)

    chat_parser = subparsers.add_parser("chat")
    chat_parser.add_argument("--session", default=None)
    chat_parser.add_argument("--last", action="store_true")
    chat_parser.add_argument("--session-id", default=None)
    chat_parser.add_argument("--workspace", default=None)
    chat_parser.add_argument("--thinking", default="on", choices=["on", "off"])
    chat_parser.add_argument("--model", default=None)
    chat_parser.set_defaults(handler=run_chat)

    return parser


def run_status(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json({"status": client.status(), "sessions": client.list_sessions()})


def run_list_models(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json({"models": client.list_models(workspace_path=args.workspace)})


def run_ag_list(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json({"sessions": client.list_ag_sessions(workspace_path=args.workspace)})


def run_ag_sync(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json(client.sync_ag_sessions(workspace_path=args.workspace))


def run_ag_attach(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json({"session": client.attach_ag_session(args.cascade_id, workspace_path=args.workspace)})


def run_ag_send(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json(
        client.send_to_ag_session(
            args.cascade_id,
            args.text,
            workspace_path=args.workspace,
            model=args.model,
        )
    )


def run_session_create(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json(
        {
            "session": client.create_session(
                mode=args.mode,
                workspace_path=args.workspace,
                model=args.model,
                session_id=args.session_id,
            )
        }
    )


def run_session_list(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json({"sessions": client.list_sessions()})


def run_session_get(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json({"session": client.get_session(args.session_id)})


def run_resume(client: BridgeClient, args: argparse.Namespace) -> None:
    session = resolve_session_selection(
        client,
        session_id=args.session_id,
        use_last=args.last or not args.session_id,
        workspace_path=args.workspace,
    )
    open_chat(
        client,
        session_id=str(session["id"]),
        workspace_path=args.workspace or _as_text(session.get("workspacePath")) or None,
        requested_model=args.model or _as_text(session.get("requestedModel")) or None,
        show_thinking=args.thinking != "off",
    )


def run_send(client: BridgeClient, args: argparse.Namespace) -> None:
    session = client.ensure_live_session(args.session_id, workspace_path=args.workspace)
    print_json(client.send_message(str(session["id"]), args.text, model=args.model))


def run_events(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json({"events": client.get_events(args.session_id, since=args.since, limit=args.limit)})


def run_stream(client: BridgeClient, args: argparse.Namespace) -> None:
    stream_session(
        client,
        args.session_id,
        since=args.since,
        show_thinking=args.thinking != "off",
        workspace_path=args.workspace,
    )


def run_export(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json(client.export_session(args.session_id))


def run_delete(client: BridgeClient, args: argparse.Namespace) -> None:
    print_json(client.delete_session(args.session_id))


def run_approve(client: BridgeClient, args: argparse.Namespace) -> None:
    session = client.ensure_live_session(args.session_id, workspace_path=args.workspace)
    print_json(client.approve(str(session["id"]), args.step_index, scope=args.scope))


def run_cancel(client: BridgeClient, args: argparse.Namespace) -> None:
    session = client.ensure_live_session(args.session_id, workspace_path=args.workspace)
    print_json(client.cancel(str(session["id"])))


def run_ask(client: BridgeClient, args: argparse.Namespace) -> None:
    ensure_session_flags_are_valid(args.session, args.last, args.session_id)

    if args.json:
        print_json(
            client.ask(
                args.text,
                mode=args.mode,
                workspace_path=args.workspace,
                model=args.model,
                session_id=args.session,
                use_last=args.last,
                create_session_id=args.session_id,
            )
        )
        return

    session = (
        resolve_session_selection(
            client,
            session_id=args.session,
            use_last=args.last,
            workspace_path=args.workspace,
        )
        if args.session or args.last
        else client.create_session(
            mode=args.mode,
            workspace_path=args.workspace,
            model=args.model,
            session_id=args.session_id,
        )
    )

    print(f"[session] {session['id']} cascade={session['cascadeId']}", file=sys.stderr)
    turn = execute_turn(
        client,
        str(session["id"]),
        args.text,
        requested_model=args.model or _as_text(session.get("requestedModel")) or None,
        show_thinking=args.thinking != "off",
        workspace_path=args.workspace,
    )
    if turn.state == "approval":
        print("Turn paused waiting for approval. Use approve <sessionId> <stepIndex> [--scope].")


def run_chat(client: BridgeClient, args: argparse.Namespace) -> None:
    ensure_session_flags_are_valid(args.session, args.last, args.session_id)
    if args.session or args.last:
        session = resolve_session_selection(
            client,
            session_id=args.session,
            use_last=args.last,
            workspace_path=args.workspace,
        )
    else:
        session = client.create_session(
            mode="connect",
            workspace_path=args.workspace,
            model=args.model,
            session_id=args.session_id,
        )

    open_chat(
        client,
        session_id=str(session["id"]),
        workspace_path=args.workspace or _as_text(session.get("workspacePath")) or None,
        requested_model=args.model or _as_text(session.get("requestedModel")) or None,
        show_thinking=args.thinking != "off",
    )


def resolve_session_selection(
    client: BridgeClient,
    *,
    session_id: str | None,
    use_last: bool,
    workspace_path: str | None,
) -> dict[str, object]:
    return client.resolve_session(
        session_id=session_id,
        use_last=use_last,
        workspace_path=workspace_path,
    )


def ensure_session_flags_are_valid(
    selected_session_id: str | None,
    use_last: bool,
    requested_session_id: str | None,
) -> None:
    if selected_session_id and use_last:
        raise BridgeClientError("Use either --session or --last, not both.")
    if selected_session_id and requested_session_id:
        raise BridgeClientError("Use either --session or --session-id, not both.")
    if use_last and requested_session_id:
        raise BridgeClientError("Use either --last or --session-id, not both.")


def _as_text(value: object) -> str:
    return value if isinstance(value, str) else ""


def print_json(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
