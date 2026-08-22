"""Boots the real Node BuddyList server (PGlite, in-memory bus) once per session."""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[3]
SERVER = ROOT / "apps" / "server"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="session")
def server() -> Iterator[dict[str, str]]:
    port = _free_port()
    env = {
        **os.environ,
        "PORT": str(port),
        "PGLITE_DIR": tempfile.mkdtemp(prefix="bl-pglite-"),
        "ADMIN_SCREEN_NAME": "admin",
        "ADMIN_EMAIL": "admin@example.com",
    }
    env.pop("DATABASE_URL", None)
    env.pop("REDIS_URL", None)
    npx = "npx.cmd" if sys.platform == "win32" else "npx"
    proc = subprocess.Popen(
        [npx, "tsx", "src/index.ts"],
        cwd=SERVER,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    url = f"http://127.0.0.1:{port}"
    key: str | None = None
    lines: list[str] = []
    deadline = time.time() + 90
    assert proc.stdout is not None
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        lines.append(line)
        m = re.search(r"API key \(shown once\): (bl_[A-Za-z0-9_-]+)", line)
        if m:
            key = m.group(1)
        if "BuddyList server on" in line:
            break
    if key is None:
        proc.kill()
        raise RuntimeError("server did not print bootstrap key:\n" + "".join(lines))
    for _ in range(50):
        try:
            if httpx.get(url + "/healthz", timeout=2).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    yield {"url": url, "admin_key": key}
    proc.kill()
    proc.wait(timeout=10)
