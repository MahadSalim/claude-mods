"""JSON event lines on stdout: ready, speech, partial, heard, spoken, log."""

import json
import threading

printing = threading.Lock()


def emit(kind, **fields):
    """Writes one JSON event line to stdout."""
    with printing:
        print(json.dumps({"type": kind, **fields}), flush=True)
