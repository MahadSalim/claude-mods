"""Live voice sidecar: microphone to transcript lines on stdout, and text to speech over localhost HTTP.

Each stdout line is one JSON event: ready, speech, partial, heard, spoken, log.
POST /speak with the text as the body speaks it; POST /mute and POST /unmute turn the microphone off and on.
"""

import threading

from live_voice.audio import listen
from live_voice.config import KOKORO, WHISPER
from live_voice.live_words import LiveWords
from live_voice.server import serve
from live_voice.speaker import Speaker
from live_voice.transcriber import Transcriber


def main():
    muted = threading.Event()
    transcriber = Transcriber(WHISPER)
    speaker = Speaker(KOKORO)
    words = LiveWords(transcriber)
    port = serve(speaker, muted)
    listen(transcriber, speaker, words, muted, {"port": port, "device": transcriber.device})


if __name__ == "__main__":
    main()
