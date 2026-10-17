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
    MAX_FRAMES,
    MIN_FRAMES,
    PLAY_RATE,
    PREROLL_FRAMES,
    RATE,
    START_FRAMES,
    START_PROB,
)
from .detector import VoiceDetector
from .events import emit


def listen(transcriber, speaker, words, muted, ready):
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

            if muted.is_set():
                if voiced:
                    words.end()
                preroll.clear()
                recent.clear()
                voiced, loud, silent = [], 0, 0
                continue

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
                    for early in voiced:
                        words.add(early)
                continue

            voiced.append(frame)
            words.add(frame)
            silent = silent + 1 if prob < END_PROB else 0

            if silent >= END_FRAMES or len(voiced) >= MAX_FRAMES:
                words.end()
                text = transcriber.transcribe(np.concatenate(voiced)) if len(voiced) >= MIN_FRAMES else ""
                emit("heard", text=text)
                preroll.clear()
                recent.clear()
                voiced, loud, silent = [], 0, 0
