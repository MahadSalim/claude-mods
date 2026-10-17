"""Live voice sidecar: microphone to transcript lines on stdout, and text to speech over localhost HTTP.

Each stdout line is one JSON event: ready, speech, partial, heard, spoken, level, log.
POST /speak with the text as the body speaks it; POST /narrate speaks a progress line unless an answer or stop comes first or it waits too long; POST /stop ends the speech; POST /mute and POST /unmute turn the microphone off and on; it starts off.
POST /talk starts a manual recording, POST /send ends and sends it, POST /cancel drops it.
"""

import queue
import threading

from live_voice.audio import listen
from live_voice.config import KOKORO, WHISPER
from live_voice.live_words import LiveWords
from live_voice.server import serve
from live_voice.speaker import Speaker
from live_voice.transcriber import Transcriber


def main():
    muted = threading.Event()
    muted.set()
    requests = queue.Queue()
    transcriber = Transcriber(WHISPER)
    speaker = Speaker(KOKORO)
    words = LiveWords(transcriber)
    port = serve(speaker, muted, requests)
    listen(transcriber, speaker, words, muted, requests, {"port": port, "device": transcriber.device})


if __name__ == "__main__":
    main()
