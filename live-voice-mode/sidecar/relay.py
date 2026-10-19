"""Live voice relay: one session's link to the shared voice engine, which it starts when none holds the engine's lock.

Writes the engine's JSON event lines on stdout; `loading` while it reconnects after the engine went away once ready, and `end` when the engine quits or does not start.
"""

import json
import os
import socket
import sys
import time

from live_voice.config import ENGINE_LOCK, ENGINE_STATE, START_SECONDS
from live_voice.events import emit
from live_voice.launch import free, start
from live_voice.server import MARK

ENGINE = [os.path.join(os.path.dirname(sys.executable), "pythonw.exe"), os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine.py")]


def attach():
    """The engine's event stream as a file of lines, or None when nothing answers with MARK on the state file's port."""
    try:
        with open(ENGINE_STATE) as file:
            port = json.load(file)["port"]
        conn = socket.create_connection(("127.0.0.1", port), timeout=5)
    except (OSError, ValueError, KeyError):
        return None

    with conn:
        lines = conn.makefile("rb")
        try:
            conn.sendall(b"GET /events HTTP/1.0\r\n\r\n")
            if MARK.encode() in list(iter(lambda: lines.readline().strip(), b"")):
                conn.settimeout(None)
                return lines
        except OSError:
            pass
        lines.close()


def connect():
    """Attaches to the engine holding ENGINE_LOCK, starting one once while no engine holds it, and waits up to START_SECONDS for it to answer."""
    deadline = time.monotonic() + START_SECONDS
    started = False

    while time.monotonic() < deadline:
        if not free(ENGINE_LOCK):
            if lines := attach():
                return lines
        elif not started:
            started = True
            emit("log", text=f"Voice engine started ({start(ENGINE)})")
        time.sleep(0.25)

    return None


def main():
    while lines := connect():
        ready = False

        try:
            for line in lines:
                event = json.loads(line)
                kind = event.pop("type")
                emit(kind, **event)
                if kind == "end":
                    return
                ready = ready or kind == "ready"
        except OSError:
            pass

        if not ready:
            break
        emit("loading")

    emit("end", text="Voice engine did not start; voice mode off.")


if __name__ == "__main__":
    main()
