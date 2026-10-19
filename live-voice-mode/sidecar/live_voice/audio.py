"""The echo-cancelled duplex audio loop: playback, utterance segmentation and barge-in."""

import collections
import queue

import numpy as np
import sounddevice as sd

from .config import (
    BARGE_FRAMES,
    BARGE_PROB,
    BARGE_WINDOW,
    CHUNK,
    END_FRAMES,
    END_PROB,
    FRAME,
    LEVEL_EVERY,
    LEVEL_FLOOR,
    MANUAL_MAX_FRAMES,
    MAX_FRAMES,
    MIN_FRAMES,
    PLAY_RATE,
    PREROLL_FRAMES,
    RATE,
    SPEECH_FRAMES,
    START_FRAMES,
    STALL_SECONDS,
    START_PROB,
)
from .events import emit


class Segmenter:
    """Cuts 16 kHz frames into utterances, hands-free while `muted` is clear or as a manual recording, emitting speech, level and heard."""

    def __init__(self, transcriber, speaker, words, detector, muted):
        self.transcriber, self.speaker, self.words, self.detector, self.muted = transcriber, speaker, words, detector, muted
        self.preroll = collections.deque(maxlen=PREROLL_FRAMES)
        self.recent = collections.deque(maxlen=BARGE_WINDOW)
        self.voiced = []
        self.added = 0
        self.loud = 0
        self.silent = 0
        self.speech = 0
        self.manual = False
        self.frames = 0
        self.level = [0.0, 0.0]

    def drop(self):
        """Forgets the utterance in progress."""
        if self.voiced:
            self.words.end()
        self.preroll.clear()
        self.recent.clear()
        self.voiced, self.added, self.loud, self.silent, self.speech, self.manual = [], 0, 0, 0, 0, False

    def start(self, frames):
        """Begins an utterance with `frames`."""
        self.voiced = list(frames)
        emit("speech")
        self.hear()

    def hear(self):
        """Gives the live words the utterance's frames they do not have yet."""
        for frame in self.voiced[self.added:]:
            self.words.add(frame)
        self.added = len(self.voiced)

    def meter(self, frame):
        """Emits `level` every LEVEL_EVERY frames when the microphone's or the speaker's RMS changed."""
        self.frames += 1
        if self.frames % LEVEL_EVERY:
            return
        mic = 0.0 if self.muted.is_set() and not self.manual else float(np.sqrt(np.mean(frame**2)))
        now = [round(value, 3) if value > LEVEL_FLOOR else 0.0 for value in (mic, self.speaker.level)]
        if now != self.level:
            self.level = now
            emit("level", mic=now[0], out=now[1])

    def feed(self, frame, request=None):
        """Takes one frame and the request ("talk", "send" or "cancel") that came with it, if any."""
        if request == "talk" and not self.manual:
            self.speaker.stop()
            emit("speech")
            self.manual = True
        elif request == "cancel":
            self.drop()

        self.meter(frame)

        if self.manual:
            self.voiced.append(frame)
            self.hear()
            if request == "send" or len(self.voiced) >= MANUAL_MAX_FRAMES:
                self.finish()
            return

        if self.muted.is_set():
            return self.drop()

        prob = self.detector(frame)

        if not self.voiced:
            echo = self.speaker.is_echo()
            self.preroll.append(frame)
            self.recent.append(prob > BARGE_PROB)
            self.loud = self.loud + 1 if prob > START_PROB else 0

            if sum(self.recent) >= BARGE_FRAMES if echo else self.loud >= START_FRAMES:
                if echo:
                    self.speaker.stop()
                self.start(self.preroll)
            return

        self.voiced.append(frame)
        self.silent = self.silent + 1 if prob < END_PROB else 0
        self.speech += prob > START_PROB
        if not self.silent:
            self.hear()

        if self.silent >= END_FRAMES or len(self.voiced) >= MAX_FRAMES:
            self.finish()

    def finish(self):
        """Ends the utterance, emitting its text as `heard`, or no text for a recording under MIN_FRAMES or speech under SPEECH_FRAMES."""
        audio, noise = self.voiced, len(self.voiced) < MIN_FRAMES if self.manual else self.speech < SPEECH_FRAMES
        self.drop()
        emit("heard", text="" if noise else self.transcriber.transcribe(np.concatenate(audio)))


def listen(transcriber, speaker, words, detector, muted, requests, live):
    """Plays the speaker's audio, reads the echo-cancelled microphone of the current default devices while `live` is set, and emits each utterance it hears.

    `requests` carries "talk", "send" and "cancel" for a manual recording, which ignores `muted` and silence.
    Returns early when the stream delivers nothing for STALL_SECONDS.
    """
    from livekit import rtc

    sd._terminate()
    sd._initialize()
    apm = rtc.AudioProcessingModule(echo_cancellation=True, high_pass_filter=True)
    wasapi = next(api for api in sd.query_hostapis() if "WASAPI" in api["name"])
    devices = (wasapi["default_input_device"], wasapi["default_output_device"])
    chunks = queue.Queue()
    segmenter = Segmenter(transcriber, speaker, words, detector, muted)
    samples = np.zeros(0, dtype=np.float32)

    def on_audio(indata, outdata, *_):
        outdata[:, 0] = speaker.pull(CHUNK)
        apm.process_reverse_stream(rtc.AudioFrame(outdata.tobytes(), PLAY_RATE, 1, CHUNK))
        mic = rtc.AudioFrame(indata.tobytes(), PLAY_RATE, 1, CHUNK)
        apm.process_stream(mic)
        clean = np.frombuffer(mic.data, dtype=np.int16).astype(np.float32) / 32768
        chunks.put(clean.reshape(-1, PLAY_RATE // RATE).mean(axis=1))

    with sd.Stream(device=devices, samplerate=PLAY_RATE, blocksize=CHUNK, channels=1, dtype="int16", callback=on_audio, extra_settings=sd.WasapiSettings(auto_convert=True)) as stream:
        apm.set_stream_delay_ms(int(sum(stream.latency) * 1000))

        while live.is_set():
            try:
                samples = np.concatenate([samples, chunks.get(timeout=STALL_SECONDS)])
            except queue.Empty:
                emit("log", text="Audio stream stalled; reopening it.")
                break

            if len(samples) >= FRAME:
                frame, samples = samples[:FRAME], samples[FRAME:]
                segmenter.feed(frame, None if requests.empty() else requests.get_nowait())

    segmenter.drop()
