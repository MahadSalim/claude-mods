import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, TurnStepToolUse } from 'claude-code'

import type { VoiceLevels, VoiceLook, VoiceMode, VoiceStatus, VoiceVerbosity } from '../types'

const PYTHON = 'C:/Users/Mahad/.cache/live-voice-mode/venv/Scripts/python.exe'
const STOP_PHRASE = /^\W*(stop|end|exit) voice mode\W*$/i

/** Least ms between two spoken tool summaries. */
const SUMMARY_MS = 5000

/** The spoken verb of each tool a summary names; file tools add the file's name. */
const VERBS: Record<string, string> = {
  Read: 'reading',
  Edit: 'editing',
  Write: 'editing',
  Grep: 'searching the code',
  Glob: 'searching the code',
  WebSearch: 'searching the web',
  WebFetch: 'searching the web',
  Agent: 'starting a subagent',
}

/** Each panel look's colour, header state, the dim line beside the meter, and that line while Claude is thinking. */
const LOOKS: Record<VoiceLook, { color: string; title: string; hint: string; busy?: string }> = {
  loading: { color: 'gray', title: 'LOADING', hint: 'loading Whisper…' },
  listening: { color: 'cyan', title: 'LISTENING', hint: 'say something…', busy: 'speak to interrupt' },
  ready: { color: 'cyan', title: 'READY', hint: 'press Talk', busy: 'press Talk to interrupt' },
  hearing: { color: 'green', title: 'HEARING', hint: '…' },
  rec: { color: 'red', title: 'REC', hint: '…' },
  speaking: { color: 'magenta', title: 'SPEAKING', hint: 'reading the reply' },
  muted: { color: 'red', title: 'MUTED', hint: 'mic is off' },
}

const status = atom({ plugin: 'live-voice-mode', key: 'status' } as const, 'off' as VoiceStatus)
const mode = atom({ plugin: 'live-voice-mode', key: 'mode' } as const, 'tapToTalk' as VoiceMode)
const muted = atom({ plugin: 'live-voice-mode', key: 'muted' } as const, false)
const words = atom({ plugin: 'live-voice-mode', key: 'words' } as const, '')
const levels = atom({ plugin: 'live-voice-mode', key: 'levels' } as const, { mic: 0, out: 0 } as VoiceLevels)
const verbosity = atom({ plugin: 'live-voice-mode', key: 'verbosity' } as const, 'answer' as VoiceVerbosity)

/** One JSON line the relay writes. */
type SidecarEvent =
  | { type: 'ready'; port: number; device: string; client: string }
  | { type: 'loading' }
  | { type: 'taken' }
  | { type: 'end'; text: string }
  | { type: 'speech' }
  | { type: 'partial'; text: string }
  | { type: 'heard'; text: string }
  | { type: 'spoken'; lines?: number }
  | { type: 'level'; mic: number; out: number }
  | { type: 'log'; text: string }

type Sidecar = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/** The running relay, the engine's HTTP port and this session's client id there, all unset while voice mode is off, the /speak lines posted as that client, and the main loop's running turn. */
const live: { sidecar?: Sidecar; port?: number; client?: string; lines: number; turnId?: string } = { lines: 0 }

/** Surfaces where a panel Client failed. */
const faulted = new Set<string>()

/** Columns the panel's meter takes, and its border and padding. */
const METER_COLUMNS = 23
const FRAME_COLUMNS = 4

/** The last `room` characters of `text`, an ellipsis in front when cut. */
const clip = (text: string, room: number) => (text.length > room ? `…${text.slice(text.length - room + 1)}` : text)

/** Inline code that reads as a path, a flag or an expression rather than words. */
const CODE = /[\\/.()[\]{}<>=$;|&~]|(^|\s)-/

/** A reply as plain speech: code blocks, inline code matching CODE and markdown marks dropped. */
const speakable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, (_, code: string) => (CODE.test(code) ? ' ' : code))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ (?=[,.!?:;])/g, '')
    .trim()

