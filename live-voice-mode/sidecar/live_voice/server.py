"""Localhost HTTP: a session's control routes and its event stream."""

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The header line of the engine's GET /events answer.
MARK = "X-Voice-Engine: 1"


def serve(routes, join):
    """Starts the server on a free localhost port and returns the port.

    POST <path> calls `routes[path](client, body)`, `client` the X-Client header; GET /events answers with MARK and calls `join(handler)`, which holds the stream open.
    """

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/events":
                self.send_response(404)
                return self.end_headers()

            self.send_response(200)
            self.send_header(*MARK.split(": "))
            self.end_headers()
            join(self)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")

            if self.path not in routes:
                self.send_response(404)
            else:
                routes[self.path](self.headers.get("X-Client"), body)
                self.send_response(204)

            self.end_headers()

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    return server.server_address[1]
