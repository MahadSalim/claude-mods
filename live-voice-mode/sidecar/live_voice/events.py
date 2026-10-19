"""JSON events: ready, speech, partial, heard, spoken, level, log, taken, loading, end."""

import json
import threading

printing = threading.Lock()

# Takes each event in place of stdout when set.
route = None


def emit(kind, **fields):
    """Hands one event to `route` when set, else writes it as one JSON line to stdout."""
    event = {"type": kind, **fields}

    if route:
        return route(event)

    with printing:
        print(json.dumps(event), flush=True)