/** A sentence or line end, and for a step's first phrase in progress verbosity also a comma or its first eight words. */
const SENTENCE_END = /[.!?]\s|\n/g
const PAUSE = /[,.!?]\s|\n|^(\S+\s+){8}/g

/** How much of `text` makes whole phrases: up to its last `pause` outside a code block, 0 when none. */
const cut = (text: string, pause: RegExp) =>
  Math.max(0, ...[...text.matchAll(pause)].map(match => match.index + match[0].length).filter(end => text.slice(0, end).split('```').length % 2))

const setStatus = ($: EngineInterface, next: VoiceStatus) => update($, status, () => next)

/** The status between utterances: thinking while the main loop's turn runs, else listening. */
const idle = (): VoiceStatus => (live.turnId === undefined ? 'listening' : 'thinking')

/** Sets the status to `next` while it is speaking. */
const quiet = ($: EngineInterface, next: VoiceStatus) => update($, status, now => (now === 'speaking' ? next : now))

/** Sends one request to the engine's HTTP server as this session. */
const post = async ($: EngineInterface, path: string, body = '') => {
  if (live.port !== undefined) {
    await $.http.fetch(`http://127.0.0.1:${live.port}${path}`, { method: 'POST', body, headers: { 'X-Client': live.client ?? '' } })
  }
}

/** Shows Speaking and posts `text` to /speak, counted in live.lines. */
const speak = async ($: EngineInterface, text: string) => {
  live.lines += 1
  await setStatus($, 'speaking')
  await post($, '/speak', text).catch(error => {
    live.lines -= 1
    $.ui.log(`Voice speech failed: ${error}`, { to: 'debug' })
  })
}

/** The last progress line spoken, and when the last tool summary was. */
const told = { line: '', at: -Infinity }

/** The main loop's step as it streams: its text, how much of it was posted to /speak, and whether its speech was ended. */
const said = { text: '', sent: 0, ended: false }

/** Whether speech of `turnId` may start: it is the main loop's running turn, the sidecar is up and the person is not speaking. */
const audible = async ($: EngineInterface, turnId: string) => turnId === live.turnId && live.port !== undefined && (await read($, status)) !== 'hearing'

/** Posts the step's next `end` characters to /speak as one phrase, unless its speech was ended or `turnId` is not audible. */
const utter = async ($: EngineInterface, turnId: string, end: number) => {
  const text = speakable(said.text.slice(said.sent, said.sent + end))

  if (!text || said.ended || !(await audible($, turnId))) {
    return
  }

  said.sent += end
  await speak($, text)
}

/** A tool use as its spoken verb and, for a file tool, the file's name without its extensions. */
const phrase = ({ name, input }: TurnStepToolUse): [string?, string?] => {
  const { file_path, description } = (input ?? {}) as { file_path?: string; description?: string }
  const server = /^mcp__(.+?)__/.exec(name)?.[1]

  return name === 'Bash' ? [description] : server ? [`using ${server.replace(/[_-]+/g, ' ')}`] : [VERBS[name], file_path?.split(/[\\/]/).pop()?.replace(/(?<=.)\..*$/, '')]
}

/** A step's tool uses as one spoken line: each verb once, with its file, or a count of several files. */
const summary = (uses: readonly TurnStepToolUse[]) => {
  const groups = new Map<string, Set<string>>()

  for (const [verb, file] of uses.map(phrase)) {
    if (verb) {
      groups.set(verb, (groups.get(verb) ?? new Set()).add(file ?? ''))
    }
  }

  return [...groups]
    .map(([verb, files]) => {
      const named = [...files].filter(Boolean)
      return named.length > 1 ? `${verb} ${named.length} files` : [verb, ...named].join(' ')
    })
    .join(', ')
}

