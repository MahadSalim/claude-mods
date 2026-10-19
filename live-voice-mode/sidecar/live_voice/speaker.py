"""Kokoro text to speech into the buffer the audio stream plays."""

import itertools
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
        self.serials = itertools.count(1)
        self.answered = 0
        self.stopped = {}
        self.busy = threading.Event()
        self.quiet_since = 0.0
        self.level = 0.0
        self.client = None
        threading.Thread(target=self.run, daemon=True).start()

    def say(self, text, client=None):
        """Queues an answer of `client` after the speech playing and drops every progress line not yet started."""
        self.answered = next(self.serials)
        self.lines.put((self.answered, None, text, client))

    def narrate(self, text, client=None):
        """Queues a progress line of `client`, dropped by a later answer or stop, or once older than NARRATE_SECONDS."""
        self.lines.put((next(self.serials), time.monotonic(), text, client))

    def follows(self, client):
        """Whether the next queued line is `client`'s."""
        with self.lines.mutex:
            return bool(self.lines.queue) and self.lines.queue[0][-1] == client

    def stop(self, client=None):
        """Drops every line queued before now and the one playing: all of them, or with `client` only that session's."""
        with self.lock:
            self.stopped[client] = next(self.serials)
            if client in (None, self.client):
                self.pending = self.pending[:0]

    def cut(self, serial, client):
        """Whether a stop dropped `client`'s line `serial`."""
        return serial < max(self.stopped.get(None, 0), self.stopped.get(client, 0))

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
            serial, queued, text, client = self.lines.get()
            self.client = client
            narration = queued is not None
            stale = narration and (serial < self.answered or time.monotonic() - queued > NARRATE_SECONDS)
            self.busy.set()

            for sentence in filter(None, SENTENCE_END.split(text)):
                if stale or self.cut(serial, client):
                    break

                audio, rate = self.kokoro.create(sentence, voice=VOICE, lang="en-us")

                with self.lock:
                    if self.cut(serial, client):
                        break
                    self.pending = np.concatenate([self.pending, to_pcm(audio, rate)])

            while len(self.pending) and not stale and not self.cut(serial, client) and not self.follows(client):
                time.sleep(0.05)

            if self.lines.empty():
                self.quiet_since = time.monotonic()
                self.busy.clear()
            if not narration and serial > self.stopped.get(client, 0) and not self.follows(client):
                emit("spoken")
