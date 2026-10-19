"""Shared live voice engine: Whisper, Kokoro, the VAD, the microphone and the speaker for every session, behind localhost HTTP and a tray icon.

GET /events is a session's event stream, `ready {port, device, client}` once the models are loaded; each POST carries the session's id in the X-Client header.
POST /speak and /narrate queue the session's speech; /stop ends all speech; /unmute (hands-free) and /talk (a recording) give the session the microphone, telling the session that had it `taken`; /mute, /send and /cancel act only for the session holding it.
The microphone stream is open while any session is connected. The tray's Quit, or a failure loading the models or running the audio, ends the engine, sending each session `end` and removing the tray icon; Restart starts a new engine and exits.
"""

import contextlib
import itertools
import json
import os
import queue
import sys
import threading
import traceback

from live_voice import events
from live_voice.config import ENGINE_LOCK, ENGINE_LOG, ENGINE_STATE, KOKORO, LOCK_SECONDS, WHISPER
from live_voice.launch import hold, start
from live_voice.server import serve

COLORS = {"loading": "gray", "ready": "darkcyan", "listening": "limegreen", "speaking": "magenta"}


class Flag(threading.Event):
    """An Event that sets `changed` whenever it is set or cleared."""

    def __init__(self, changed):
        super().__init__()
        self.changed = changed

    def set(self):
        super().set()
        self.changed.set()

    def clear(self):
        super().clear()
        self.changed.set()


class Engine:
    """The connected sessions, the one holding the microphone, and the models once loaded."""

    def __init__(self):
        self.clients = {}
        self.ids = itertools.count(1)
        self.owner = None
        self.lock = threading.Lock()
        self.muted = threading.Event()
        self.muted.set()
        self.present = threading.Event()
        self.requests = queue.Queue()
        self.speaker = None
        self.device = None
        self.port = None
        self.ending = None
        self.changed = threading.Event()
        self.routes = {
            "/speak": lambda client, body: self.speaker.say(body, client),
            "/narrate": lambda client, body: self.speaker.narrate(body, client),
            "/stop": lambda client, body: self.speaker.stop(),
            "/unmute": lambda client, body: self.take(client) or self.muted.clear(),
            "/talk": lambda client, body: self.take(client) or self.requests.put("talk"),
            "/mute": lambda client, body: self.release(client, False),
            "/cancel": lambda client, body: self.release(client, True),
            "/send": lambda client, body: self.owner == client and self.requests.put("send"),
        }

    @contextlib.contextmanager
    def changing(self):
        """Holds the lock for a change to the sessions, then sets `changed`."""
        with self.lock:
            yield
        self.changed.set()

    def tell(self, to, kind, **fields):
        """Sends one event to session `to`, if it is still connected."""
        write = self.clients.get(to)
        if write:
            write(json.dumps({"type": kind, **fields}).encode() + b"\n")

    def route(self, event):
        """Sends an event to the sessions it belongs to: microphone events to its holder, `spoken` to the speech's session, both shares of `level`, `log` to all."""
        kind, fields = event.pop("type"), event

        if kind == "log":
            print(fields["text"], file=sys.stderr, flush=True)
            for client in list(self.clients):
                self.tell(client, kind, **fields)
        elif kind == "level":
            speaking = self.speaker.client
            for client in {self.owner, speaking} - {None}:
                self.tell(client, kind, mic=fields["mic"] if client == self.owner else 0.0, out=fields["out"] if client == speaking else 0.0)
        elif kind == "spoken":
            self.tell(self.speaker.client, kind)
        else:
            self.tell(self.owner, kind, **fields)
            if kind == "heard" and self.muted.is_set():
                with self.changing():
                    self.owner = None

    def take(self, client):
        """Gives the microphone to `client`, telling the session that had it and dropping that session's recording."""
        with self.changing():
            if self.owner not in (None, client):
                self.tell(self.owner, "taken")
                self.muted.set()
                self.requests.put("cancel")
            self.owner = client

    def release(self, client, recording):
        """Frees the microphone when `client` holds it: ends hands-free, or with `recording` drops its recording."""
        with self.changing():
            if self.owner == client and recording == self.muted.is_set():
                self.muted.set()
                self.requests.put("cancel")
                self.owner = None

    def hello(self, client):
        self.tell(client, "ready", port=self.port, device=self.device, client=client)

    def end(self, text):
        """Tells every session that voice mode is over, and why."""
        for client in list(self.clients):
            self.tell(client, "end", text=text)

    def join(self, handler):
        """Streams events to a newly connected session until it disconnects."""
        client = str(next(self.ids))
        sending = threading.Lock()

        def write(data):
            with sending:
                try:
                    handler.wfile.write(data)
                except OSError:
                    pass

        with self.changing():
            self.clients[client] = write
            self.present.set()
            if self.speaker:
                self.hello(client)

        try:
            handler.rfile.read()
        except OSError:
            pass

        self.leave(client)

    def leave(self, client):
        """Forgets a disconnected session, freeing the microphone and stopping its speech; the last one closes the microphone."""
        with self.changing():
            del self.clients[client]
            if self.owner == client:
                self.muted.set()
                self.owner = None
            if not self.clients:
                self.present.clear()
                with self.requests.mutex:
                    self.requests.queue.clear()
            if self.speaker and (self.speaker.client == client or not self.clients):
                self.speaker.stop()

    def status(self):
        """The engine's state for the tray: loading, ready, listening or speaking."""
        if not self.speaker:
            return "loading"
        if self.speaker.busy.is_set():
            return "speaking"
        return "listening" if self.owner else "ready"

    def run(self):
        """Loads the models, tells each connected session it is ready, then opens the microphone while any session is connected; a failure ends the engine."""
        try:
            from live_voice.audio import listen
            from live_voice.detector import VoiceDetector
            from live_voice.live_words import LiveWords
            from live_voice.speaker import Speaker
            from live_voice.transcriber import Transcriber

            transcriber = Transcriber(WHISPER)
            speaker = Speaker(KOKORO)
            words = LiveWords(transcriber)
            detector = VoiceDetector()

            with self.changing():
                speaker.busy = Flag(self.changed)
                self.device = transcriber.device
                self.speaker = speaker
                for client in self.clients:
                    self.hello(client)

            while True:
                self.present.wait()
                listen(transcriber, speaker, words, detector, self.muted, self.requests, self.present)
        except Exception as error:
            traceback.print_exc()
            self.end(f"Voice engine failed: {error}")
            self.finish("failed")

    def finish(self, ending):
        """Ends the engine: `ending` is restart, quit or failed."""
        self.ending = ending
        self.changed.set()


