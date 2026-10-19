"""Live partial words while an utterance is still being spoken."""

import queue
import re
import threading

import numpy as np

from .config import PARTIAL_FRAMES, UNFINISHED
from .events import emit

FINISHED = re.compile(r"[.!?]$")
TRAILING = re.compile(rf"(\.\.|…|\b(?:{UNFINISHED})\.)$", re.IGNORECASE)


class LiveWords:
    """Back-to-back Whisper partial passes over the last PARTIAL_FRAMES of each utterance so far, emitting the words as partial events when they change."""

    def __init__(self, transcriber):
        self.transcriber = transcriber
        self.frames = queue.Queue()
        self.utterance = 0
        self.heard = (0, "")
        self.ending = threading.Lock()
        threading.Thread(target=self.run, daemon=True).start()

    def add(self, frame):
        self.frames.put((self.utterance, frame))

    def end(self):
        """Ends the utterance; no partial for it is emitted once this returns."""
        with self.ending:
            self.utterance += 1
            self.heard = (0, "")
        self.frames.put((self.utterance, None))

    def finished(self, count):
        """Whether the latest partial of the utterance covers its first `count` frames and ends a sentence, not with an ellipsis or an UNFINISHED word."""
        covered, text = self.heard
        return covered >= count and bool(FINISHED.search(text)) and not TRAILING.search(text)

    def take(self):
        """Waits for the next queued item and returns it with every other item already queued."""
        items = [self.frames.get()]
        while not self.frames.empty():
            items.append(self.frames.get_nowait())
        return items

    def run(self):
        audio = []

        while True:
            for utterance, frame in self.take():
                if frame is None or utterance != self.utterance:
                    audio = []
                else:
                    audio.append(frame)

            if audio:
                text = self.transcriber.partial(np.concatenate(audio[-PARTIAL_FRAMES:]))
                with self.ending:
                    if utterance == self.utterance:
                        if text != self.heard[1]:
                            emit("partial", text=text)
                        self.heard = (len(audio), text)
