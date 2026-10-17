# live-voice-mode

Voice mode for Claude Code, tap to talk or hands-free. `/live-voice` turns it on or off. Keep this file updated and thus correct wrong information.

## Files

| File | What it does |
| --- | --- |
| `hooks/register.tsx` | The mod: `/live-voice`, spawns the sidecar, handles its events, submits what was heard, posts replies to `/speak` and, in progress verbosity, progress lines to `/narrate`, renders the voice panel above the prompt, adds `voice` to the footer modes and the Alt+M shortcut to the hint line. |
| `hooks/voice-panel.tsx` | The panel's `Client` module, drawn twice: `head` (animated glyph, state, recording timer) and `meter` (level bars on its own clock). |
| `hooks/hooks.json` | Lists `register.tsx` as the hooks module. |
| `types/index.d.ts` | `VoiceStatus`, `VoiceMode`, `VoiceVerbosity`, `VoiceLook`, `VoiceLevels` and the mod's state keys: `status`, `mode`, `muted`, `words`, `levels`, `verbosity`. |
| `tests/live-voice-mode.test.ts` | Mod tests against a fake sidecar. |
| `sidecar/voice.py` | Sidecar entry point: builds each part and starts the audio loop. |
| `sidecar/live_voice/config.py` | Sidecar settings: model folders, voice, sample rates, VAD thresholds and frame counts, including `END_FRAMES` (2.5 s of silence ends a hands-free utterance), `MANUAL_MAX_FRAMES` (2 min cap on a tap-to-talk recording), `LEVEL_EVERY`/`LEVEL_FLOOR` (level events), and `NARRATE_SECONDS` (4 s: a progress line still waiting that long is dropped). |
| `sidecar/live_voice/events.py` | `emit`: one JSON event line on stdout. |
| `sidecar/live_voice/detector.py` | `VoiceDetector`: Silero VAD, speech probability per frame. |
| `sidecar/live_voice/transcriber.py` | `Transcriber`: faster-whisper, final text of an utterance and quick partial passes, one pass at a time. |
| `sidecar/live_voice/live_words.py` | `LiveWords`: back-to-back Whisper partial passes over the utterance so far, partial words while speaking. |
| `sidecar/live_voice/speaker.py` | `Speaker`: Kokoro TTS into the playback buffer, answers (`say`) and transient progress lines (`narrate`); `level` is the RMS of the last chunk played. |
| `sidecar/live_voice/audio.py` | `listen`: 48 kHz WASAPI duplex stream, WebRTC echo cancellation, utterance segmentation, manual recordings, barge-in, `level` events. |
| `sidecar/live_voice/server.py` | `serve`: localhost HTTP with `/speak`, `/narrate`, `/stop`, `/mute`, `/unmute`, `/talk`, `/send`, `/cancel`. |
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
   "heard" ─► POST /stop ─► $.prompt.submit (as the user) ─► turn runs
   turn.step (tool call, progress) ─► POST /narrate ─► Speaker (Kokoro) ─► playback
   turn.complete ─► POST /speak ─► Speaker (Kokoro) ─► playback ─► emit "spoken"
