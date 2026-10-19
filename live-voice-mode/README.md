# live-voice-mode

Voice mode for Claude Code, tap to talk or hands-free. `/live-voice` turns it on or off. Keep this file updated and thus correct wrong information.

## Files

| File | What it does |
| --- | --- |
| `hooks/register.tsx` | The mod: `/live-voice`, spawns the relay, handles its events, posts to the engine as this session (`X-Client`), submits what was heard, posts replies to `/speak` phrase by phrase as they stream and, in progress verbosity, progress lines to `/narrate`, renders the voice panel above the prompt, adds `voice` to the footer modes and the Alt+M shortcut to the hint line. |
| `hooks/voice-panel.tsx` | The panel's `Client` module, drawn twice: `head` (animated glyph, state, recording timer) and `meter` (level bars on its own clock). |
| `hooks/hooks.json` | Lists `register.tsx` as the hooks module. |
| `types/index.d.ts` | `VoiceStatus`, `VoiceMode`, `VoiceVerbosity`, `VoiceLook`, `VoiceLevels` and the mod's state keys: `status`, `mode`, `muted`, `words`, `levels`, `verbosity`. |
| `tests/live-voice-mode.test.ts` | Mod tests against a fake relay. |
| `tests/test_engine.py` | Engine routing, the single-instance lock, the relay and per-session `spoken`, with fakes: no models, no audio. |
| `sidecar/engine.py` | The shared engine, one per machine: loads the models, owns the microphone and speaker, serves every session over localhost HTTP, routes each event to its session, shows the tray icon. |
| `sidecar/relay.py` | One session's link to the engine, stdlib only: starts the engine when none answers, holds its event stream, writes the events on stdout, and dies with the session. |
| `sidecar/live_voice/config.py` | Sidecar settings: model folders, voice, `HOTWORDS` (words Whisper is biased towards: Claude, Claude Code), the engine's lock, state and log files, `LOCK_SECONDS`/`START_SECONDS`, sample rates, VAD thresholds and frame counts, including `END_FRAMES` (2.5 s of silence ends a hands-free utterance), `MANUAL_MAX_FRAMES` (2 min cap on a tap-to-talk recording), `LEVEL_EVERY`/`LEVEL_FLOOR` (level events), and `NARRATE_SECONDS` (4 s: a progress line still waiting that long is dropped). |
| `sidecar/live_voice/events.py` | `emit`: one event, handed to `route` when set (the engine's router) or written as one JSON line on stdout (the relay). |
| `sidecar/live_voice/launch.py` | `start`: a process detached, windowless and out of every job object, or through WMI `Win32_Process.Create` when it stays in one; `hold`, the single-instance lock, and `free`, whether no one holds it. |
| `sidecar/live_voice/detector.py` | `VoiceDetector`: Silero VAD, speech probability per frame. |
| `sidecar/live_voice/transcriber.py` | `Transcriber`: faster-whisper, final text of an utterance and quick partial passes, one pass at a time, both with `HOTWORDS`. |
| `sidecar/live_voice/live_words.py` | `LiveWords`: back-to-back Whisper partial passes over the utterance so far, partial words while speaking. |
| `sidecar/live_voice/speaker.py` | `Speaker`: Kokoro TTS into the playback buffer, answers (`say`) and transient progress lines (`narrate`), each of a session; `client` is the session whose line is playing, `level` the RMS of the last chunk played. |
| `sidecar/live_voice/audio.py` | `listen`: 48 kHz WASAPI duplex stream while any session is connected, WebRTC echo cancellation, utterance segmentation, manual recordings, barge-in, `level` events. |
| `sidecar/live_voice/server.py` | `serve`: localhost HTTP, POST routes called with the `X-Client` header's session, and `GET /events`, a session's event stream, answered with the `X-Voice-Engine: 1` header (`MARK`). |
| `sidecar/requirements.txt` | Sidecar packages, pinned. |

## Data flow

```
mic ─► audio.listen ─► echo cancel ─► 16 kHz frames ─► VoiceDetector
                                                        │
                    speech start ── emit "speech" ──────┤
                    each frame ──► LiveWords ── emit "partial"
                    speech end ──► Transcriber ── emit "heard"
                                                        │
engine.route ── to the session the event belongs to ◄───┘
   │  GET /events (one stream per session)
relay.py ── stdout JSON lines ─► register.tsx
   "heard" ─► POST /stop ─► $.prompt.submit (as the user) ─► turn runs
   turn.step (text chunk, phrase done) ─► POST /speak ─► Speaker (Kokoro) ─► playback
   turn.step (tool call, answer only, text streamed) ─► POST /stop
   turn.step (tool call, progress) ─► POST /narrate ─► Speaker (Kokoro) ─► playback
   turn.complete ─► POST /speak (the rest, or the whole answer if none streamed) ─► emit "spoken"
```

A main-loop step's text is spoken as it streams. The first phrase goes to `/speak` at the first comma, sentence end or line end, or after eight words; each later one at a sentence or line end (`cut`, `PAUSE` and `SENTENCE_END` in `register.tsx`). A cut never falls inside an open ``` code block, and `speakable` drops a block whole, so nothing of it is spoken. Each phrase goes through `speakable` first. At `turn.complete` only the text not yet posted goes to `/speak`, even when it is empty, so the engine's `spoken` comes once the whole reply has played; a reply with nothing streamed is posted whole. `spoken` is ignored while the main loop's turn runs, so the panel stays Speaking between phrases.

Speaking while a reply plays stops playback (barge-in), and sending a heard prompt stops any reply still playing. Phrases are held while the person is speaking or recording; a reply that ends while the person is speaking is not spoken. Saying "stop voice mode" ends it.

## Shared engine

One engine per machine holds Whisper, Kokoro, the VAD, the microphone and the speaker; every session's voice mode goes through it. Each request the mod posts carries its session's client id (from `ready`) in the `X-Client` header.

- **Start.** `/live-voice` spawns `relay.py`. While an engine holds `engine.lock`, the relay attaches to the port in `engine.json`, waiting for it to answer; when no engine holds the lock, it starts `engine.py` once with the venv's `pythonw.exe` through `launch.start` (detached, new process group, broken away from the job; if it is still in a job, it is killed and started through WMI instead), then waits up to `START_SECONDS` in all for an engine to answer. The panel shows Loading until the engine's `ready`.
- **Single instance.** The engine locks `engine.lock` for its life (waiting up to `LOCK_SECONDS`) before anything else, and exits at once when another engine holds it; then it writes `engine.json` (`port`, `pid`), and deletes it on exit. A state file left by a dead engine is stale: the lock is free, so the relay starts a new engine, which takes the lock and rewrites the file; a port that does not answer with `MARK` (nothing listens, or another program does) is never taken for the engine.
- **Lifetime.** `/live-voice` again, End voice or the stop phrase ends only that session's relay; the engine sees its stream close. The engine keeps the models loaded and does not exit on its own: it ends on the tray's Quit, or when loading the models or running the audio fails (each session gets `end`, so its voice mode turns off with a toast); either way the tray icon is removed before the engine exits.
- **Microphone.** The audio stream is open only while at least one session is connected; the last one leaving closes it, ends any speech and drops queued requests.
- **Restart** (tray) starts a new engine and exits. Each relay sees its stream end, writes `loading` (the panel shows Loading and posts nothing), reconnects to the new engine without starting another, and passes on the new engine's `ready`; the mod posts `/unmute` again when hands-free and not muted. A relay whose stream ends before `ready` writes `end`.

Tray icon (pystray, on the engine's main thread; its colour is the state, redrawn when the sessions, the microphone's holder or `Speaker.busy` change): right-click shows a disabled status line, `Voice engine: <loading|ready|listening|speaking>, N sessions`, then Restart and Quit. The engine writes its errors to `engine.log`; a log over 1 MB (`LOG_BYTES` in `engine.py`) is moved to `engine.log.old` when an engine starts.

Routing between sessions:

| What | Goes to |
| --- | --- |
| `speech`, `partial`, `heard` | The session holding the microphone when the utterance's `speech` came; the rest of an utterance is dropped once another session takes the microphone. |
| The `mic` of `level` | The session holding the microphone. |
| `spoken`, the `out` of `level` | The session whose speech is playing (`Speaker.client`); each session gets `spoken` once its own lines end, even when another session's line follows. |
| `log` | Every session, and `engine.log`. |
| `taken` | The session that held the microphone, when another takes it. |

One session holds the microphone at a time. `/unmute` (hands-free) and `/talk` (a tap-to-talk recording) take it; the session that had it gets `taken` and its recording or utterance is dropped, and its panel goes back to tap to talk, Ready, with a toast. `/mute` frees it when its session is hands-free, `/cancel` when its session is recording, and a recording frees it once `heard` is sent; `/mute`, `/send` and `/cancel` from any other session do nothing. A session that disconnects frees the microphone, dropping its recording or utterance, and stops its speech playing. `/speak` and `/narrate` queue speech of the posting session; `/stop` from any session stops all speech, since there is one voice.

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

While Claude is thinking the panel shows the mode's idle look (Listening, Ready or Muted); Claude Code's own spinner above the panel shows the thinking. The header's right side is the mode, with `· mic off` while muted. The live words stay on one line, cut at the front, and clear once sent: on Send in tap to talk, or when the engine's `heard` arrives. The footer shows `voice` among the session modes, and the hint line under the prompt ends with the Alt+M shortcut (`alt+m mute`, `alt+m unmute` or `alt+m talk/send`). If a panel `Client` fails on a surface (`ui.fault`), that surface draws the panel without its animated parts.

Buttons: the primary button, Skip (while speaking), the mode button, the verbosity button and End voice.

| Mode | Listening | Primary button (Alt+M) | Mode button |
| --- | --- | --- | --- |
| Tap to talk (default) | Mic ignored except while recording; silence does not end a recording, and one stops at 2 minutes and sends. | Talk starts a recording and stops any reply being spoken; Send sends it. | Hands-free |
| Hands-free | Always on; silence ends an utterance. | Mute / Unmute | Tap to talk |

Voice mode always starts in tap to talk, showing Ready. Each session starts with its microphone off; on `ready` the mod posts `/unmute` only when hands-free and not muted. Switching to tap to talk drops any utterance in progress (`/mute`). Switching to hands-free cancels any recording unsent (`/cancel`) and resumes listening (`/unmute`). Ending voice mode resets it to tap to talk.

Skip (band hotkey S while the band has the focus) stops the reply being spoken (`/stop`), and the rest of a reply still streaming, and goes back to listening.

The verbosity button switches what is spoken during a turn. Its label names what pressing it switches to: Progress (the default is answer only) or Answer only. A step's text streams to `/speak` in both; once the step calls a tool, that text was progress. In answer only, the streamed text is stopped (`/stop`) and the step streams no more. In progress verbosity, at each step of the main loop that calls tools, the step's text before its tool calls is spoken once: the rest of it goes to `/speak` when it had begun streaming, and to `/narrate` when it had not; a step with no text speaks a short summary of its tool calls instead, at most one every 5 s (`SUMMARY_MS` in `register.tsx`) and never the same line twice in a row. Nothing is narrated while the person is speaking or recording, or for a turn that is no longer the running one. The panel shows Speaking from a step's first streamed phrase; once the step calls a tool it goes back to its thinking-time idle look, which it keeps while progress lines play.

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

Relay stdout events: `ready {port, device, client}` (the engine's port and this session's client id), `speech`, `partial {text}`, `heard {text}`, `spoken`, `level {mic, out}`, `log {text}`, `taken` (another session took the microphone), `loading` (the engine restarted; reconnecting), `end {text}` (the engine quit, failed or did not start; voice mode turns off with `text` as a toast).
`level` carries the RMS of the latest VAD frame (`mic`, 0 while muted and not recording) and of the latest chunk played (`out`), checked every `LEVEL_EVERY` frames (about 15 a second) and sent only when either changed; values at or under `LEVEL_FLOOR` are sent as 0, so silence sends nothing.
HTTP, each POST with the session's `X-Client` header: `GET /events` (the session's event stream, held open by the relay), `POST /speak` (body is the text, queued after any speech playing; drops progress lines not yet started), `POST /narrate` (body is a progress line, queued; dropped if a `/speak` or `/stop` comes first or it waits past `NARRATE_SECONDS`; ending one sends no `spoken`), `POST /stop` (drop all speech playing and queued, every session's), `POST /mute`, `POST /unmute` (hands-free; the microphone starts muted), `POST /talk` (start a manual recording), `POST /send` (end it and send it as `heard`), `POST /cancel` (drop it); which session each one acts for is under Routing between sessions. `/talk`, `/send` and `/cancel` reach the audio loop through a queue.

## Swapping a model

Each model sits behind one object in one module; `Engine.run` in `sidecar/engine.py` wires them together.

- Final transcript: `Transcriber(path)` with `.device`, `.transcribe(audio) -> str` and `.partial(audio) -> str`, in `transcriber.py`.
- Live words: `LiveWords(transcriber)` with `.add(frame)` per 16 kHz float32 frame and `.end()` per utterance, emitting `partial` from the shared `Transcriber`'s `.partial`, in `live_words.py`; no `partial` for an utterance is emitted once its `.end()` returns.
- Voice: `Speaker(folder)` with `.say(text, client)`, `.narrate(text, client)`, `.client`, `.busy`, `.stop()`, `.is_echo()`, `.pull(count)`, `.level`, emitting `spoken`, in `speaker.py`.
- VAD: `VoiceDetector()` called with a frame, returning a probability, in `detector.py`.

Point the model folder in `config.py` at the new model, keep the interface, and change only that module. Constructor arguments are set in `engine.py`. `register.tsx` holds only the venv's Python path. A running engine keeps the old code until the tray's Restart.

## Venv setup

The venv has no pip; use `uv`. The relay runs with the venv's `python.exe`, the engine with the `pythonw.exe` beside it; pystray and Pillow draw the tray icon.

```
uv venv --python 3.12 C:\Users\Mahad\.cache\live-voice-mode\venv
uv pip install -r sidecar\requirements.txt --python C:\Users\Mahad\.cache\live-voice-mode\venv\Scripts\python.exe
```

Model folders are listed in `sidecar/live_voice/config.py`. The engine's tests run with the venv's Python, no models or audio:

```
C:\Users\Mahad\.cache\live-voice-mode\venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
```
