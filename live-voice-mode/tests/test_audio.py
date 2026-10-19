"""Utterance segmentation with fakes: frames whose first sample is their speech probability, no models, no audio."""

import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))

import numpy as np

from live_voice import events
from live_voice.audio import Segmenter
from live_voice.config import END_FRAMES, FRAME, MIN_FRAMES, PREROLL_FRAMES, START_FRAMES


class Fake:
    """The speaker, live words, detector and transcriber, recording what they are told."""

    level = 0.0

    def __init__(self):
        self.stops = 0
        self.added = 0
        self.ends = 0
        self.echo = False

    def stop(self, client=None):
        self.stops += 1

    def is_echo(self):
        return self.echo

    def add(self, frame):
        self.added += 1

    def end(self):
        self.ends += 1

    def __call__(self, frame):
        return float(frame[0])

    def transcribe(self, audio):
        return f"{len(audio) // FRAME} frames"


class Segmenting(unittest.TestCase):
    def setUp(self):
        self.seen = []
        events.route = lambda event: event["type"] != "level" and self.seen.append(event)
        self.fake = Fake()
        self.muted = threading.Event()
        self.segmenter = Segmenter(self.fake, self.fake, self.fake, self.fake, self.muted)

    def tearDown(self):
        events.route = None

    def feed(self, prob, count=1, request=None):
        for _ in range(count):
            self.segmenter.feed(np.full(FRAME, prob, dtype=np.float32), request)
            request = None

    def test_hands_free_speech_ends_after_silence(self):
        self.feed(0.0, 20)
        self.feed(0.9, 30)
        self.assertEqual(self.seen, [{"type": "speech"}])
        self.feed(0.0, END_FRAMES)
        heard = PREROLL_FRAMES + 30 - START_FRAMES + END_FRAMES
        self.assertEqual(self.seen, [{"type": "speech"}, {"type": "heard", "text": f"{heard} frames"}])
        self.assertEqual((self.fake.added, self.fake.ends), (heard, 1))

    def test_muted_hears_nothing_and_drops_the_utterance(self):
        self.feed(0.9, 10)
        self.muted.set()
        self.feed(0.9, 200)
        self.assertEqual((self.seen, self.fake.ends), ([{"type": "speech"}], 1))

    def test_a_recording_ignores_mute_and_silence_until_sent(self):
        self.muted.set()
        self.feed(0.0, 1, "talk")
        self.feed(0.0, 300)
        self.feed(0.0, 1, "send")
        self.assertEqual(self.seen, [{"type": "speech"}, {"type": "heard", "text": "302 frames"}])
        self.assertEqual(self.fake.stops, 1)

    def test_a_recording_too_short_is_heard_empty(self):
        self.feed(0.0, 1, "talk")
        self.feed(0.0, MIN_FRAMES - 3)
        self.feed(0.0, 1, "send")
        self.assertEqual(self.seen[-1], {"type": "heard", "text": ""})

    def test_barge_in_stops_the_speaker(self):
        self.fake.echo = True
        self.feed(0.9, 5)
        self.assertEqual((self.seen, self.fake.stops), ([], 0))
        self.feed(0.9, 1)
        self.assertEqual((self.seen, self.fake.stops), ([{"type": "speech"}], 1))


if __name__ == "__main__":
    unittest.main()
