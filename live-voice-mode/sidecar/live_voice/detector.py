"""Silero voice activity detection."""

import numpy as np

CONTEXT = 64


class VoiceDetector:
    """Silero VAD over FRAME-sample frames, keeping its state from one frame to the next."""

    def __init__(self):
        from faster_whisper.vad import get_vad_model

        self.session = get_vad_model().session
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT, dtype=np.float32)

    def __call__(self, frame):
        """Returns the probability that the frame is speech."""
        audio = np.concatenate([self.context, frame])[None]
        prob, self.h, self.c = self.session.run(None, {"input": audio, "h": self.h, "c": self.c})
        self.context = frame[-CONTEXT:]
        return float(prob.reshape(-1)[0])
