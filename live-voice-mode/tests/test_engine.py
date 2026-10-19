"""Engine routing, its tray wake-ups, loading and failure, the log, the single-instance lock and the relay, with fakes: no models, no audio."""

import contextlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))

import relay
from engine import LOG_BYTES, Engine, Flag, journal
from live_voice import events
from live_voice.launch import free, hold
from live_voice.server import serve


class FakeSpeaker:
    def __init__(self, *_):
        self.client = None
        self.said = []
        self.stops = []
        self.busy = threading.Event()

    def say(self, text, client=None):
        self.said.append((text, client))

    narrate = say

    def stop(self, client=None):
        self.stops.append(client)


def started(loaded=True):
    """An engine holding the lock, its server up and its port in the state file, with fake models loaded unless not `loaded`, and the handlers of its event streams."""
    engine = Engine()
    engine.handle = hold(relay.ENGINE_LOCK, 0)
    if loaded:
        engine.speaker, engine.device = FakeSpeaker(), "cpu"
    handlers = []
    engine.port = serve(engine.routes, lambda handler: (handlers.append(handler), engine.join(handler)))
    with open(relay.ENGINE_STATE, "w") as file:
        json.dump({"port": engine.port, "pid": os.getpid()}, file)
    return engine, handlers


def joined():
    """A session's event stream on the current engine, and its client id from `ready`."""
    lines = relay.attach()
    return lines, next_event(lines)["client"]


def post(engine, client, path, body=""):
    request = urllib.request.Request(f"http://127.0.0.1:{engine.port}{path}", data=body.encode(), headers={"X-Client": client}, method="POST")
    urllib.request.urlopen(request).close()


def next_event(lines):
    return json.loads(lines.readline())


def settle(until, seconds=3.0):
    deadline = time.monotonic() + seconds
    while not until() and time.monotonic() < deadline:
        time.sleep(0.01)
    return until()


class Case(unittest.TestCase):
    """Points the relay at new, empty state and lock files, and restores `events.route` and `relay.start`."""

    def setUp(self):
        folder = tempfile.mkdtemp()
        self.enterContext(mock.patch.multiple(relay, ENGINE_STATE=os.path.join(folder, "engine.json"), ENGINE_LOCK=os.path.join(folder, "engine.lock"), start=relay.start))
        self.addCleanup(setattr, events, "route", None)


class Routing(Case):
    def test_the_microphone_goes_to_one_session_and_speech_to_its_own(self):
        engine, _ = started()
        events.route = engine.route
        (a, first), (b, second) = joined(), joined()

        post(engine, first, "/unmute")
        self.assertEqual((engine.owner, engine.muted.is_set()), (first, False))
        post(engine, second, "/unmute")
        self.assertEqual(next_event(a), {"type": "taken"})
        self.assertEqual((engine.owner, engine.muted.is_set(), list(engine.requests.queue)), (second, False, ["cancel"]))

        post(engine, first, "/mute")
        self.assertEqual((engine.owner, engine.muted.is_set()), (second, False))

        post(engine, first, "/speak", "hello")
        post(engine, first, "/stop")
        self.assertEqual((engine.speaker.said, engine.speaker.stops), ([("hello", first)], [first]))
        engine.speaker.client = first
        events.emit("speech")
        events.emit("level", mic=0.1, out=0.2)
        events.emit("spoken", lines=1)
        self.assertEqual([next_event(b), next_event(b)], [{"type": "speech"}, {"type": "level", "mic": 0.1, "out": 0.0}])
        self.assertEqual([next_event(a), next_event(a)], [{"type": "level", "mic": 0.0, "out": 0.2}, {"type": "spoken", "lines": 1}])

        b.close()
        self.assertTrue(settle(lambda: engine.owner is None and engine.muted.is_set()))
        self.assertEqual((list(engine.requests.queue), engine.present.is_set()), (["cancel", "cancel"], True))
        a.close()
        self.assertTrue(settle(lambda: not engine.present.is_set()))
        self.assertEqual((list(engine.requests.queue), engine.speaker.stops), ([], [first, second, first]))

    def test_a_recording_frees_the_microphone_once_heard_and_a_taken_one_is_dropped(self):
        engine, _ = started()
        events.route = engine.route
        (a, first), (b, second) = joined(), joined()

        post(engine, first, "/talk")
        post(engine, second, "/send")
        self.assertEqual(list(engine.requests.queue), ["talk"])
        events.emit("speech")
        post(engine, first, "/send")
        events.emit("heard", text="hi")
        self.assertEqual([next_event(a), next_event(a)], [{"type": "speech"}, {"type": "heard", "text": "hi"}])
        self.assertEqual((engine.owner, list(engine.requests.queue)), (None, ["talk", "send"]))

        post(engine, first, "/talk")
        events.emit("speech")
        post(engine, second, "/talk")
        events.emit("partial", text="late")
        events.emit("heard", text="late")
        self.assertEqual([next_event(a), next_event(a)], [{"type": "speech"}, {"type": "taken"}])
        self.assertEqual(engine.owner, second)

        events.emit("speech")
        events.emit("heard", text="mine")
        self.assertEqual([next_event(b), next_event(b)], [{"type": "speech"}, {"type": "heard", "text": "mine"}])
        self.assertIsNone(engine.owner)
        a.close(), b.close()

    def test_each_change_the_tray_shows_wakes_it(self):
        engine, _ = started()
        busy = engine.speaker.busy = Flag(engine.changed)

        def wakes(change):
            engine.changed.clear()
            change()
            return settle(engine.changed.is_set)

        session = []
        self.assertTrue(wakes(lambda: session.append(joined())))
        lines, client = session[0]
        self.assertTrue(wakes(lambda: post(engine, client, "/unmute")))
        self.assertEqual(engine.status(), "listening")
        self.assertTrue(wakes(busy.set))
        self.assertEqual(engine.status(), "speaking")
        self.assertTrue(wakes(busy.clear))
        self.assertTrue(wakes(lines.close))
        self.assertEqual(engine.status(), "ready")
        self.assertTrue(wakes(lambda: engine.finish("quit")))


