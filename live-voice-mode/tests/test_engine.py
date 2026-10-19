"""Engine routing, the single-instance lock, the relay and per-session `spoken`, with fakes: no models, no audio."""

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

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))

import numpy as np

import relay
from engine import Engine, hold
from live_voice import events
from live_voice.server import serve


class FakeSpeaker:
    def __init__(self):
        self.client = None
        self.said = []
        self.stops = 0
        self.busy = threading.Event()

    def say(self, text, client=None):
        self.said.append((text, client))

    narrate = say

    def stop(self):
        self.stops += 1


def fresh():
    """Points the relay at a new, empty state file folder."""
    relay.ENGINE_STATE = os.path.join(tempfile.mkdtemp(), "engine.json")


def started():
    """An engine with fake models loaded, its server up and its port in the state file, and the handlers of its event streams."""
    engine = Engine()
    engine.speaker, engine.device = FakeSpeaker(), "cpu"
    handlers = []
    engine.port = serve(engine.routes, lambda handler: (handlers.append(handler), engine.join(handler)))
    with open(relay.ENGINE_STATE, "w") as file:
        json.dump({"port": engine.port, "pid": os.getpid()}, file)
    return engine, handlers


def joined():
    """A session's event stream on the current engine, and its client id from `ready`."""
    lines = relay.attach()
    event = json.loads(lines.readline())
    return lines, event["client"]


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


class Routing(unittest.TestCase):
    def setUp(self):
        fresh()

    def tearDown(self):
        events.route = None

    def test_the_microphone_goes_to_one_session_and_speech_to_its_own(self):
        engine, _ = started()
        events.route = engine.route
        (a, first), (b, second) = joined(), joined()

        post(engine, first, "/unmute")
        self.assertEqual((engine.owner, engine.muted.is_set()), (first, False))
        post(engine, second, "/unmute")
        self.assertEqual(next_event(a), {"type": "taken"})
        self.assertEqual((engine.owner, list(engine.requests.queue)), (second, ["cancel"]))

        post(engine, first, "/mute")
        self.assertEqual((engine.owner, engine.muted.is_set()), (second, False))

        post(engine, first, "/speak", "hello")
        self.assertEqual(engine.speaker.said, [("hello", first)])
        engine.speaker.client = first
        events.emit("speech")
        events.emit("level", mic=0.1, out=0.2)
        events.emit("spoken")
        self.assertEqual([next_event(b), next_event(b)], [{"type": "speech"}, {"type": "level", "mic": 0.1, "out": 0.0}])
        self.assertEqual([next_event(a), next_event(a)], [{"type": "level", "mic": 0.0, "out": 0.2}, {"type": "spoken"}])

        b.close()
        self.assertTrue(settle(lambda: engine.owner is None and engine.muted.is_set()))
        self.assertTrue(engine.present.is_set())
        a.close()
        self.assertTrue(settle(lambda: not engine.present.is_set()))
        self.assertEqual(engine.speaker.stops, 1)

    def test_a_recording_frees_the_microphone_once_heard(self):
        engine, _ = started()
        events.route = engine.route
        (a, first), (b, second) = joined(), joined()

        post(engine, first, "/talk")
        post(engine, second, "/send")
        self.assertEqual(list(engine.requests.queue), ["talk"])
        post(engine, first, "/send")
        events.emit("heard", text="hi")
        self.assertEqual(next_event(a), {"type": "heard", "text": "hi"})
        self.assertEqual((engine.owner, list(engine.requests.queue)), (None, ["talk", "send"]))

        post(engine, second, "/talk")
        self.assertEqual(engine.owner, second)
        a.close(), b.close()


class SingleInstance(unittest.TestCase):
    def test_one_engine_holds_the_lock_and_a_dead_ones_is_free(self):
        path = os.path.join(tempfile.mkdtemp(), "engine.lock")
        sidecar = os.path.dirname(relay.__file__)
        subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {sidecar!r}); from engine import hold; assert hold({path!r}, 0)"], check=True)

        self.assertTrue(hold(path, 0))
        self.assertFalse(hold(path, 0.3))


class Relay(unittest.TestCase):
    def setUp(self):
        fresh()
        self.seen = []
        events.route = self.seen.append

    def tearDown(self):
        events.route = None

    def kinds(self):
        return [event["type"] for event in self.seen]

    def test_a_stale_state_file_starts_an_engine(self):
        with open(relay.ENGINE_STATE, "w") as file:
            json.dump({"port": 1, "pid": 0}, file)
        launched = []
        relay.start = lambda argv: (launched.append(argv), threading.Thread(target=started).start(), "popen")[-1]

        lines = relay.connect()
        self.assertEqual(json.loads(lines.readline())["type"], "ready")
        self.assertEqual([os.path.basename(path) for path in launched[0]], ["pythonw.exe", "engine.py"])
        self.assertEqual(len(launched), 1)
        lines.close()

    def test_the_relay_reconnects_after_a_restart_and_ends_when_the_engine_quits(self):
        _, old = started()
        relay.start = lambda argv: "popen"
        thread = threading.Thread(target=relay.main, daemon=True)
        thread.start()
        self.assertTrue(settle(lambda: self.kinds() == ["ready"]))

        engine, _ = started()
        old[0].connection.shutdown(socket.SHUT_RDWR)
        self.assertTrue(settle(lambda: self.kinds() == ["ready", "loading", "ready"]))

        engine.end("Voice engine quit; voice mode off.")
        thread.join(3)
        self.assertEqual((self.seen[-1], thread.is_alive()), ({"type": "end", "text": "Voice engine quit; voice mode off."}, False))


class Spoken(unittest.TestCase):
    def test_each_session_hears_spoken_once_its_own_lines_end(self):
        class Kokoro:
            def __init__(self, *paths):
                pass

            def create(self, text, **options):
                return np.full(2400, 0.1, dtype=np.float32), 24000

        sys.modules["kokoro_onnx"] = types.SimpleNamespace(Kokoro=Kokoro)
        from live_voice.speaker import Speaker

        seen = []
        speaker = Speaker("")
        events.route = lambda event: seen.append((event["type"], speaker.client))
        for text, client in (("a.", "1"), ("b.", "1"), ("c.", "2")):
            speaker.say(text, client)

        settle(lambda: speaker.pull(480) is not None and len(seen) == 2)
        self.assertEqual(seen, [("spoken", "1"), ("spoken", "2")])

    def tearDown(self):
        events.route = None


if __name__ == "__main__":
    unittest.main()
