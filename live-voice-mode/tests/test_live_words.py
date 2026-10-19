"""Live words with a fake transcriber: partial events, their end, and whether they read as finished."""

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))

import numpy as np

from live_voice import events
from live_voice.config import FRAME
from live_voice.live_words import LiveWords


class Transcriber:
    """Reads `text` for any audio, once `go` is set, noting each pass started in `started`."""

    def __init__(self, text):
        self.text = text
        self.go = threading.Event()
        self.go.set()
        self.started = threading.Event()

    def partial(self, audio):
        self.started.set()
        self.go.wait()
        return self.text


def wait(until, seconds=3.0):
    deadline = time.monotonic() + seconds
    while not until() and time.monotonic() < deadline:
        time.sleep(0.005)
    return until()


class Words(unittest.TestCase):
    def setUp(self):
        self.seen = []
        events.route = self.seen.append

    def tearDown(self):
        events.route = None

    def heard(self, text, frames=3):
        words = LiveWords(Transcriber(text))
        for _ in range(frames):
            words.add(np.zeros(FRAME, np.float32))
        self.assertTrue(wait(lambda: words.heard[0] == frames))
        return words

    def test_words_read_as_finished_only_at_a_sentence_end_covering_every_frame(self):
        for text, done in (
            ("Fix the bug.", True),
            ("What is it for?", True),
            ("Fix the bug,", False),
            ("Fix the bug and.", False),
            ("Fix the...", False),
            ("Fix the…", False),
        ):
            self.assertEqual(self.heard(text).finished(3), done, text)
        self.assertFalse(self.heard("Fix the bug.").finished(4))

    def test_no_partial_comes_once_its_utterance_ended(self):
        transcriber = Transcriber("hello")
        transcriber.go.clear()
        words = LiveWords(transcriber)
        words.add(np.zeros(FRAME, np.float32))
        self.assertTrue(transcriber.started.wait(3))
        words.end()
        transcriber.go.set()
        time.sleep(0.05)
        self.assertEqual((self.seen, words.finished(0)), ([], False))


if __name__ == "__main__":
    unittest.main()
