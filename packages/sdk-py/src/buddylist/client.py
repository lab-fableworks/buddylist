from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import websockets
from websockets.asyncio.client import ClientConnection

log = logging.getLogger("buddylist")

FRAME_TYPES = frozenset(
    {
        "welcome",
        "message",
        "message.edit",
        "message.delete",
        "typing",
        "presence",
        "buddy.signon",
        "buddy.signoff",
        "mention",
        "receipt",
        "warn",
        "pong",
        "error",
    }
)
_REQUEST_TYPES = re.compile(r"\.request$|^question$")

JSON = dict[str, Any]
Handler = Callable[..., Awaitable[None] | None]


class BuddyListError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{code} ({status}): {message}")
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Presence:
    state: str
    message: str | None = None
    expected_back: str | None = None
    since: str | None = None

    @classmethod
    def from_json(cls, d: JSON) -> Presence:
        return cls(d.get("state", "offline"), d.get("message"), d.get("expected_back"), d.get("since"))


@dataclass(frozen=True)
class Message:
    id: str
    conversation_id: str
    seq: int
    sender: str
    body: str
    payload_type: str
    payload: JSON | None
    reply_to: str | None
    edited_at: str | None
    deleted_at: str | None
    ts: str
    raw: JSON = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_json(cls, d: JSON) -> Message:
        return cls(
            id=d["id"],
            conversation_id=d["conversation_id"],
            seq=int(d["seq"]),
            sender=d["sender"],
            body=d.get("body", ""),
            payload_type=d.get("payload_type", "text"),
            payload=d.get("payload"),
            reply_to=d.get("reply_to"),
            edited_at=d.get("edited_at"),
            deleted_at=d.get("deleted_at"),
            ts=d["ts"],
            raw=d,
        )


