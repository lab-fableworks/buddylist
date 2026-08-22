from __future__ import annotations

import asyncio
import uuid

import pytest

from buddylist import BuddyListError, Client, Message


@pytest.fixture(scope="session")
async def world(server: dict[str, str]) -> dict[str, str]:
    admin = Client(server["url"], server["admin_key"])
    a = await admin.api(
        "POST", "/agents", {"screen_name": "PyBot", "capabilities": {"skills": ["python"], "accepts": ["task.request"]}}
    )
    b = await admin.api("POST", "/agents", {"screen_name": "PyPeer", "capabilities": {"accepts": ["question"]}})
    await admin.api("POST", "/projects", {"slug": "atlas", "name": "Atlas"})
    for n in ("PyBot", "PyPeer"):
        await admin.api("POST", "/projects/atlas/members", {"screen_name": n})
    await admin.close()
    return {**server, "bot": a["api_key"], "peer": b["api_key"]}


async def test_rest_basics(world: dict[str, str]) -> None:
    c = Client(world["url"], world["bot"])
    me = await c.whoami()
    assert me["screen_name"] == "PyBot"
    assert me["capabilities"]["operator"] == "admin"
    groups = await c.buddies()
    assert groups[0]["name"] == "Project: Atlas"
    assert sorted(b["screen_name"] for b in groups[0]["buddies"]) == ["PyPeer", "admin"]
    d = await c.directory(accepts="question")
    assert [u["screen_name"] for u in d] == ["PyPeer"]
    await c.close()


async def test_errors_are_typed(world: dict[str, str]) -> None:
    c = Client(world["url"], "bl_bogus")
    with pytest.raises(BuddyListError) as ei:
        await c.whoami()
    assert ei.value.status == 401
    await c.close()
    c = Client(world["url"], world["bot"])
    with pytest.raises(BuddyListError) as ei:
        await c.im("PyPeer", payload_type="task.request", payload={"title": "no id"})
    assert ei.value.status == 400 and "task_id" in ei.value.message
    await c.close()


async def test_rooms_and_history(world: dict[str, str]) -> None:
    c = Client(world["url"], world["bot"])
    room = await c.room("atlas")
    assert room["name"] == "lobby"
    m1 = await c.send(room["id"], "hello from python")
    m2 = await c.send(room["id"], "again", reply_to=m1.id)
    assert m2.seq == m1.seq + 1 and m2.reply_to == m1.id
    hist = await c.history(room["id"], after=m1.seq)
    assert [m.body for m in hist] == ["again"]
    found = await c.search("python", project="atlas")
    assert len(found) == 1
    await c.close()


async def test_live_delivery_handlers_and_request(world: dict[str, str]) -> None:
    bot = Client(world["url"], world["bot"])
    peer = Client(world["url"], world["peer"])
    got: list[Message] = []
    presence: list[dict] = []

    @bot.on("text")
    async def on_text(m: Message) -> None:
        got.append(m)
        if m.body.startswith("hi"):
            await bot.reply(m, f"hey {m.sender}")

    @peer.on("presence")
    def on_presence(frame: dict) -> None:
        presence.append(frame["data"])

    @peer.on("question")
    async def on_q(m: Message) -> None:
        assert m.payload is not None
        await peer.reply(
            m, "42", payload_type="answer", payload={"question_id": m.payload["question_id"], "text": "42"}
        )

    await bot.connect()
    await peer.connect()

    # presence fan-out to project peer
    await bot.set_presence("away", "lunch")
    for _ in range(50):
        if any(p["screen_name"] == "PyBot" and p["presence"]["state"] == "away" for p in presence):
            break
        await asyncio.sleep(0.1)
    else:
        pytest.fail("peer never saw PyBot go away")

    # live IM delivery + handler reply
    await peer.im("PyBot", "hi there")
    for _ in range(50):
        if got:
            break
        await asyncio.sleep(0.1)
    assert got and got[0].sender == "PyPeer"

    # request/await correlated answer (peer answers via handler)
    ans = await bot.request(
        "PyPeer", payload_type="question", payload={"question_id": str(uuid.uuid4()), "text": "?"}, timeout=10
    )
    assert ans.payload_type == "answer" and ans.payload and ans.payload["text"] == "42"

    # request timeout is clean
    with pytest.raises(asyncio.TimeoutError):
        await bot.request(
            "PyPeer", payload_type="task.request", payload={"task_id": "never", "title": "ignored"}, timeout=0.5
        )

    await bot.close()
    await peer.close()


async def test_catch_up_after_reconnect(world: dict[str, str]) -> None:
    bot = Client(world["url"], world["bot"], reconnect=False)
    peer = Client(world["url"], world["peer"])
    seen: list[str] = []
    bot.on("text", lambda m: seen.append(m.body))
    await bot.connect()
    await asyncio.sleep(0.2)
    await bot.close()  # offline now
    await peer.im("PyBot", "you missed this")
    bot2 = Client(world["url"], world["bot"])
    bot2.on("text", lambda m: seen.append(m.body))
    # simulate a client that remembers where it left off
    bot2._last_seq = dict(bot._last_seq)
    await bot2._open()
    bot2.me = await bot2.whoami()
    bot2._spawn(bot2._read_loop())
    for _ in range(50):
        if "you missed this" in seen:
            break
        await asyncio.sleep(0.1)
    assert "you missed this" in seen
    await bot2.close()
    await peer.close()
