"""faster-whisper transcription of a whole utterance into its final text."""

import glob
import os
import re
import sys
import threading

import numpy as np

from .config import HOTWORDS, RATE
from .events import emit

ONLY_HOTWORDS = re.compile(rf"\W*(?:(?:{HOTWORDS.replace(', ', '|')})\W*)+", re.IGNORECASE)


def add_cuda_paths():
    """Puts the pip-installed NVIDIA DLL folders on the DLL search path."""
    for folder in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(folder)
        os.environ["PATH"] = folder + os.pathsep + os.environ["PATH"]


class Transcriber:
    """Whisper on the GPU, or on the CPU when the GPU fails a warm-up run; `device` names which."""

    def __init__(self, path):
        add_cuda_paths()
        from faster_whisper import WhisperModel

        try:
            self.model = WhisperModel(path, device="cuda", compute_type="int8_float16")
            list(self.model.transcribe(np.zeros(RATE, dtype=np.float32), language="en")[0])
            self.device = "cuda"
        except Exception as error:
            emit("log", text=f"GPU unavailable, using CPU: {error}")
            self.model = WhisperModel(path, device="cpu", compute_type="int8")
            self.device = "cpu"

        self.lock = threading.Lock()

    def read(self, audio, **options):
        """Returns the text Whisper hears in the audio with `options`, without segments it judges silent, one pass at a time; nothing when it hears only HOTWORDS."""
        with self.lock:
            segments, _ = self.model.transcribe(audio, language="en", condition_on_previous_text=False, hotwords=HOTWORDS, **options)
            text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()
        return "" if ONLY_HOTWORDS.fullmatch(text) else text

    def transcribe(self, audio):
        """Returns the final text of the audio."""
        return self.read(audio, vad_filter=True)

    def partial(self, audio):
        """Returns a greedy single-decode reading of the audio, for the words so far."""
        return self.read(audio, beam_size=1, temperature=0.0, without_timestamps=True, vad_filter=False)