/** Speaks a progress line of the main loop's running turn in progress verbosity; a tool summary at most once per SUMMARY_MS. */
const narrate = async ($: EngineInterface, turnId: string, line: string, isSummary: boolean) => {
  if (!line || line === told.line || !(await audible($, turnId)) || (await read($, verbosity)) === 'answer') {
    return
  }

  const now = await $.clock.now()

  if (isSummary && now - told.at < SUMMARY_MS) {
    return
  }

  told.line = line
  told.at = isSummary ? now : told.at
  await post($, '/narrate', line).catch(error => $.ui.log(`Voice narration failed: ${error}`, { to: 'debug' }))
}

/** Submits what was heard as the person's prompt, ending the reply being spoken and the running turn first. */
const send = async ($: EngineInterface, text: string) => {
  const turnId = live.turnId
  live.turnId = undefined
  await post($, '/stop')

  if (turnId !== undefined) {
    await $.turn.abort({ turnId }).catch(error => $.ui.log(`Voice turn abort failed: ${error}`, { to: 'debug' }))
  }

  const result = await $.prompt.submit({ text, asUser: true })

  if (result.drop !== undefined) {
    $.ui.toast(`Voice prompt dropped: ${result.drop}`)
    await update($, status, now => (now === 'thinking' ? idle() : now))
  }
}

/** Posts each path in order, then clears any utterance in progress from the band. */
const drop = async ($: EngineInterface, paths: string[]) => {
  for (const path of paths) {
    await post($, path)
  }
  await update($, words, () => '')
  await update($, status, now => (now === 'hearing' ? idle() : now))
}

/** Turns the sidecar's microphone off or on. */
const toggleMute = async ($: EngineInterface) => {
  const next = !(await read($, muted))
  await update($, muted, () => next)
  await drop($, [next ? '/mute' : '/unmute'])
}

/** Switches between hands-free and tap to talk. */
const toggleMode = async ($: EngineInterface) => {
  const next: VoiceMode = (await read($, mode)) === 'handsFree' ? 'tapToTalk' : 'handsFree'
  await update($, mode, () => next)
  await update($, muted, () => false)
  await drop($, next === 'tapToTalk' ? ['/mute'] : ['/cancel', '/unmute'])
}

/** The primary button's label: Mute/Unmute when hands-free, Talk/Send in tap to talk. */
const primaryLabel = (now: VoiceStatus, isMuted: boolean, tap: boolean) => (tap ? (now === 'hearing' ? 'Send' : 'Talk') : isMuted ? 'Unmute' : 'Mute')

/** The hint line's shortcuts. */
const shortcuts = (isMuted: boolean, tap: boolean) => `alt+m ${tap ? 'talk/send' : isMuted ? 'unmute' : 'mute'}`

/** What the panel shows for a status; thinking shows the mode's idle look. */
const lookOf = (now: Exclude<VoiceStatus, 'off'>, isMuted: boolean, tap: boolean): VoiceLook =>
  now === 'listening' || now === 'thinking' ? (isMuted ? 'muted' : tap ? 'ready' : 'listening') : now === 'hearing' && tap ? 'rec' : now

/** Ends the reply being spoken and the rest of its step's speech, the status going from speaking to idle. */
const skip = async ($: EngineInterface) => {
  said.ended = true
  await post($, '/stop')
  await quiet($, idle())
}

/** Switches between speaking only the answer and speaking progress lines too. */
const toggleVerbosity = ($: EngineInterface) => update($, verbosity, now => (now === 'answer' ? 'progress' : 'answer'))

/** The primary button: Mute/Unmute when hands-free, Talk/Send in tap to talk. */
const press = async ($: EngineInterface) => {
  if ((await read($, mode)) === 'handsFree') {
    return toggleMute($)
  }
  if (live.port === undefined) {
    return
  }

  const recording = (await read($, status)) === 'hearing'
  if (recording) {
    await update($, words, () => '')
  }
  await setStatus($, recording ? 'thinking' : 'hearing')
  await post($, recording ? '/send' : '/talk')
}