def tray(engine):
    """Shows the tray icon until the engine ends, and returns its ending."""
    import pystray
    from PIL import Image, ImageDraw

    def label():
        count = len(engine.clients)
        return f"Voice engine: {engine.status()}, {count} session{'' if count == 1 else 's'}"

    def picture(color):
        image = Image.new("RGBA", (64, 64))
        ImageDraw.Draw(image).ellipse((8, 8, 56, 56), fill=color)
        return image

    def refresh(icon):
        icon.visible = True
        shown = ""
        while not engine.ending:
            if label() != shown:
                shown = label()
                icon.title = shown
                icon.icon = picture(COLORS[engine.status()])
                icon.update_menu()
            engine.changed.wait()
            engine.changed.clear()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem(lambda item: label(), None, enabled=False),
        pystray.MenuItem("Restart", lambda: engine.finish("restart")),
        pystray.MenuItem("Quit", lambda: engine.finish("quit")),
    )
    pystray.Icon("live-voice-engine", picture(COLORS["loading"]), "Voice engine", menu).run(refresh)

    return engine.ending


def main():
    sys.stderr = open(ENGINE_LOG, "a", buffering=1)

    if hold(ENGINE_LOCK, LOCK_SECONDS) is None:
        return

    engine = Engine()
    events.route = engine.route
    engine.port = serve(engine.routes, engine.join)

    with open(ENGINE_STATE, "w") as file:
        json.dump({"port": engine.port, "pid": os.getpid()}, file)

    threading.Thread(target=engine.run, daemon=True).start()

    ending = tray(engine)
    with contextlib.suppress(OSError):
        os.remove(ENGINE_STATE)

    if ending == "restart":
        start([sys.executable, os.path.abspath(__file__)])
    elif ending == "quit":
        engine.end("Voice engine quit; voice mode off.")

    os._exit(0)


if __name__ == "__main__":
    main()
