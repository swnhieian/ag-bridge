from __future__ import annotations

import argparse
import json
import sys

from .client import BridgeClient, BridgeClientError


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    client = BridgeClient(base_url=args.base_url)

    try:
        if args.command == "status":
            print_json({"status": client.status(), "sessions": client.list_sessions()})
            return

        if args.command == "session-list":
            print_json({"sessions": client.list_sessions()})
            return

        if args.command == "model-list":
            print_json({"models": client.list_models(workspace_path=args.workspace)})
            return

        if args.command == "ag-session-list":
            print_json({"sessions": client.list_ag_sessions(workspace_path=args.workspace)})
            return

        if args.command == "ag-session-sync":
            print_json(client.sync_ag_sessions(workspace_path=args.workspace))
            return

        if args.command == "ag-session-attach":
            print_json({"session": client.attach_ag_session(args.cascade_id, workspace_path=args.workspace)})
            return

        if args.command == "ag-send":
            print_json(
                client.send_to_ag_session(
                    args.cascade_id,
                    args.text,
                    workspace_path=args.workspace,
                    model=args.model,
                )
            )
            return

        if args.command == "session-create":
            print_json({"session": client.create_session(mode=args.mode, workspace_path=args.workspace, model=args.model)})
            return

        if args.command == "session-get":
            print_json({"session": client.get_session(args.session_id)})
            return

        if args.command == "send":
            print_json(client.send_message(args.session_id, args.text, model=args.model))
            return

        if args.command == "events":
            print_json({"events": client.get_events(args.session_id, since=args.since, limit=args.limit)})
            return

        if args.command == "export":
            print_json(client.export_session(args.session_id))
            return

        if args.command == "approve":
            print_json(client.approve(args.session_id, args.step_index, scope=args.scope))
            return

        if args.command == "cancel":
            print_json(client.cancel(args.session_id))
            return

        if args.command == "ask":
            print_json(client.ask(args.text, mode=args.mode, workspace_path=args.workspace, model=args.model))
            return

        parser.print_help()
    except BridgeClientError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ag-bridge-py")
    parser.add_argument("--base-url", default=None, help="AG Bridge base URL, defaults to AG_BRIDGE_URL or http://127.0.0.1:9464")

    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("status")
    subparsers.add_parser("session-list")

    model_list_parser = subparsers.add_parser("model-list")
    model_list_parser.add_argument("--workspace", default=None)

    ag_list_parser = subparsers.add_parser("ag-session-list")
    ag_list_parser.add_argument("--workspace", default=None)

    ag_sync_parser = subparsers.add_parser("ag-session-sync")
    ag_sync_parser.add_argument("--workspace", default=None)

    ag_attach_parser = subparsers.add_parser("ag-session-attach")
    ag_attach_parser.add_argument("cascade_id")
    ag_attach_parser.add_argument("--workspace", default=None)

    ag_send_parser = subparsers.add_parser("ag-send")
    ag_send_parser.add_argument("cascade_id")
    ag_send_parser.add_argument("text")
    ag_send_parser.add_argument("--workspace", default=None)
    ag_send_parser.add_argument("--model", default=None)

    create_parser = subparsers.add_parser("session-create")
    create_parser.add_argument("--mode", default="connect", choices=["connect", "launch"])
    create_parser.add_argument("--workspace", default=None)
    create_parser.add_argument("--model", default=None)

    get_parser = subparsers.add_parser("session-get")
    get_parser.add_argument("session_id")

    send_parser = subparsers.add_parser("send")
    send_parser.add_argument("session_id")
    send_parser.add_argument("text")
    send_parser.add_argument("--model", default=None)

    events_parser = subparsers.add_parser("events")
    events_parser.add_argument("session_id")
    events_parser.add_argument("--since", type=int, default=0)
    events_parser.add_argument("--limit", type=int, default=None)

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("session_id")

    approve_parser = subparsers.add_parser("approve")
    approve_parser.add_argument("session_id")
    approve_parser.add_argument("step_index", type=int)
    approve_parser.add_argument("--scope", default="once", choices=["once", "conversation"])

    cancel_parser = subparsers.add_parser("cancel")
    cancel_parser.add_argument("session_id")

    ask_parser = subparsers.add_parser("ask")
    ask_parser.add_argument("text")
    ask_parser.add_argument("--mode", default="connect", choices=["connect", "launch"])
    ask_parser.add_argument("--workspace", default=None)
    ask_parser.add_argument("--model", default=None)

    return parser


def print_json(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