/** Ends the relay and voice mode. */
const stop = async ($: EngineInterface) => {
  void live.sidecar?.return(undefined as never)
  live.sidecar = undefined
  live.port = undefined
  live.client = undefined
  Object.assign(told, { line: '', at: -Infinity })
  await update($, mode, () => 'tapToTalk')
  await update($, muted, () => false)
  await update($, words, () => '')
  await update($, levels, () => ({ mic: 0, out: 0 }))
  await setStatus($, 'off')
}

const handle = async ($: EngineInterface, event: SidecarEvent) => {
  switch (event.type) {
    case 'ready':
      if (live.client === undefined) {
        $.ui.toast(`Voice mode on (${event.device}). Say "stop voice mode" to end.`)
      }
      live.port = event.port
      live.client = event.client
      live.lines = 0
      if (!(await read($, muted)) && (await read($, mode)) === 'handsFree') {
        await post($, '/unmute')
      }
      return setStatus($, idle())
    case 'loading':
      live.port = undefined
      await update($, words, () => '')
      return setStatus($, 'loading')
    case 'taken':
      $.ui.toast('Another session took the microphone.')
      await update($, mode, () => 'tapToTalk')
      await update($, muted, () => false)
      return drop($, [])
    case 'end':
      $.ui.toast(event.text)
      return stop($)
    case 'speech':
      await update($, words, () => '')
      return setStatus($, 'hearing')
    case 'partial':
      if ((await read($, status)) === 'hearing') {
        await update($, words, () => event.text)
      }
      return
    case 'heard':
      await update($, words, () => '')
      if (STOP_PHRASE.test(event.text)) {
        return stop($)
      }
      if (!event.text) {
        return setStatus($, idle())
      }
      await setStatus($, 'thinking')
      void send($, event.text)
      return
    case 'spoken':
      return live.turnId === undefined && (event.lines ?? live.lines) >= live.lines ? quiet($, 'listening') : undefined
    case 'level':
      return update($, levels, () => ({ mic: event.mic, out: event.out }))
    case 'log':
      return $.ui.log(event.text, { to: 'debug' })
  }
}

/** Reads the relay's output until it exits or voice mode ends. */
const pump = async ($: EngineInterface, sidecar: Sidecar) => {
  let buffer = ''

  try {
    for await (const { stream, text } of sidecar) {
      if (stream === 'stderr') {
        $.ui.log(text, { to: 'debug' })
        continue
      }

      const lines = (buffer + text).split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines.filter(line => line.trim())) {
        await handle($, JSON.parse(line))
      }
    }
  } catch (error) {
    $.ui.toast(`Voice mode failed: ${error}`)
  }

  if (live.sidecar === sidecar) {
    await stop($)
  }
}

