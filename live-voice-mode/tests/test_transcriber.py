"""Transcriber with a fake faster-whisper: the GPU fallback, silent segments and hotword-only readings."""

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))

import numpy as np

from live_voice import events
from live_voice.transcriber import Transcriber


class WhisperModel:
    """Reads `segments`, as (text, no_speech_prob) pairs, for any audio; fails on `broken` devices."""

    segments = []
    broken = set()

    def __init__(self, path, device, compute_type):
        self.device = device

    def transcribe(self, audio, **options):
        if self.device in self.broken:
            raise RuntimeError("no CUDA")
        return (types.SimpleNamespace(text=text, no_speech_prob=prob) for text, prob in self.segments), None


class Transcribing(unittest.TestCase):
    def setUp(self):
        sys.modules["faster_whisper"] = types.SimpleNamespace(WhisperModel=WhisperModel)
        self.seen = []
        events.route = self.seen.append

    def tearDown(self):
        events.route = None
        WhisperModel.segments, WhisperModel.broken = [], set()

    def hear(self, *segments):
        WhisperModel.segments = list(segments)
        return Transcriber("").transcribe(np.zeros(16000, np.float32))

    def test_the_cpu_takes_over_when_the_gpu_fails(self):
        WhisperModel.broken = {"cuda"}
        self.assertEqual(Transcriber("").device, "cpu")
        self.assertEqual(self.seen, [{"type": "log", "text": "GPU unavailable, using CPU: no CUDA"}])

    def test_segments_judged_silent_are_dropped(self):
        self.assertEqual(self.hear((" Fix it.", 0.1), (" Thanks.", 0.9)), "Fix it.")

    def test_only_hotwords_read_as_nothing(self):
        for text in (" Claude.", " Claude Code!", " claude, Claude Code..."):
            self.assertEqual(self.hear((text, 0.1)), "", text)
        self.assertEqual(self.hear((" Claude, fix the code.", 0.1)), "Claude, fix the code.")


if __name__ == "__main__":
    unittest.main()
