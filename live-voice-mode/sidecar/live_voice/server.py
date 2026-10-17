"""Localhost HTTP control: /speak, /mute and /unmute."""

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def serve(speaker, muted):
    """Starts the /speak, /mute and /unmute server on a free localhost port and returns the port."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
            actions = {"/speak": lambda: speaker.say(body), "/mute": muted.set, "/unmute": muted.clear}

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