const start = async ($: EngineInterface) => {
  await setStatus($, 'loading')
  live.sidecar = $.process.spawn({
    argv: [PYTHON, '-u', `${$.plugin.root}/sidecar/relay.py`],
  })
  void pump($, live.sidecar)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'live-voice', description: 'Turn live voice mode on or off' })
    await setStatus($, 'off')

    return next(e)
  })

  on('command.run', { command: 'live-voice' }, async $ => {
    if (live.sidecar) {
      await stop($)

      return { text: 'Voice mode off.' }
    }

    await start($)

    return { text: 'Voice mode starting…' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      live.turnId = e.turnId

      if (live.port !== undefined) {
        await update($, status, now => (now === 'hearing' ? now : 'thinking'))
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    const stream = next(e)
    let spoke = false
    Object.assign(said, { text: '', sent: 0, ended: false })

    for await (const chunk of stream) {
      yield chunk

      if (chunk.kind === 'text') {
        said.text += chunk.text
        await utter($, e.turnId, cut(said.text.slice(said.sent), !said.sent && (await read($, verbosity)) === 'progress' ? PAUSE : SENTENCE_END))
      } else if (chunk.kind === 'tool' && !spoke && speakable(said.text)) {
        spoke = true

        if (!said.sent) {
          await narrate($, e.turnId, speakable(said.text), false)
        } else if ((await read($, verbosity)) === 'answer') {
          await skip($).catch(error => $.ui.log(`Voice stop failed: ${error}`, { to: 'debug' }))
        } else {
          await utter($, e.turnId, said.text.length - said.sent)
          await quiet($, 'thinking')
        }
      }
    }

    const result = await stream.result
    const text = speakable(said.text)

    if (!spoke && result.stopReason === 'tool_use') {
      await narrate($, e.turnId, text || summary(result.toolUses), !text)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    if (live.turnId === e.turnId) {
      live.turnId = undefined
    }

    if (live.port === undefined || (await read($, status)) === 'hearing') {
      return result
    }

    const going = e.reason === 'answer' && !said.ended
    const text = going ? speakable(said.sent ? said.text.slice(said.sent) : e.answer) : ''

    if (text || (going && said.sent)) {
      await speak($, text)
    } else {
      await setStatus($, idle())
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, status)
    const isMuted = await read($, muted)
    const tap = (await read($, mode)) === 'tapToTalk'
    const heard = await read($, words)
    const progress = (await read($, verbosity)) === 'progress'
    const below = await next(e)

    if (now === 'off' || e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return below
    }

    const { Box, Button, Client, Text } = $.ui.resolve(e)
    const look = lookOf(now, isMuted, tap)
    const { color, title, hint, busy } = LOOKS[look]
    const animated = !faulted.has(e.surface)

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="column" rowGap={1} borderStyle="round" borderColor={color} borderDimColor={look === 'muted'} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            {animated ? <Client key="voice-head" module="./voice-panel.tsx" props={{ part: 'head', look, color, title }} /> : <Text color={color} bold>{title}</Text>}
            <Text dimColor>{tap ? 'tap to talk' : 'hands-free'}{isMuted && ' · mic off'}</Text>
          </Box>
          <Box flexDirection="row" columnGap={2}>
            {animated && <Client key="voice-meter" module="./voice-panel.tsx" props={{ part: 'meter', look, color, ...(await read($, levels)) }} />}
            <Text dimColor italic={!!heard}>{clip(heard || (now === 'thinking' && busy) || hint,e.props.bodyColumns - FRAME_COLUMNS - (animated ? METER_COLUMNS + 2 : 0))}</Text>
          </Box>
          <Box flexDirection="row" columnGap={1}>
            <Button key="voice-mute" label={primaryLabel(now, isMuted, tap)} hotkey="m" action="app:toggleDiffPreSession" onPress={() => press($)} />
            {now === 'speaking' && <Button key="voice-skip" label="Skip" hotkey="s" onPress={() => skip($)} />}
            <Button key="voice-mode" label={tap ? 'Hands-free' : 'Tap to talk'} onPress={() => toggleMode($)} />
            <Button key="voice-verbosity" label={progress ? 'Answer only' : 'Progress'} onPress={() => toggleVerbosity($)} />
            <Button key="voice-end" label="End voice" onPress={() => stop($)} />
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) =>
    next((await read($, status)) === 'off' ? e : { ...e, props: { ...e.props, modes: [...e.props.modes, 'voice'] } }),
  )

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if ((await read($, status)) === 'off') {
      return next(e)
    }

    const tail = shortcuts(await read($, muted), (await read($, mode)) === 'tapToTalk')

    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${tail}` : tail } })
  })

  on('ui.fault', async ($, e, next) => {
    faulted.add(e.surface)
    $.ui.log(`Voice panel failed on ${e.surface} (${e.phase}): ${e.reason}`, { to: 'debug' })

    return next(e)
  })
}