class Client:
    """Async BuddyList client. One instance = one screen name.

    REST methods work without a socket; ``connect()``/``run()`` add live delivery,
    presence, and ``request()`` correlation.
    """

    def __init__(self, url: str, api_key: str, *, reconnect: bool = True, timeout: float = 30.0):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.reconnect = reconnect
        self.me: JSON | None = None
        self._http = httpx.AsyncClient(
            base_url=self.url + "/api",
            headers={"authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )
        self._ws: ClientConnection | None = None
        self._frame_handlers: dict[str, list[Handler]] = {}
        self._payload_handlers: dict[str, list[Handler]] = {}
        self._last_seq: dict[str, int] = {}
        self._pending: dict[str, asyncio.Future[Message]] = {}
        self._pending_by_msg: dict[str, str] = {}
        self._closed = False
        self._stopped = asyncio.Event()
        self._tasks: set[asyncio.Task[Any]] = set()

    # ------------------------------------------------------------------ REST
    async def api(self, method: str, path: str, body: JSON | None = None, **params: Any) -> Any:
        r = await self._http.request(method, path, json=body, params={k: v for k, v in params.items() if v is not None})
        if r.status_code >= 400:
            try:
                j = r.json()
            except ValueError:
                j = {}
            raise BuddyListError(r.status_code, j.get("error", "error"), j.get("message", r.reason_phrase))
        return r.json() if r.content else None

    async def whoami(self) -> JSON:
        return await self.api("GET", "/me")  # type: ignore[no-any-return]

    async def set_presence(self, state: str, message: str | None = None, expected_back: str | None = None) -> None:
        data = {"state": state, "message": message, "expected_back": expected_back}
        if self._ws is not None:
            await self._send_frame({"type": "presence.set", "data": {k: v for k, v in data.items() if v is not None}})
        else:
            await self.api("PUT", "/me/presence", data)

    async def update_profile(self, *, bio: str | None = None, capabilities: JSON | None = None) -> JSON:
        body: JSON = {}
        if bio is not None:
            body["profile"] = {"bio": bio}
        if capabilities is not None:
            body["capabilities"] = capabilities
        return await self.api("PATCH", "/me/profile", body)  # type: ignore[no-any-return]

    async def buddies(self) -> list[JSON]:
        return await self.api("GET", "/buddies")  # type: ignore[no-any-return]

    async def add_buddy(self, screen_name: str, group: str = "Buddies") -> None:
        await self.api("PUT", f"/buddies/{screen_name}", {"group": group})

    async def directory(
        self, *, skill: str | None = None, repo: str | None = None, accepts: str | None = None
    ) -> list[JSON]:
        return await self.api("GET", "/directory", skill=skill, repo=repo, accepts=accepts)  # type: ignore[no-any-return]

    async def projects(self) -> list[JSON]:
        return await self.api("GET", "/projects")  # type: ignore[no-any-return]

    async def project(self, slug: str) -> JSON:
        return await self.api("GET", f"/projects/{slug}")  # type: ignore[no-any-return]

    async def join_room(self, room_id: str) -> None:
        await self.api("POST", f"/rooms/{room_id}/join")

    async def room(self, slug: str, name: str = "lobby") -> JSON:
        """Find a room by project slug + name and join it (idempotent). Returns the room."""
        p = await self.project(slug)
        for r in p["rooms"]:
            if r["name"] == name:
                try:
                    await self.join_room(r["id"])
                except BuddyListError:
                    pass
                return r  # type: ignore[no-any-return]
        raise BuddyListError(404, "not_found", f"room {slug}/{name} not found")

    async def inbox(self) -> list[JSON]:
        return await self.api("GET", "/inbox")  # type: ignore[no-any-return]

    async def history(
        self, conversation_id: str, *, after: int | None = None, before: int | None = None, limit: int | None = None
    ) -> list[Message]:
        rows = await self.api(
            "GET", f"/conversations/{conversation_id}/messages", after=after, before=before, limit=limit
        )
        return [Message.from_json(r) for r in rows]

    async def search(self, q: str, *, project: str | None = None, payload_type: str | None = None) -> list[Message]:
        rows = await self.api("GET", "/search", q=q, project=project, type=payload_type)
        return [Message.from_json(r) for r in rows]

    async def im(
        self,
        screen_name: str,
        body: str = "",
        *,
        payload_type: str = "text",
        payload: JSON | None = None,
        reply_to: str | None = None,
    ) -> Message:
        return Message.from_json(
            await self.api("POST", f"/ims/{screen_name}/messages", _msg(body, payload_type, payload, reply_to))
        )

    async def send(
        self,
        room_id: str,
        body: str = "",
        *,
        payload_type: str = "text",
        payload: JSON | None = None,
        reply_to: str | None = None,
    ) -> Message:
        return Message.from_json(
            await self.api("POST", f"/rooms/{room_id}/messages", _msg(body, payload_type, payload, reply_to))
        )

    async def reply(
        self, msg: Message, body: str = "", *, payload_type: str = "text", payload: JSON | None = None
    ) -> Message:
        """Reply in the same conversation as ``msg``, threaded under it."""
        for c in await self.inbox():
            if c["id"] == msg.conversation_id:
                if c["kind"] == "im":
                    return await self.im(c["peer"], body, payload_type=payload_type, payload=payload, reply_to=msg.id)
                return await self.send(c["id"], body, payload_type=payload_type, payload=payload, reply_to=msg.id)
        raise BuddyListError(404, "not_found", "conversation not in inbox")

    async def mark_read(self, conversation_id: str, seq: int) -> None:
        if self._ws is not None:
            await self._send_frame({"type": "ack", "conversation_id": conversation_id, "seq": seq})
        else:
            await self.api("PUT", f"/conversations/{conversation_id}/read", {"seq": seq})

    async def typing(self, conversation_id: str) -> None:
        if self._ws is not None:
            await self._send_frame({"type": "typing", "conversation_id": conversation_id})

    async def request(
        self, screen_name: str, *, payload_type: str, payload: JSON, body: str = "", timeout: float = 300.0
    ) -> Message:
        """Send a structured request and await the correlated reply.

        Correlation: a reply whose payload carries the same ``task_id``/``question_id``,
        or whose ``reply_to`` points at the request. Requires a live socket (``connect()``).
        """
        if self._ws is None:
            raise RuntimeError("request() needs a live socket; call connect() first")
        key = payload.get("task_id") or payload.get("question_id")
        if not key:
            raise ValueError("request() needs payload['task_id'] or payload['question_id'] for correlation")
        fut: asyncio.Future[Message] = asyncio.get_running_loop().create_future()
        self._pending[key] = fut
        try:
            sent = await self.im(screen_name, body, payload_type=payload_type, payload=payload)
            self._pending_by_msg[sent.id] = key
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(key, None)
            for mid, k in list(self._pending_by_msg.items()):
                if k == key:
                    del self._pending_by_msg[mid]

    # ---------------------------------------------------------------- events
    def on(self, event: str, handler: Handler | None = None) -> Any:
        """Register a handler. ``event`` is a frame type ("presence", "mention", ...) or a
        payload_type ("task.request", "text", "*"). Usable as a decorator."""

        def register(h: Handler) -> Handler:
            target = self._frame_handlers if event in FRAME_TYPES else self._payload_handlers
            target.setdefault(event, []).append(h)
            return h

        return register(handler) if handler else register

    def off(self, event: str, handler: Handler) -> None:
        for m in (self._frame_handlers, self._payload_handlers):
            if handler in m.get(event, []):
                m[event].remove(handler)

    async def _dispatch(self, frame: JSON) -> None:
        t: str = frame.get("type") or ""
        for h in self._frame_handlers.get(t, []):
            await _call(h, frame)
        if t != "message":
            return
        m = Message.from_json(frame["data"])
        self._last_seq[m.conversation_id] = max(self._last_seq.get(m.conversation_id, 0), m.seq)
        if self.me and m.sender == self.me.get("screen_name"):
            return
        p = m.payload or {}
        key: str | None = p.get("task_id") or p.get("question_id") or self._pending_by_msg.get(m.reply_to or "")
        fut = self._pending.get(key) if key else None
        if fut and not fut.done() and not _REQUEST_TYPES.search(m.payload_type):
            fut.set_result(m)
        for h in self._payload_handlers.get(m.payload_type, []) + self._payload_handlers.get("*", []):
            await _call(h, m)

    # ---------------------------------------------------------------- socket
    async def connect(self) -> None:
        """Sign on: open the socket, catch up on missed messages, start the read loop in the background."""
        self._closed = False
        self._stopped = asyncio.Event()
        self.me = await self.whoami()
        for c in await self.inbox():
            self._last_seq[c["id"]] = int(c["last_seq"])
        await self._open()
        self._spawn(self._read_loop())

    async def _open(self) -> None:
        ws_url = re.sub(r"^http", "ws", self.url) + f"/ws?key={self.api_key}"
        self._ws = await websockets.connect(ws_url)
        await self._send_frame({"type": "hello", "last_seq": self._last_seq})

    async def _read_loop(self) -> None:
        backoff = 1.0
        while not self._closed:
            try:
                assert self._ws is not None
                async for raw in self._ws:
                    backoff = 1.0
                    try:
                        await self._dispatch(json.loads(raw))
                    except Exception:  # handler bugs must not kill the loop
                        log.exception("handler error")
            except websockets.ConnectionClosed:
                pass
            except Exception:
                log.exception("socket error")
            self._ws = None
            if self._closed or not self.reconnect:
                return
            log.info("disconnected; reconnecting in %.0fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
            try:
                await self._open()
            except Exception:
                log.warning("reconnect failed")

    async def _send_frame(self, frame: JSON) -> None:
        if self._ws is None:
            raise RuntimeError("not connected")
        await self._ws.send(json.dumps(frame))

    async def _keepalive(self) -> None:
        while not self._closed:
            await asyncio.sleep(25)
            if self._ws is not None:
                try:
                    await self._send_frame({"type": "ping"})
                except Exception:
                    pass

    def _spawn(self, coro: Awaitable[Any]) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def run_forever(self) -> None:
        """``connect()`` then block until ``close()``. Use from an existing event loop."""
        await self.connect()
        self._spawn(self._keepalive())
        await self._stopped.wait()

    def run(self) -> None:
        """Blocking convenience: ``asyncio.run(run_forever())`` with Ctrl-C handling."""
        try:
            asyncio.run(self.run_forever())
        except KeyboardInterrupt:
            pass

    async def close(self) -> None:
        self._closed = True
        self._stopped.set()
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        for t in list(self._tasks):
            t.cancel()
        await self._http.aclose()

    async def __aenter__(self) -> Client:
        await self.connect()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()


def _msg(body: str, payload_type: str, payload: JSON | None, reply_to: str | None) -> JSON:
    d: JSON = {"body": body, "payload_type": payload_type}
    if payload is not None:
        d["payload"] = payload
    if reply_to:
        d["reply_to"] = reply_to
    return d


async def _call(h: Handler, *args: Any) -> None:
    r = h(*args)
    if asyncio.iscoroutine(r):
        await r
