from __future__ import annotations

from dataclasses import dataclass
import json
import os
import time
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

JsonDict = dict[str, Any]


class BridgeClientError(RuntimeError):
    """Raised when the AG Bridge HTTP API returns an error."""


@dataclass(slots=True)
class SseMessage:
    event: str
    data: JsonDict


class BridgeClient:
    def __init__(self, base_url: str | None = None, timeout: float = 60.0) -> None:
        self.base_url = (base_url or os.environ.get("AG_BRIDGE_URL") or "http://127.0.0.1:9464").rstrip("/")
        self.timeout = timeout

    def health(self) -> JsonDict:
        return self._request_json("GET", "/health")

    def status(self) -> JsonDict:
        return self._request_json("GET", "/status")

    def list_sessions(self) -> list[JsonDict]:
        payload = self._request_json("GET", "/sessions")
        return list(payload.get("sessions", []))

    def list_models(self, workspace_path: str | None = None) -> list[JsonDict]:
        query = _query_string({"workspacePath": workspace_path})
        payload = self._request_json("GET", f"/models{query}")
        return list(payload.get("models", []))

    def list_ag_sessions(self, workspace_path: str | None = None) -> list[JsonDict]:
        query = _query_string({"workspacePath": workspace_path})
        payload = self._request_json("GET", f"/ag-sessions{query}")
        return list(payload.get("sessions", []))

    def sync_ag_sessions(self, workspace_path: str | None = None) -> JsonDict:
        body: JsonDict = {}
        if workspace_path:
            body["workspacePath"] = workspace_path
        return self._request_json("POST", "/ag-sessions/sync", body)

    def attach_ag_session(self, cascade_id: str, workspace_path: str | None = None) -> JsonDict:
        body: JsonDict = {}
        if workspace_path:
            body["workspacePath"] = workspace_path
        payload = self._request_json("POST", f"/ag-sessions/{cascade_id}/attach", body)
        return dict(payload["session"])

    def send_to_ag_session(
        self,
        cascade_id: str,
        text: str,
        workspace_path: str | None = None,
        model: str | None = None,
    ) -> JsonDict:
        body: JsonDict = {"text": text}
        if workspace_path:
            body["workspacePath"] = workspace_path
        if model:
            body["model"] = model
        return self._request_json("POST", f"/ag-sessions/{cascade_id}/messages", body)

    def create_session(
        self,
        mode: str = "connect",
        workspace_path: str | None = None,
        model: str | None = None,
        session_id: str | None = None,
    ) -> JsonDict:
        body: JsonDict = {"mode": mode}
        if workspace_path:
            body["workspacePath"] = workspace_path
        if model:
            body["model"] = model
        if session_id:
            body["sessionId"] = session_id
        payload = self._request_json("POST", "/sessions", body)
        return dict(payload["session"])

    def get_session(self, session_id: str) -> JsonDict:
        payload = self._request_json("GET", f"/sessions/{session_id}")
        return dict(payload["session"])

    def get_session_if_exists(self, session_id: str) -> JsonDict | None:
        try:
            return self.get_session(session_id)
        except BridgeClientError as exc:
            if _is_session_not_found_error(exc):
                return None
            raise

    def get_last_session(self) -> JsonDict:
        sessions = self.list_sessions()
        if not sessions:
            raise BridgeClientError("No sessions available.")
        return dict(sessions[0])

    def resume_session(self, session_id: str, workspace_path: str | None = None) -> JsonDict:
        body: JsonDict = {}
        if workspace_path:
            body["workspacePath"] = workspace_path
        payload = self._request_json("POST", f"/sessions/{session_id}/resume", body)
        return dict(payload["session"])

    def ensure_live_session(self, session_id: str, workspace_path: str | None = None) -> JsonDict:
        session = self.get_session(session_id)
        if session.get("live"):
            return session
        return self.resume_session(session_id, workspace_path=workspace_path)

    def resolve_session(
        self,
        *,
        session_id: str | None = None,
        use_last: bool = False,
        workspace_path: str | None = None,
        create_if_missing: bool = False,
        mode: str = "connect",
        model: str | None = None,
    ) -> JsonDict:
        if session_id and use_last:
            raise BridgeClientError("Use either a session id or --last, not both.")
        if session_id:
            session = self.get_session_if_exists(session_id)
            if session is None:
                if not create_if_missing:
                    raise BridgeClientError(f"Session not found: {session_id}")
                session = self.create_session(
                    mode=mode,
                    workspace_path=workspace_path,
                    model=model,
                    session_id=session_id,
                )
        elif use_last:
            session = self.get_last_session()
        else:
            raise BridgeClientError("Missing session id. Pass a session id or use --last.")
        return self.ensure_live_session(str(session["id"]), workspace_path=workspace_path)

    def get_events(self, session_id: str, since: int = 0, limit: int | None = None) -> list[JsonDict]:
        query = _query_string({"since": since or None, "limit": limit})
        payload = self._request_json("GET", f"/sessions/{session_id}/events{query}")
        return list(payload.get("events", []))

    def export_session(self, session_id: str) -> JsonDict:
        return self._request_json("GET", f"/sessions/{session_id}/export")

    def send_message(self, session_id: str, text: str, model: str | None = None) -> JsonDict:
        body: JsonDict = {"text": text}
        if model:
            body["model"] = model
        return self._request_json("POST", f"/sessions/{session_id}/messages", body)

    def approve(self, session_id: str, step_index: int, scope: str = "once") -> JsonDict:
        return self._request_json(
            "POST",
            f"/sessions/{session_id}/approvals/{step_index}/approve",
            {"scope": scope},
        )

    def cancel(self, session_id: str) -> JsonDict:
        return self._request_json("POST", f"/sessions/{session_id}/cancel")

    def delete_session(self, session_id: str) -> JsonDict:
        return self._request_json("DELETE", f"/sessions/{session_id}")

    def stream_events(self, session_id: str, since: int | None = None) -> Iterator[SseMessage]:
        query = _query_string({"since": since})
        request = Request(
            f"{self.base_url}/sessions/{session_id}/stream{query}",
            headers={"Accept": "text/event-stream"},
            method="GET",
        )

        try:
            with urlopen(request, timeout=self.timeout) as response:
                event = "message"
                data_lines: list[str] = []
                for raw_line in response:
                    line = raw_line.decode("utf-8").rstrip("\n")
                    if not line:
                        if data_lines:
                            yield SseMessage(event=event, data=json.loads("\n".join(data_lines)))
                        event = "message"
                        data_lines = []
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        event = line[len("event:") :].strip()
                        continue
                    if line.startswith("data:"):
                        data_lines.append(line[len("data:") :].strip())
        except (HTTPError, URLError) as exc:
            raise BridgeClientError(str(exc)) from exc

    def ask(
        self,
        text: str,
        *,
        mode: str = "connect",
        workspace_path: str | None = None,
        model: str | None = None,
        session_id: str | None = None,
        use_last: bool = False,
        create_session_id: str | None = None,
        create_if_missing: bool = False,
        poll_interval: float = 0.5,
    ) -> JsonDict:
        if session_id and create_session_id:
            raise BridgeClientError("Use either an existing session or a new session-id, not both.")

        session = (
            self.resolve_session(
                session_id=session_id,
                use_last=use_last,
                workspace_path=workspace_path,
                create_if_missing=create_if_missing,
                mode=mode,
                model=model,
            )
            if session_id or use_last
            else self.create_session(
                mode=mode,
                workspace_path=workspace_path,
                model=model,
                session_id=create_session_id,
            )
        )
        active_session_id = str(session["id"])
        since = int(session.get("eventCount", 0))

        self.send_message(active_session_id, text, model=model)

        all_events: list[JsonDict] = []
        approval_required = False
        error_message: str | None = None

        while True:
            events = self.get_events(active_session_id, since=since)
            if events:
                all_events.extend(events)
                since = int(events[-1]["seq"])

            for event in events:
                event_type = str(event.get("type", ""))
                if event_type == "cascade.approval.needed":
                    approval_required = True
                    break
                if event_type == "cascade.error":
                    error_message = str(event.get("data", {}).get("message", "Unknown error"))
                    break
                if event_type == "cascade.done":
                    snapshot = self.get_session(active_session_id)
                    return {
                        "session": snapshot,
                        "events": all_events,
                        "text": snapshot.get("latestText", ""),
                        "thinking": snapshot.get("latestThinking", ""),
                        "approval_required": False,
                    }

            if approval_required:
                snapshot = self.get_session(active_session_id)
                return {
                    "session": snapshot,
                    "events": all_events,
                    "text": snapshot.get("latestText", ""),
                    "thinking": snapshot.get("latestThinking", ""),
                    "approval_required": True,
                }

            if error_message is not None:
                raise BridgeClientError(error_message)

            time.sleep(poll_interval)

    def _request_json(self, method: str, path: str, body: JsonDict | None = None) -> JsonDict:
        request = Request(
            f"{self.base_url}{path}",
            method=method,
            headers={"Content-Type": "application/json"},
            data=None if body is None else json.dumps(body).encode("utf-8"),
        )

        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8").strip()
        except HTTPError as exc:
            raw = exc.read().decode("utf-8").strip()
            message = _parse_error_message(raw) or f"HTTP {exc.code}"
            raise BridgeClientError(message) from exc
        except URLError as exc:
            raise BridgeClientError(str(exc)) from exc

        return json.loads(raw) if raw else {}


def _query_string(values: dict[str, Any]) -> str:
    filtered = {key: value for key, value in values.items() if value is not None}
    return f"?{urlencode(filtered)}" if filtered else ""


def _parse_error_message(raw: str) -> str | None:
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, str):
            return error
    return raw


def _is_session_not_found_error(error: BridgeClientError) -> bool:
    return str(error).startswith("Session not found: ")
