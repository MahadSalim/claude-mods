"""Utterance segmentation with fakes: frames whose first sample is their speech probability, no models, no audio."""

import os
import queue
import sys
import threading
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))

import numpy as np
import sounddevice

from live_voice import audio, events
from live_voice.audio import Segmenter
from live_voice.config import CHUNK, END_FRAMES, FRAME, MIN_FRAMES, PREROLL_FRAMES, SPEECH_FRAMES, STALL_SECONDS, START_FRAMES


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

    def pull(self, count):
        return np.zeros(count, np.int16)

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
        self.assertEqual((self.fake.added, self.fake.ends), (heard - END_FRAMES, 1))

    def test_the_live_words_get_a_pause_only_once_speech_resumes(self):
        self.feed(0.9, 20)
        self.feed(0.0, 10)
        self.assertEqual(self.fake.added, 20)
        self.feed(0.9, 1)
        self.assertEqual(self.fake.added, 31)

    def test_a_noise_too_short_for_speech_is_heard_empty(self):
        for speech, heard in ((SPEECH_FRAMES - 1, ""), (SPEECH_FRAMES, f"{START_FRAMES + SPEECH_FRAMES + END_FRAMES} frames")):
            self.feed(0.9, START_FRAMES + speech)
            self.feed(0.0, END_FRAMES)
            self.assertEqual(self.seen[-1], {"type": "heard", "text": heard})

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

    def test_cancel_drops_a_hands_free_utterance_and_starts_afresh(self):
        self.feed(0.9, 30)
        self.feed(0.9, 1, "cancel")
        self.assertEqual(self.fake.ends, 1)
        self.feed(0.9, START_FRAMES - 2)
        self.feed(0.0, END_FRAMES)
        self.assertEqual(self.seen, [{"type": "speech"}])

    def test_barge_in_stops_the_speaker(self):
        self.fake.echo = True
        self.feed(0.9, 5)
        self.assertEqual((self.seen, self.fake.stops), ([], 0))
        self.feed(0.9, 1)
        self.assertEqual((self.seen, self.fake.stops), ([{"type": "speech"}], 1))


class Frame:
    def __init__(self, data, *shape):
        self.data = data


class Processing:
    def __init__(self, **options):
        pass

    def process_stream(self, frame):
        pass

    process_reverse_stream = set_stream_delay_ms = process_stream


class Stream:
    """A duplex stream that plays `blocks` blocks of silence when entered, then stalls."""

    blocks = 64
    latency = (0.01, 0.01)

    def __init__(self, callback, **options):
        self.callback, self.options = callback, options

    def __enter__(self):
        for _ in range(self.blocks):
            self.callback(np.zeros((CHUNK, 1), np.int16), np.zeros((CHUNK, 1), np.int16), CHUNK, None, None)
        Stream.opened = self.options
        return self

    def __exit__(self, *error):
        pass


class Listening(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.calls = []
        events.route = lambda event: event["type"] != "level" and self.seen.append(event)
        sys.modules["livekit"] = types.SimpleNamespace(rtc=types.SimpleNamespace(AudioProcessingModule=Processing, AudioFrame=Frame))
        audio.sd = types.SimpleNamespace(
            _terminate=lambda: self.calls.append("terminate"),
            _initialize=lambda: self.calls.append("initialize"),
            query_hostapis=lambda: [{"name": "MME"}, {"name": "Windows WASAPI", "default_input_device": 1, "default_output_device": 2}],
            Stream=Stream,
            WasapiSettings=lambda **options: options,
        )
        audio.STALL_SECONDS = 0.05

    def tearDown(self):
        events.route = None
        audio.sd, audio.STALL_SECONDS = sounddevice, STALL_SECONDS

    def test_a_stalled_stream_is_left_after_reading_the_devices_afresh(self):
        fake, live = Fake(), threading.Event()
        live.set()
        audio.listen(fake, fake, fake, fake, threading.Event(), queue.Queue(), live)
        self.assertEqual(self.calls, ["terminate", "initialize"])
        self.assertEqual((Stream.opened["device"], Stream.opened["extra_settings"]), ((1, 2), {"auto_convert": True}))
        self.assertEqual(self.seen, [{"type": "log", "text": "Audio stream stalled; reopening it."}])


if __name__ == "__main__":
    unittest.main()
