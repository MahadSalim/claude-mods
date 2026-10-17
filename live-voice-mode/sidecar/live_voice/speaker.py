"""Kokoro text to speech into the buffer the audio stream plays."""

import os
import queue
import re
import threading
import time

import numpy as np

from .config import ECHO_SECONDS, PLAY_RATE, VOICE
from .events import emit

SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def to_pcm(audio, rate):
    """Float audio at `rate` Hz as PLAY_RATE-Hz int16 samples."""
    at = np.arange(0, len(audio), rate / PLAY_RATE)
    return (np.clip(np.interp(at, np.arange(len(audio)), audio), -1, 1) * 32767).astype(np.int16)


class Speaker:
    """Speaks queued text with Kokoro into a buffer the audio stream pulls from."""

    def __init__(self, folder):
        from kokoro_onnx import Kokoro

        self.kokoro = Kokoro(os.path.join(folder, "kokoro-v1.0.onnx"), os.path.join(folder, "voices-v1.0.bin"))
        self.lines = queue.Queue()
        self.pending = np.zeros(0, dtype=np.int16)
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.busy = threading.Event()
        self.quiet_since = 0.0
        threading.Thread(target=self.run, daemon=True).start()

    def say(self, text):
        self.lines.put(text)

    def stop(self):
        while not self.lines.empty():
            self.lines.get_nowait()
        self.stopping.set()
        with self.lock:
            self.pending = self.pending[:0]

    def is_echo(self):
        return self.busy.is_set() or time.monotonic() - self.quiet_since < ECHO_SECONDS

    def pull(self, count):
        """Takes the next `count` samples to play, padded with silence."""
        with self.lock:
            out, self.pending = self.pending[:count], self.pending[count:]
        return np.pad(out, (0, count - len(out)))

    def run(self):
        while True:
            text = self.lines.get()
            self.stopping.clear()
            self.busy.set()

            for sentence in filter(None, SENTENCE_END.split(text)):
                audio, rate = self.kokoro.create(sentence, voice=VOICE, lang="en-us")

                if self.stopping.is_set():
                    break

                with self.lock:
                    self.pending = np.concatenate([self.pending, to_pcm(audio, rate)])

            while len(self.pending) and not self.stopping.is_set():
                time.sleep(0.05)

            if self.lines.empty():
                self.quiet_since = time.monotonic()
                self.busy.clear()
                emit("spoken")
