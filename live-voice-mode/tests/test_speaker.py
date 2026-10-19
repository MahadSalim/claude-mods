"""Speaker queueing, stops and playback with a fake Kokoro: no models, no audio."""

import os
import sys
import time
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))

import numpy as np

from live_voice import events
from live_voice.speaker import Speaker

SOUNDS = {"a.": 0.1, "b.": 0.2, "c.": 0.3}


class Kokoro:
    """Each text as 0.1 s of a level of its own, made in `delay` seconds."""

    delay = 0.0

    def __init__(self, *paths):
        pass

    def create(self, text, **options):
        time.sleep(self.delay)
        return np.full(2400, SOUNDS[text], dtype=np.float32), 24000



def play(speaker, seconds=3.0):
    """Pulls the speaker like the audio stream until it is idle, returning the level of each chunk."""
    chunks, deadline = [], time.monotonic() + seconds
    while time.monotonic() < deadline and (speaker.busy.is_set() or not speaker.lines.empty() or len(speaker.pending)):
        chunks.append(round(float(speaker.pull(480)[0]) / 32767, 1))
        time.sleep(0.01)
    return chunks


class Speaking(unittest.TestCase):
    def setUp(self):
        sys.modules["kokoro_onnx"] = types.SimpleNamespace(Kokoro=Kokoro)
        self.seen = []
        self.speaker = Speaker("")
        events.route = lambda event: self.seen.append((event["type"], self.speaker.client))

    def tearDown(self):
        events.route = None
        Kokoro.delay = 0.0

    def say(self, *lines):
        for text, client in lines:
            self.speaker.say(text, client)

    def test_a_session_hears_spoken_once_its_own_lines_end(self):
        self.say(("a.", "1"), ("b.", "1"), ("c.", "2"))
        play(self.speaker)
        self.assertEqual(self.seen, [("spoken", "1"), ("spoken", "2")])

    def test_a_sessions_next_line_plays_without_a_gap(self):
        Kokoro.delay = 0.05
        self.say(("a.", "1"), ("b.", "1"))
        self.assertEqual(list(np.trim_zeros(play(self.speaker))), [0.1] * 10 + [0.2] * 10)

    def test_a_session_stop_drops_only_its_own_lines(self):
        self.say(("a.", "1"), ("b.", "2"), ("c.", "1"))
        self.assertTrue(wait(lambda: len(self.speaker.pending)))
        self.speaker.stop("1")
        self.assertEqual(set(play(self.speaker)) - {0.0}, {0.2})
        self.assertEqual(self.seen, [("spoken", "2")])

    def test_a_stop_of_all_drops_every_line(self):
        self.say(("a.", "1"), ("b.", "2"))
        self.assertTrue(wait(lambda: len(self.speaker.pending)))
        self.speaker.stop()
        self.assertEqual(set(play(self.speaker)), {0.0})

    def test_a_later_answer_drops_a_progress_line_not_yet_started(self):
        Kokoro.delay = 0.05
        self.speaker.say("a.", "1")
        self.speaker.narrate("b.", "1")
        self.speaker.say("c.", "1")
        self.assertEqual(set(play(self.speaker)) - {0.0}, {0.1, 0.3})


def wait(until, seconds=3.0):
    deadline = time.monotonic() + seconds
    while not until() and time.monotonic() < deadline:
        time.sleep(0.005)
    return until()


if __name__ == "__main__":
    unittest.main()
