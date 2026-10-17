"""Live voice sidecar: microphone to transcript lines on stdout, and text to speech over localhost HTTP.

Each stdout line is one JSON event: ready, speech, heard, spoken, log.
POST /speak with the text as the body speaks it; POST /stop ends the speech.
"""

import argparse
import collections
import glob
import json
import os
import queue
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sounddevice as sd

RATE = 16000
PLAY_RATE = 48000
FRAME = 512
CHUNK = 480
CONTEXT = 64
PREROLL_FRAMES = 10
START_FRAMES = 3
END_FRAMES = 47
MIN_FRAMES = 12
MAX_FRAMES = 940
START_PROB = 0.5
END_PROB = 0.35
BARGE_PROB = 0.6
BARGE_FRAMES = 6
BARGE_WINDOW = 10
ECHO_SECONDS = 0.4
VOICE = "af_heart"
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")

printing = threading.Lock()


def emit(kind, **fields):
    """Writes one JSON event line to stdout."""
    with printing:
        print(json.dumps({"type": kind, **fields}), flush=True)


def add_cuda_paths():
    """Puts the pip-installed NVIDIA DLL folders on the DLL search path."""
    for folder in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(folder)
        os.environ["PATH"] = folder + os.pathsep + os.environ["PATH"]


def load_model(path):
    """Loads Whisper on the GPU, or on the CPU when the GPU fails a warm-up run."""
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(path, device="cuda", compute_type="int8_float16")
        list(model.transcribe(np.zeros(RATE, dtype=np.float32), language="en")[0])
        return model, "cuda"
    except Exception as error:
        emit("log", text=f"GPU unavailable, using CPU: {error}")
        return WhisperModel(path, device="cpu", compute_type="int8"), "cpu"


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


def transcribe(model, audio):
    """Returns the text Whisper hears in the audio, without segments it judges silent."""
    segments, _ = model.transcribe(audio, language="en", vad_filter=True, condition_on_previous_text=False)
    return " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()


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


def serve(speaker):
    """Starts the /speak and /stop server on a free localhost port and returns the port."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
            actions = {"/speak": lambda: speaker.say(body), "/stop": speaker.stop}

            if self.path not in actions:
                self.send_response(404)
            else:
                actions[self.path]()
                self.send_response(204)

            self.end_headers()

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    return server.server_address[1]


def listen(model, speaker, ready):
    """Plays the speaker's audio, reads the echo-cancelled microphone forever, and emits each utterance it hears."""
    from livekit import rtc

    apm = rtc.AudioProcessingModule(echo_cancellation=True, high_pass_filter=True)
    wasapi = next(api for api in sd.query_hostapis() if "WASAPI" in api["name"])
    devices = (wasapi["default_input_device"], wasapi["default_output_device"])
    chunks = queue.Queue()
    preroll = collections.deque(maxlen=PREROLL_FRAMES)
    recent = collections.deque(maxlen=BARGE_WINDOW)
    detector = VoiceDetector()
    samples = np.zeros(0, dtype=np.float32)
    voiced = []
    loud = 0
    silent = 0

    def on_audio(indata, outdata, *_):
        outdata[:, 0] = speaker.pull(CHUNK)
        apm.process_reverse_stream(rtc.AudioFrame(outdata.tobytes(), PLAY_RATE, 1, CHUNK))
        mic = rtc.AudioFrame(indata.tobytes(), PLAY_RATE, 1, CHUNK)
        apm.process_stream(mic)
        clean = np.frombuffer(mic.data, dtype=np.int16).astype(np.float32) / 32768
        chunks.put(clean.reshape(-1, PLAY_RATE // RATE).mean(axis=1))

    with sd.Stream(device=devices, samplerate=PLAY_RATE, blocksize=CHUNK, channels=1, dtype="int16", callback=on_audio) as stream:
        apm.set_stream_delay_ms(int(sum(stream.latency) * 1000))
        emit("ready", **ready)

        while True:
            samples = np.concatenate([samples, chunks.get()])

            if len(samples) < FRAME:
                continue

            frame, samples = samples[:FRAME], samples[FRAME:]
            prob = detector(frame)

            if not voiced:
                echo = speaker.is_echo()
                preroll.append(frame)
                recent.append(prob > BARGE_PROB)
                loud = loud + 1 if prob > START_PROB else 0

                if sum(recent) >= BARGE_FRAMES if echo else loud >= START_FRAMES:
                    if echo:
                        speaker.stop()
                    voiced = list(preroll)
                    emit("speech")
                continue

            voiced.append(frame)
            silent = silent + 1 if prob < END_PROB else 0

            if silent >= END_FRAMES or len(voiced) >= MAX_FRAMES:
                text = transcribe(model, np.concatenate(voiced)) if len(voiced) >= MIN_FRAMES else ""
                emit("heard", text=text)
                preroll.clear()
                recent.clear()
                voiced, loud, silent = [], 0, 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--kokoro", required=True)
    args = parser.parse_args()

    add_cuda_paths()
    model, device = load_model(args.model)
    speaker = Speaker(args.kokoro)
    port = serve(speaker)
    listen(model, speaker, {"port": port, "device": device})


if __name__ == "__main__":
    main()
