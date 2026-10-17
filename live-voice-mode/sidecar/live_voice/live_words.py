"""Live partial words while an utterance is still being spoken."""

import queue
import threading

import numpy as np

from .events import emit


class LiveWords:
    """Back-to-back Whisper partial passes over each utterance so far, emitting the words as partial events."""

    def __init__(self, transcriber):
        self.transcriber = transcriber
        self.frames = queue.Queue()
        self.utterance = 0
        self.ending = threading.Lock()
        threading.Thread(target=self.run, daemon=True).start()

    def add(self, frame):
        self.frames.put((self.utterance, frame))

    def end(self):
        """Ends the utterance; no partial for it is emitted once this returns."""
        with self.ending:
            self.utterance += 1
        self.frames.put((self.utterance, None))

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
                text = self.transcriber.partial(np.concatenate(audio))
                with self.ending:
                    if utterance == self.utterance:
                        emit("partial", text=text)