class Lifetime(Case):
    def test_a_session_waiting_on_the_models_gets_ready_then_end_when_the_audio_fails(self):
        engine, _ = started(loaded=False)
        lines = relay.attach()
        self.assertEqual(engine.status(), "loading")

        def broken(*_):
            raise RuntimeError("no microphone")

        loaders = types.SimpleNamespace(listen=broken, VoiceDetector=lambda: None, LiveWords=lambda _: None, Speaker=FakeSpeaker, Transcriber=lambda _: types.SimpleNamespace(device="cpu"))
        modules = {f"live_voice.{name}": loaders for name in ("audio", "detector", "live_words", "speaker", "transcriber")}
        with mock.patch.dict(sys.modules, modules), contextlib.redirect_stderr(io.StringIO()):
            engine.run()

        self.assertEqual(next_event(lines), {"type": "ready", "port": engine.port, "device": "cpu", "client": "1"})
        self.assertEqual((next_event(lines), engine.ending), ({"type": "end", "text": "Voice engine failed: no microphone"}, "failed"))
        self.assertIsInstance(engine.speaker.busy, Flag)
        lines.close()

    def test_a_log_over_log_bytes_moves_aside_when_the_engine_starts(self):
        path = os.path.join(tempfile.mkdtemp(), "engine.log")
        for size, kept in ((10, "x" * 10), (LOG_BYTES + 1, "")):
            with open(path, "w") as file:
                file.write("x" * size)
            with journal(path) as log:
                log.write("y")
            with open(path) as file:
                self.assertEqual(file.read(), kept + "y")
        self.assertEqual(os.path.getsize(f"{path}.old"), LOG_BYTES + 1)

    def test_one_engine_holds_the_lock_and_a_dead_ones_is_free(self):
        path = relay.ENGINE_LOCK
        sidecar = os.path.dirname(relay.__file__)
        subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {sidecar!r}); from live_voice.launch import hold; assert hold({path!r}, 0) is not None"], check=True)

        self.assertTrue(free(path))
        self.assertIsNotNone(hold(path, 0))
        self.assertFalse(free(path))
        self.assertIsNone(hold(path, 0.2))


class Relay(Case):
    def setUp(self):
        super().setUp()
        self.seen, self.launched = [], []
        events.route = self.seen.append
        relay.start = lambda argv: self.launched.append(argv) or "popen"

    def kinds(self):
        return [event["type"] for event in self.seen]

    def test_a_stale_state_file_starts_one_engine(self):
        with open(relay.ENGINE_STATE, "w") as file:
            json.dump({"port": 1, "pid": 0}, file)
        relay.start = lambda argv: self.launched.append(argv) or threading.Timer(0.3, started).start() or "popen"

        lines = relay.connect()
        self.assertEqual(next_event(lines)["type"], "ready")
        self.assertEqual([[os.path.basename(path) for path in argv] for argv in self.launched], [["pythonw.exe", "engine.py"]])
        lines.close()

    def test_another_program_on_the_state_files_port_is_not_the_engine(self):
        class Other(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Other) as server:
            threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
            with open(relay.ENGINE_STATE, "w") as file:
                json.dump({"port": server.server_address[1], "pid": 0}, file)

            self.assertIsNone(relay.attach())
            server.shutdown()

    def test_the_relay_reconnects_after_a_restart_and_ends_when_the_engine_quits(self):
        first, old = started()
        thread = threading.Thread(target=relay.main, daemon=True)
        thread.start()
        self.assertTrue(settle(lambda: self.kinds() == ["ready"]))

        os.close(first.handle)
        engine, _ = started()
        old[0].connection.shutdown(socket.SHUT_RDWR)
        self.assertTrue(settle(lambda: self.kinds() == ["ready", "loading", "ready"]))
        self.assertEqual(self.launched, [])

        engine.end("Voice engine quit; voice mode off.")
        thread.join(3)
        self.assertEqual((self.seen[-1], thread.is_alive()), ({"type": "end", "text": "Voice engine quit; voice mode off."}, False))


if __name__ == "__main__":
    unittest.main()