```

Speaking while a reply plays stops playback (barge-in), and sending a heard prompt stops any reply still playing. A reply that ends while the person is speaking is not spoken. Saying "stop voice mode" ends it.

## Modes and shortcuts

The panel above the prompt is a rounded border in the state's colour around three rows, a blank row between each:

```
╭──────────────────────────────────────────────────────────────────────────╮
│ ● READY                                                      tap to talk │
│                                                                          │
│ ───────────────────────  press Talk                                      │
│                                                                          │
│ [ Talk ] [ Hands-free ] [ Progress ] [ End voice ]                       │
╰──────────────────────────────────────────────────────────────────────────╯
```

| State | Colour | Header | Meter row |
| --- | --- | --- | --- |
| Loading | gray | spinner `LOADING` | dots, `loading Whisper…` |
| Listening (hands-free) | cyan | breathing `∙•●•` `LISTENING` | mic bars, `say something…`, or `speak to interrupt` while Claude is thinking |
| Hearing (hands-free) | green | ripple `◜◝◞◟` `HEARING` | mic bars, the live words |
| Ready (tap to talk) | cyan | `● READY` | flat line, `press Talk`, or `press Talk to interrupt` while Claude is thinking |
| Recording (tap to talk) | red | blinking `● REC m:ss` | mic bars, the live words |
| Speaking | magenta | `◀ SPEAKING` | playback bars, `reading the reply`; Skip shown |
| Muted | red, dim | `⊘ MUTED` | flat line, `mic is off` |

While Claude is thinking the panel shows the mode's idle look (Listening, Ready or Muted); Claude Code's own spinner above the panel shows the thinking. The header's right side is the mode, with `· mic off` while muted. The live words stay on one line, cut at the front, and clear once sent: on Send in tap to talk, or when the sidecar's `heard` arrives. The footer shows `voice` among the session modes, and the hint line under the prompt ends with the Alt+M shortcut (`alt+m mute`, `alt+m unmute` or `alt+m talk/send`). If a panel `Client` fails on a surface (`ui.fault`), that surface draws the panel without its animated parts.

Buttons: the primary button, Skip (while speaking), the mode button, the verbosity button and End voice.

| Mode | Listening | Primary button (Alt+M) | Mode button |
| --- | --- | --- | --- |
| Tap to talk (default) | Mic ignored except while recording; silence does not end a recording, and one stops at 2 minutes and sends. | Talk starts a recording and stops any reply being spoken; Send sends it. | Hands-free |
| Hands-free | Always on; silence ends an utterance. | Mute / Unmute | Tap to talk |

Voice mode always starts in tap to talk, showing Ready. The sidecar starts with the microphone off; on `ready` the mod posts `/unmute` only when hands-free and not muted. Switching to tap to talk drops any utterance in progress (`/mute`). Switching to hands-free cancels any recording unsent (`/cancel`) and resumes listening (`/unmute`). Ending voice mode resets it to tap to talk.

Skip (band hotkey S while the band has the focus) stops the reply being spoken (`/stop`) and goes back to listening.

The verbosity button switches what is spoken during a turn. Its label names what pressing it switches to: Progress (the default is answer only) or Answer only. In progress verbosity, at each step of the main loop that calls tools, the step's text before its tool calls is spoken; a step with no text speaks a short summary of its tool calls instead, at most one every 5 s (`SUMMARY_MS` in `register.tsx`) and never the same line twice in a row. Nothing is narrated while the person is speaking or recording, or for a turn that is no longer the running one. The panel keeps its thinking-time idle look while progress lines play.

| Tool | Summary |
| --- | --- |
| Read | `reading <file>`, or `reading N files` |
| Edit, Write | `editing <file>`, or `editing N files` |
| Bash | its `description` |
| Grep, Glob | `searching the code` |
| WebSearch, WebFetch | `searching the web` |
| Agent | `starting a subagent` |
| `mcp__<server>__<tool>` | `using <server>`, underscores and dashes as spaces |
| Any other | nothing |

A file is named without its folder or extensions. Several tools in one step are joined with commas, each phrase once.

Alt+M is a Global binding in `~/.claude/keybindings.json`: `"alt+m": "app:toggleDiffPreSession"`, the `action` the primary button carries. The mode and verbosity buttons have no hotkey.

## Events and routes

stdout events: `ready {port, device}`, `speech`, `partial {text}`, `heard {text}`, `spoken`, `level {mic, out}`, `log {text}`.
`level` carries the RMS of the latest VAD frame (`mic`, 0 while muted and not recording) and of the latest chunk played (`out`), checked every `LEVEL_EVERY` frames (about 15 a second) and sent only when either changed; values at or under `LEVEL_FLOOR` are sent as 0, so silence sends nothing.
HTTP: `POST /speak` (body is the text, queued after any speech playing; drops progress lines not yet started), `POST /narrate` (body is a progress line, queued; dropped if a `/speak` or `/stop` comes first or it waits past `NARRATE_SECONDS`; ending one sends no `spoken`), `POST /stop` (drop the speech playing and queued), `POST /mute`, `POST /unmute` (the microphone starts muted), `POST /talk` (start a manual recording), `POST /send` (end it and send it as `heard`), `POST /cancel` (drop it). `/talk`, `/send` and `/cancel` reach the audio loop through a queue.

## Swapping a model

Each model sits behind one object in one module; `sidecar/voice.py` wires them together.

- Final transcript: `Transcriber(path)` with `.device`, `.transcribe(audio) -> str` and `.partial(audio) -> str`, in `transcriber.py`.
- Live words: `LiveWords(transcriber)` with `.add(frame)` per 16 kHz float32 frame and `.end()` per utterance, emitting `partial` from the shared `Transcriber`'s `.partial`, in `live_words.py`; no `partial` for an utterance is emitted once its `.end()` returns.
- Voice: `Speaker(folder)` with `.say(text)`, `.stop()`, `.is_echo()`, `.pull(count)`, `.level`, emitting `spoken`, in `speaker.py`.
- VAD: `VoiceDetector()` called with a frame, returning a probability, in `detector.py`.

Point the model folder in `config.py` at the new model, keep the interface, and change only that module. Constructor arguments are set in `voice.py`. `register.tsx` holds only the venv's Python path.

## Venv setup

The venv has no pip; use `uv`.

```
uv venv --python 3.12 C:\Users\Mahad\.cache\live-voice-mode\venv
uv pip install -r sidecar\requirements.txt --python C:\Users\Mahad\.cache\live-voice-mode\venv\Scripts\python.exe
```

Model folders are listed in `sidecar/live_voice/config.py`.
