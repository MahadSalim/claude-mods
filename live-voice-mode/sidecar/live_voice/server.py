"""Localhost HTTP control: /speak, /narrate, /stop, /mute, /unmute, /talk, /send and /cancel."""

import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def serve(speaker, muted, requests):
    """Starts the control server on a free localhost port and returns the port; /talk, /send and /cancel go onto `requests` by name."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
            actions = {
                "/speak": lambda: speaker.say(body),
                "/narrate": lambda: speaker.narrate(body),
                "/stop": speaker.stop,
                "/mute": muted.set,
                "/unmute": muted.clear,
                **{f"/{name}": partial(requests.put, name) for name in ("talk", "send", "cancel")},
            }

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
