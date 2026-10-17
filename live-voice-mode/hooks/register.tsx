import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { VoiceStatus } from '../types'

const PYTHON = 'C:/Users/Mahad/.cache/live-voice-mode/venv/Scripts/python.exe'
const STOP_PHRASE = /^\W*(stop|end|exit) voice mode\W*$/i

const LABELS: Record<VoiceStatus, string> = {
  off: 'off',
  loading: 'loading Whisper…',
  listening: 'listening',
  hearing: 'hearing you…',
  thinking: 'thinking…',
  speaking: 'speaking…',
}

const status = atom({ plugin: 'live-voice-mode', key: 'status' } as const, 'off' as VoiceStatus)
const muted = atom({ plugin: 'live-voice-mode', key: 'muted' } as const, false)
const words = atom({ plugin: 'live-voice-mode', key: 'words' } as const, '')

/** One JSON line the sidecar writes. */
type SidecarEvent =
  | { type: 'ready'; port: number; device: string }
  | { type: 'speech' }
  | { type: 'partial'; text: string }
  | { type: 'heard'; text: string }
  | { type: 'spoken' }
  | { type: 'log'; text: string }

type Sidecar = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/** The running sidecar and its HTTP port, both unset while voice mode is off, and the main loop's running turn. */
const live: { sidecar?: Sidecar; port?: number; turnId?: string } = {}

/** A reply as plain speech: code blocks named, markdown marks dropped. */
const speakable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const setStatus = ($: EngineInterface, next: VoiceStatus) => update($, status, () => next)

/** Sends one request to the sidecar's HTTP server. */
const post = async ($: EngineInterface, path: string, body = '') => {
  if (live.port !== undefined) {
    await $.http.fetch(`http://127.0.0.1:${live.port}${path}`, { method: 'POST', body })
  }
}

/** Submits what was heard as the person's prompt, ending the running turn first. */
const send = async ($: EngineInterface, text: string) => {
  if (live.turnId !== undefined) {
    await $.turn.abort({ turnId: live.turnId }).catch(error => $.ui.log(`Voice turn abort failed: ${error}`, { to: 'debug' }))
  }

  const result = await $.prompt.submit({ text, asUser: true })

  if (result.drop !== undefined) {
    $.ui.toast(`Voice prompt dropped: ${result.drop}`)
  }
}

/** Turns the sidecar's microphone off or on. */
const toggleMute = async ($: EngineInterface) => {
  const next = !(await read($, muted))
  await update($, muted, () => next)
  await post($, next ? '/mute' : '/unmute')
  await update($, words, () => '')
  await update($, status, now => (now === 'hearing' ? 'listening' : now))
}

/** Ends the sidecar and voice mode. */
const stop = async ($: EngineInterface) => {
  void live.sidecar?.return(undefined as never)
  live.sidecar = undefined
  live.port = undefined
  await update($, muted, () => false)
  await update($, words, () => '')
  await setStatus($, 'off')
}

const handle = async ($: EngineInterface, event: SidecarEvent) => {
  switch (event.type) {
    case 'ready':
      live.port = event.port
      $.ui.toast(`Voice mode on (${event.device}). Say "stop voice mode" to end.`)
      return setStatus($, 'listening')
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
        return setStatus($, 'listening')
      }
      await setStatus($, 'thinking')
      void send($, event.text)
      return
    case 'spoken':
      return update($, status, now => (now === 'speaking' ? 'listening' : now))
    case 'log':
      return $.ui.log(event.text, { to: 'debug' })
  }
}

/** Reads the sidecar's output until it exits or voice mode ends. */
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
    argv: [PYTHON, '-u', `${$.plugin.root}/sidecar/voice.py`],
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
        await setStatus($, 'thinking')
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    if (live.turnId === e.turnId) {
      live.turnId = undefined
    }

    if (live.port === undefined) {
      return result
    }

    const text = e.reason === 'answer' ? speakable(e.answer) : ''

    if (text) {
      await setStatus($, 'speaking')
      await post($, '/speak', text)
    } else {
      await setStatus($, 'listening')
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, status)
    const isMuted = await read($, muted)
    const heard = await read($, words)
    const below = await next(e)

    if (now === 'off' || e.props.hasSurvey) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Text color="cyan">Voice: {LABELS[now]}{isMuted && ' (mic muted)'}</Text>
          <Button key="voice-mute" label={isMuted ? 'Unmute' : 'Mute'} hotkey="m" action="app:toggleDiffPreSession" onPress={() => toggleMute($)} />
          <Button key="voice-end" label="End voice" onPress={() => stop($)} />
        </Box>
        {heard && <Text dimColor italic>{heard}</Text>}
      </Box>
    )
  })
}
