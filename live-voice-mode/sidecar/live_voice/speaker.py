"""Kokoro text to speech into the buffer the audio stream plays."""

import os
import queue
import re
import threading
import time

import numpy as np

from .config import ECHO_SECONDS, NARRATE_SECONDS, PLAY_RATE, VOICE
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
        self.generation = 0
        self.answers = 0
        self.busy = threading.Event()
        self.quiet_since = 0.0
        self.level = 0.0
        threading.Thread(target=self.run, daemon=True).start()

    def say(self, text):
        """Queues an answer after the speech playing and drops every progress line not yet started."""
        self.answers += 1
        self.lines.put((self.generation, self.answers, None, text))

    def narrate(self, text):
        """Queues a progress line, dropped by a later answer or stop, or once older than NARRATE_SECONDS."""
        self.lines.put((self.generation, self.answers, time.monotonic(), text))

    def stop(self):
        """Drops what is playing and every line said before it."""
        with self.lock:
            self.generation += 1
            self.pending = self.pending[:0]

    def is_echo(self):
        return self.busy.is_set() or time.monotonic() - self.quiet_since < ECHO_SECONDS

    def pull(self, count):
        """Takes the next `count` samples to play, padded with silence, and keeps their RMS in `level`."""
        with self.lock:
            out, self.pending = self.pending[:count], self.pending[count:]
        self.level = float(np.sqrt(np.mean(np.square(out / 32768)))) if len(out) else 0.0
        return np.pad(out, (0, count - len(out)))

    def run(self):
        while True:
            generation, answers, queued, text = self.lines.get()
            narration = queued is not None
            if narration and (answers != self.answers or time.monotonic() - queued > NARRATE_SECONDS):
                generation = None
            self.busy.set()

            for sentence in filter(None, SENTENCE_END.split(text)):
                if generation != self.generation:
                    break

                audio, rate = self.kokoro.create(sentence, voice=VOICE, lang="en-us")

                with self.lock:
                    if generation != self.generation:
                        break
                    self.pending = np.concatenate([self.pending, to_pcm(audio, rate)])

            while len(self.pending) and generation == self.generation:
                time.sleep(0.05)

            if self.lines.empty():
                self.quiet_since = time.monotonic()
                self.busy.clear()
                if not narration:
                    emit("spoken")
