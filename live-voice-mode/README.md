# live-voice-mode

Hands-free voice mode for Claude Code. `/live-voice` turns it on or off. Keep this file updated and thus correct wrong information.

## Files

| File | What it does |
| --- | --- |
| `hooks/register.tsx` | The mod: `/live-voice`, spawns the sidecar, handles its events, submits what was heard, posts replies to `/speak`, renders the band above the prompt. |
| `hooks/hooks.json` | Lists `register.tsx` as the hooks module. |
| `types/index.d.ts` | `VoiceStatus` and the mod's state keys: `status`, `muted`, `words`. |
| `tests/live-voice-mode.test.ts` | Mod tests against a fake sidecar. |
| `sidecar/voice.py` | Sidecar entry point: builds each part and starts the audio loop. |
| `sidecar/live_voice/config.py` | Sidecar settings: model folders, voice, sample rates, VAD thresholds and frame counts. |
| `sidecar/live_voice/events.py` | `emit`: one JSON event line on stdout. |
| `sidecar/live_voice/detector.py` | `VoiceDetector`: Silero VAD, speech probability per frame. |
| `sidecar/live_voice/transcriber.py` | `Transcriber`: faster-whisper, final text of an utterance and quick partial passes, one pass at a time. |
| `sidecar/live_voice/live_words.py` | `LiveWords`: back-to-back Whisper partial passes over the utterance so far, partial words while speaking. |
| `sidecar/live_voice/speaker.py` | `Speaker`: Kokoro TTS into the playback buffer. |
| `sidecar/live_voice/audio.py` | `listen`: 48 kHz WASAPI duplex stream, WebRTC echo cancellation, utterance segmentation, barge-in. |
| `sidecar/live_voice/server.py` | `serve`: localhost HTTP with `/speak`, `/mute`, `/unmute`. |
| `sidecar/requirements.txt` | Sidecar packages, pinned. |

## Data flow

```
mic ─► audio.listen ─► echo cancel ─► 16 kHz frames ─► VoiceDetector
                                                        │
                    speech start ── emit "speech" ──────┤
                    each frame ──► LiveWords ── emit "partial"
                    speech end ──► Transcriber ── emit "heard"
                                                        │
register.tsx ◄── stdout JSON lines ─────────────────────┘
   "heard" ─► $.prompt.submit (as the user) ─► turn runs
   turn.complete ─► POST /speak ─► Speaker (Kokoro) ─► playback ─► emit "spoken"
```

Speaking while a reply plays stops playback (barge-in). Saying "stop voice mode" ends it.

## Events and routes

stdout events: `ready {port, device}`, `speech`, `partial {text}`, `heard {text}`, `spoken`, `log {text}`.
HTTP: `POST /speak` (body is the text), `POST /mute`, `POST /unmute`.

## Swapping a model

Each model sits behind one object in one module; `sidecar/voice.py` wires them together.

- Final transcript: `Transcriber(path)` with `.device`, `.transcribe(audio) -> str` and `.partial(audio) -> str`, in `transcriber.py`.
- Live words: `LiveWords(transcriber)` with `.add(frame)` per 16 kHz float32 frame and `.end()` per utterance, emitting `partial` from the shared `Transcriber`'s `.partial`, in `live_words.py`.
- Voice: `Speaker(folder)` with `.say(text)`, `.stop()`, `.is_echo()`, `.pull(count)`, emitting `spoken`, in `speaker.py`.
- VAD: `VoiceDetector()` called with a frame, returning a probability, in `detector.py`.

Point the model folder in `config.py` at the new model, keep the interface, and change only that module. Constructor arguments are set in `voice.py`. `register.tsx` holds only the venv's Python path.

## Venv setup

The venv has no pip; use `uv`.

```
uv venv --python 3.12 C:\Users\Mahad\.cache\live-voice-mode\venv
uv pip install -r sidecar\requirements.txt --python C:\Users\Mahad\.cache\live-voice-mode\venv\Scripts\python.exe
```

Model folders are listed in `sidecar/live_voice/config.py`.
