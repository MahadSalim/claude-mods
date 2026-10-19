import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

const NAME = 'live-voice-mode'
const SITE = { scroll: { offset: 0, bodyRows: 20 }, view: {} }
const BAND = { plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, ...SITE } } as const
const DONE = { value: undefined }
const DROPPED = 'never mind'

type Band = Mounted<'terminal', 'AbovePrompt'>

declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const line = (event: object) => `${JSON.stringify(event)}\n`
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

/** Answers the calls the mod makes beneath it, with a relay that writes `lines` and waits for each of `gates` before the matching one of its last lines. */
const world = (on: On, lines: string[], ...gates: Promise<void>[]) => {
  const submitted: string[] = []
  const spoken: string[] = []
  const aborted: string[] = []
  const clients: string[] = []
  const toasts: string[] = []
  const argv: string[] = []
  on('ui.toast', ($, e) => (toasts.push(e.text), DONE))
  on('ui.log', () => DONE)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('process.spawn', async function* ($, e) {
    argv.push(...e.argv)
    for (const [index, text] of lines.entries()) {
      await gates[index - lines.length + gates.length]
      yield { stream: 'stdout' as const, text }
    }

    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => (submitted.push(e.text), e.text === DROPPED ? { drop: 'busy' } : { text: e.text }))
  on('http.fetch', ($, e) => (spoken.push(`${e.url} ${e.init?.body}`), clients.push(e.init?.headers?.['X-Client'] ?? ''), { value: { status: 204, ok: true, headers: {}, text: '' } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.abort', ($, e) => (aborted.push(e.turnId), DONE))

  return { submitted, spoken, aborted, clients, toasts, argv }
}

/** A gate a fake relay waits on, and a call that opens it and lets the mod settle. */
const gate = () => {
  let release = () => {}
  return { opened: new Promise<void>(resolve => (release = resolve)), open: () => (release(), settle()) }
}

/** Turns voice mode on and mounts the band on `surface`. */
const begin = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  await $.command.run({ command: 'live-voice', args: '' } as never)
  await settle()
  const band: Band = await $.ui.mount({ ...BAND, surface } as typeof BAND)

  return band
}

/** The panel as drawn, read in one act: border colour and row gap, header state, mode, line beside the meter, any further text, and button labels. */
const view = async (band: Band) => {
  const all = await band.findAll({})
  const of = (type: string) => all.filter(element => element.type === type)
  const frame = of('Box').find(box => box.props.borderStyle === 'round')
  const [mode, hint, ...rest] = of('Text').map(element => element.text)

  return {
    border: frame?.props.borderColor,
    gap: frame?.props.rowGap,
    title: (all.find(element => element.key === 'voice-head')?.props.props as { title: string } | undefined)?.title,
    mode,
    hint,
    rest,
    buttons: of('Button').map(button => button.props.label),
  }
}

/** The header state the band shows, or undefined with no panel. */
const head = async (band: Band) => (await view(band)).title

/** What a `Client` of the band last drew. */
const drawn = async (band: Band, client: 'voice-head' | 'voice-meter') => (await band.find({ type: 'Text', in: client }))?.text

/** A Button's label, hotkey and action. */
const button = async (band: Band, key: string) => {
  const found = await band.find({ key })
  return [found?.props.label, found?.props.hotkey, found?.props.action]
}

const FRAME = { gap: 1, rest: [] }
const HANDS_FREE = { ...FRAME, mode: 'hands-free', buttons: ['Mute', 'Tap to talk', 'Progress', 'End voice'] }
const MUTED = { ...FRAME, border: 'red', title: 'MUTED', mode: 'hands-free · mic off', hint: 'mic is off', buttons: ['Unmute', 'Tap to talk', 'Progress', 'End voice'] }
const TAP = { ...FRAME, mode: 'tap to talk', buttons: ['Talk', 'Hands-free', 'Progress', 'End voice'] }
const READY = { ...TAP, border: 'cyan', title: 'READY', hint: 'press Talk' }
const BARS = (...bars: string[]) => bars.join(' ')

test('voice mode submits what it hears, speaks the reply, and ends on the stop phrase', { timeoutMs: 30000 }, async ($, on) => {
  const stopping = gate()
  const { submitted, spoken } = world(
    on,
    [
      line({ type: 'ready', port: 4321, device: 'cuda' }),
      line({ type: 'speech' }) + line({ type: 'heard', text: 'list the files' }),
      line({ type: 'heard', text: 'Stop voice mode.' }),
    ],
    stopping.opened,
  )

  const band = await begin($)
  expect(submitted).toEqual(['list the files'])
  expect(spoken).toEqual(['http://127.0.0.1:4321/stop '])
  expect(await head(band)).toBe('READY')

  const answer = 'Done. Here:\n```ts\nconst a = 1\n```\nIn `hooks/register.tsx`, `speakable` drops `a.b()` and `--flags` but keeps `npm test` and **this**.'
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer, durationMs: 1, isAborted: false })
  expect(spoken.at(-1)).toBe('http://127.0.0.1:4321/speak Done. Here: In, speakable drops and but keeps npm test and this.')
  expect(await head(band)).toBe('SPEAKING')

  await stopping.open()
  expect(await head(band)).toBe(undefined)
  await band.unmount()
})

/** Starts voice mode over a relay that writes `after` once ready and stays up until `close`, and mounts the band on `surface`. */
const startBand = async ($: Engine, on: On, after = '', surface: 'terminal' | 'desktop' = 'terminal') => {
  const closing = gate()
  const { spoken } = world(on, [line({ type: 'ready', port: 4321, device: 'cuda' }) + after, line({ type: 'log', text: 'end' })], closing.opened)
  const band = await begin($, surface)

  return { spoken, band, close: async () => (await closing.open(), await band.unmount()) }
}

/** startBand, then the mode button pressed to switch to hands-free and the requests that sent forgotten. */
const startHandsFree = async (...args: Parameters<typeof startBand>) => {
  const started = await startBand(...args)
  await started.band.press({ key: 'voice-mode' })
  started.spoken.length = 0

  return started
}

test('tap to talk records with a timer and the live words, and Send sends them and clears the words', { timeoutMs: 30000 }, async ($, on) => {
  const [talking, closing] = [gate(), gate()]
  const { spoken } = world(
    on,
    [line({ type: 'ready', port: 4321, device: 'cuda' }), line({ type: 'speech' }) + line({ type: 'partial', text: 'list the fi' }), line({ type: 'log', text: 'end' })],
    talking.opened,
    closing.opened,
  )
  const band = await begin($)
  expect(spoken).toEqual([])
  expect(await view(band)).toEqual(READY)

  await band.press({ key: 'voice-mute' })
  await talking.open()
  expect(spoken).toEqual(['http://127.0.0.1:4321/talk '])
  expect(await view(band)).toEqual({ ...TAP, border: 'red', title: 'REC', hint: 'list the fi', buttons: ['Send', 'Hands-free', 'Progress', 'End voice'] })
  await band.advance(2000)
  expect(await drawn(band, 'voice-head')).toBe('● REC 0:02')

  await band.press({ key: 'voice-mute' })
  expect(spoken.at(-1)).toBe('http://127.0.0.1:4321/send ')
  expect(await view(band)).toEqual({ ...READY, hint: 'press Talk to interrupt' })
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as never)
  expect((await view(band)).hint).toBe('press Talk')
  await closing.open()
  await band.unmount()
})

test('the mode button switches to hands-free, cancelling the recording and unmuting, and back', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, close } = await startBand($, on)
  expect(await button(band, 'voice-mode')).toEqual(['Hands-free', undefined, undefined])

  await band.press({ key: 'voice-mute' })
  await band.press({ key: 'voice-mode' })
  expect(spoken.map(request => request.replace('http://127.0.0.1:4321', ''))).toEqual(['/talk ', '/cancel ', '/unmute '])
  expect(await view(band)).toEqual({ ...HANDS_FREE, border: 'cyan', title: 'LISTENING', hint: 'say something…' })

  await band.press({ key: 'voice-mode' })
  expect(spoken.at(-1)).toBe('http://127.0.0.1:4321/mute ')
  expect(await view(band)).toEqual(READY)
  await close()
})

test('hands-free keeps its idle look while Claude is thinking, and the band mutes the microphone', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, close } = await startHandsFree($, on)

  await $.turn.start({ turnId: 't1', text: 'hi' })
  expect(await view(band)).toEqual({ ...HANDS_FREE, border: 'cyan', title: 'LISTENING', hint: 'speak to interrupt' })

  await band.press({ key: 'voice-mute' })
  expect(spoken).toEqual(['http://127.0.0.1:4321/mute '])
  expect(await view(band)).toEqual(MUTED)
  expect([await drawn(band, 'voice-head'), await drawn(band, 'voice-meter')]).toEqual(['⊘ MUTED', '─'.repeat(23)])
  await close()
})

test('the words heard so far stay on one line, cut at the front, and clear once heard', { timeoutMs: 30000 }, async ($, on) => {
  const text = 'I guess the UI looks nice so far it loaded but I think the subagent is still doing something'
  const [heard, closing] = [gate(), gate()]
  world(
    on,
    [line({ type: 'ready', port: 4321, device: 'cuda' }) + line({ type: 'speech' }) + line({ type: 'partial', text }), line({ type: 'heard', text: 'list the files' }), line({ type: 'log', text: 'end' })],
    heard.opened,
    closing.opened,
  )
  const band = await begin($)
  expect((await view(band)).hint).toBe(`…${text.slice(-50)}`)

  await heard.open()
  expect((await view(band)).hint).toBe('press Talk to interrupt')
  await closing.open()
  await band.unmount()
})

test('speaking during a running turn ends that turn before submitting, and a dropped prompt goes back to idle', { timeoutMs: 30000 }, async ($, on) => {
  const [heard, dropped, closing] = [gate(), gate(), gate()]
  const { submitted, aborted, toasts } = world(
    on,
    [
      line({ type: 'ready', port: 4321, device: 'cuda' }),
      line({ type: 'heard', text: 'no, do the other one' }),
      line({ type: 'heard', text: DROPPED }),
      line({ type: 'log', text: 'end' }),
    ],
    heard.opened,
    dropped.opened,
    closing.opened,
  )

  const band = await begin($)
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  await heard.open()
  expect(aborted).toEqual(['t1'])
  expect(submitted).toEqual(['no, do the other one'])

  await dropped.open()
  expect(toasts.at(-1)).toBe('Voice prompt dropped: busy')
  expect((await view(band)).hint).toBe('press Talk')
  await closing.open()
  await band.unmount()
})

test('a turn that starts or ends while the person is recording keeps the recording, and its reply is not spoken', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, close } = await startBand($, on)

  await band.press({ key: 'voice-mute' })
  await $.turn.start({ turnId: 't1', text: 'typed' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false })
  expect(spoken).toEqual(['http://127.0.0.1:4321/talk '])
  expect(await view(band)).toMatchObject({ title: 'REC', buttons: ['Send', 'Hands-free', 'Progress', 'End voice'] })
  await close()
})

test('Skip stops the reply being spoken and goes back to listening', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, close } = await startBand($, on)

  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false })
  expect(await view(band)).toEqual({ ...TAP, border: 'magenta', title: 'SPEAKING', hint: 'reading the reply', buttons: ['Talk', 'Skip', 'Hands-free', 'Progress', 'End voice'] })
  expect(await button(band, 'voice-skip')).toEqual(['Skip', 's', undefined])

  await band.press({ key: 'voice-skip' })
  expect(spoken.at(-1)).toBe('http://127.0.0.1:4321/stop ')
  expect(await view(band)).toEqual(READY)
  await close()
})

test('level events reach the meter, which draws them as spaced bars', { timeoutMs: 30000 }, async ($, on) => {
  const { band, close } = await startHandsFree($, on, line({ type: 'level', mic: 0.1, out: 0 }))

  expect((await band.find({ key: 'voice-meter' }))?.props.props).toEqual({ part: 'meter', look: 'listening', color: 'cyan', mic: 0.1, out: 0 })
  expect(await drawn(band, 'voice-meter')).toBe(BARS(...Array(12).fill('▁')))
  await band.advance(400)
  expect(await drawn(band, 'voice-meter')).toBe(BARS(...Array(7).fill('▁'), ...Array(5).fill('▇')))
  await close()
})

test('the band draws on the desktop with its header and meter', { timeoutMs: 30000 }, async ($, on) => {
  const { band, close } = await startBand($, on, '', 'desktop')

  expect(await view(band)).toEqual(READY)
  expect([await drawn(band, 'voice-head'), await drawn(band, 'voice-meter')]).toEqual(['● READY', '─'.repeat(23)])
  await close()
})

test('voice mode adds a footer label and its shortcuts to the hint line', { timeoutMs: 30000 }, async ($, on) => {
  const seen: string[] = []
  on('ui.render', { component: 'SessionMode' }, ($, e) => (seen.push(e.props.modes.join(' & ')), { type: 'Box', props: {}, children: [] }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => (seen.push(e.props.tail ?? ''), { type: 'Box', props: {}, children: [] }))
  const { band, close } = await startBand($, on)
  const draw = async (component: 'SessionMode' | 'PromptHint', props: object) => (await (await $.ui.mount({ plugin: NAME, surface: 'terminal', component, props: { ...props, ...SITE } } as never)).unmount(), seen.at(-1))
  const hint = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

  expect(await draw('SessionMode', { modes: ['focus'] })).toBe('focus & voice')
  expect(await draw('PromptHint', hint)).toBe('alt+m talk/send')
  await band.press({ key: 'voice-mode' })
  expect(await draw('PromptHint', hint)).toBe('alt+m mute')
  await close()
  expect(await draw('SessionMode', { modes: [] })).toBe('')
})

type Use = { name: string; input: unknown }

/** The bodies of the requests posted to `path`. */
const bodies = (spoken: string[], path: string) => spoken.filter(request => request.includes(`${path} `)).map(request => request.split(`${path} `)[1])

/** A model beneath the plugins, and a call that runs a main-loop step through it streaming `text` in its chunks and then asking for `uses`, returning every line posted to /narrate so far. */
const stepper = (on: On) => {
  let reply = { text: [] as string[], uses: [] as Use[] }
  on('turn.step', async function* ($, e) {
    for (const text of reply.text.filter(Boolean)) {
      yield { kind: 'text' as const, index: 0, text }
    }
    for (const [index, use] of reply.uses.entries()) {
      yield { kind: 'tool' as const, index: index + 1, id: `u${index}`, name: use.name }
    }

    return { turnId: e.turnId, index: e.index, answer: reply.text.join(''), toolUses: reply.uses, stopReason: reply.uses.length ? ('tool_use' as const) : ('end_turn' as const), usage: null }
  })

  return async ($: Engine, spoken: string[], text: string | string[], uses: Use[], turnId = 't1') => {
    reply = { text: [text].flat(), uses }
    for await (const chunk of $.turn.step({ turnId, index: 0, model: 'm', messageCount: 1 })) {
      void chunk
    }

    return bodies(spoken, '/narrate')
  }
}

/** Starts voice mode on a clock that moves only by `clock.advance`, a turn t1 running, and progress verbosity unless `answer`. */
const startTurn = async ($: Engine, on: On, answer = false) => {
  const clock = { now: 0, advance: (ms: number) => void (clock.now += ms) }
  on('clock.now', () => ({ value: clock.now }))
  const run = stepper(on)
  const started = await startBand($, on)
  if (!answer) {
    await started.band.press({ key: 'voice-verbosity' })
  }
  await $.turn.start({ turnId: 't1', text: 'go' })

  return { ...started, clock, step: (text: string | string[], uses: Use[], turnId?: string) => run($, started.spoken, text, uses, turnId) }
}

const use = (name: string, input: object = {}) => ({ name, input })

test('progress speaks a short phrase for each step of tool uses', { timeoutMs: 30000 }, async ($, on) => {
  const { clock, step, close } = await startTurn($, on)
  const steps = [
    [use('Read', { file_path: 'C:/mods/hooks/register.tsx' })],
    [use('Read', { file_path: 'a.ts' }), use('Read', { file_path: 'b/c.test.py' }), use('Read', { file_path: 'a.ts' }), use('Read', { file_path: 'README.md' })],
    [use('Edit', { file_path: 'voice-panel.tsx' }), use('Write', { file_path: 'README.md' })],
    [use('Bash', { command: 'npm test', description: 'Run the tests' })],
    [use('Grep'), use('Glob'), use('WebFetch')],
    [use('Agent'), use('mcp__claude_ai_Gmail__search_threads')],
    [use('NotebookEdit')],
  ]

  for (const uses of steps) {
    await clock.advance(5000)
    await step('', uses)
  }
  expect(await step('Let me check the **config**.', [use('Read', { file_path: 'config.py' })])).toEqual([
    'reading register',
    'reading 3 files',
    'editing 2 files',
    'Run the tests',
    'searching the code, searching the web',
    'starting a subagent, using claude ai Gmail',
    'Let me check the config.',
  ])
  await close()
})

test('tool summaries come at most every 5 seconds and never twice in a row', { timeoutMs: 30000 }, async ($, on) => {
  const { clock, step, close } = await startTurn($, on)

  await step('', [use('Grep')])
  await clock.advance(4000)
  await step('', [use('Read', { file_path: 'a.ts' })])
  await clock.advance(5000)
  await step('', [use('Glob')])
  expect(await step('Now the tests.', [use('Bash')])).toEqual(['searching the code', 'Now the tests.'])
  await close()
})

test('the verbosity button switches to progress, and nothing is narrated in answer only, for a stale turn, or while hearing', { timeoutMs: 30000 }, async ($, on) => {
  const { band, step, close } = await startTurn($, on, true)

  expect(await button(band, 'voice-verbosity')).toEqual(['Progress', undefined, undefined])
  await step('Reading it.', [use('Read', { file_path: 'a.ts' })])
  await band.press({ key: 'voice-verbosity' })
  expect(await button(band, 'voice-verbosity')).toEqual(['Answer only', undefined, undefined])
  await step('Reading it.', [use('Read', { file_path: 'a.ts' })], 't0')
  await band.press({ key: 'voice-mute' })
  expect(await step('Reading it.', [use('Read', { file_path: 'a.ts' })])).toEqual([])
  await close()
})

/** Ends turn t1 with `answer`. */
const answered = ($: Engine, answer: string) => $.turn.complete({ turnId: 't1', reason: 'answer', answer, durationMs: 1, isAborted: false })

test('a reply is spoken sentence by sentence as it streams, and only its rest at the end', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, step, close } = await startTurn($, on, true)

  await step(['Sure, here', ' it is. The file has', ' three parts. Done'], [])
  expect(bodies(spoken, '/speak')).toEqual(['Sure, here it is.', 'The file has three parts.'])
  expect(await head(band)).toBe('SPEAKING')

  await answered($, 'Sure, here it is. The file has three parts. Done')
  expect(bodies(spoken, '/speak')).toEqual(['Sure, here it is.', 'The file has three parts.', 'Done'])
  await close()
})

test('in progress, a first phrase comes at a comma or eight words, and a code block only once it closes', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, step, close } = await startTurn($, on)

  await step(['Sure, here', ' it is. '], [])
  await answered($, 'Sure, here it is.')
  await $.turn.start({ turnId: 't1', text: 'go' })
  await step(['one two three four five six seven eight nine ten'], [])
  await answered($, 'one two three four five six seven eight nine ten')
  await $.turn.start({ turnId: 't1', text: 'go' })
  await step(['Here, run:\n```', 'sh\nnpm test\n', '```\nThat is it. '], [])
  await answered($, 'Here, run:\n```sh\nnpm test\n```\nThat is it.')
  expect(bodies(spoken, '/speak')).toEqual(['Sure,', 'here it is.', '', 'one two three four five six seven eight', 'nine ten', 'Here, run:', 'That is it.', ''])
  await close()
})

test('in answer only, a sentence before a tool call is not spoken, more is stopped, and the answer still spoken', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, step, close } = await startTurn($, on, true)

  await step(['Let me look, then', ' fix it.'], [use('Read', { file_path: 'a.ts' })])
  expect(spoken).toEqual([])

  await step(['First this. Then', ' that.'], [use('Read', { file_path: 'a.ts' })])
  expect(spoken).toEqual(['http://127.0.0.1:4321/speak First this.', 'http://127.0.0.1:4321/stop '])
  expect(await head(band)).toBe('READY')

  await step(['Fixed.'], [])
  await answered($, 'Fixed.')
  expect(bodies(spoken, '/speak')).toEqual(['First this.', 'Fixed.'])
  await close()
})

test('in progress, text streamed before a tool call is spoken once, whole', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, step, close } = await startTurn($, on)

  expect(await step(['Let me look, then', ' fix it.'], [use('Read', { file_path: 'a.ts' })])).toEqual([])
  expect(bodies(spoken, '/speak')).toEqual(['Let me look,', 'then fix it.'])
  expect(bodies(spoken, '/stop')).toEqual([])
  expect(await head(band)).toBe('READY')
  await close()
})

test('Skip ends the rest of a streaming reply', { timeoutMs: 30000 }, async ($, on) => {
  const { spoken, band, step, close } = await startTurn($, on, true)

  await step(['Sure, here it is. Then'], [])
  await band.press({ key: 'voice-skip' })
  expect(await view(band)).toMatchObject({ title: 'READY', hint: 'press Talk to interrupt' })
  await answered($, 'Sure, here it is. Then')
  expect(bodies(spoken, '/speak')).toEqual(['Sure, here it is.'])
  expect(await head(band)).toBe('READY')
  await close()
})

test('the panel stays speaking between streamed phrases until the whole reply is spoken', { timeoutMs: 30000 }, async ($, on) => {
  const gates = [gate(), gate(), gate(), gate()] as const
  const { spoken } = world(
    on,
    [
      line({ type: 'ready', port: 4321, device: 'cuda' }),
      line({ type: 'spoken', lines: 1 }),
      line({ type: 'spoken', lines: 1 }),
      line({ type: 'spoken', lines: 2 }),
      line({ type: 'log', text: 'end' }),
    ],
    ...gates.map(gate => gate.opened),
  )
  const run = stepper(on)

  const band = await begin($)
  await $.turn.start({ turnId: 't1', text: 'go' })
  await run($, spoken, ['Sure, here it is. '], [])
  await gates[0].open()
  expect(await head(band)).toBe('SPEAKING')

  await answered($, 'Sure, here it is.')
  expect(spoken.at(-1)).toBe('http://127.0.0.1:4321/speak ')
  await gates[1].open()
  expect(await head(band)).toBe('SPEAKING')

  await gates[2].open()
  expect(await head(band)).toBe('READY')
  await gates[3].open()
  await band.unmount()
})

test('a session whose microphone another session took goes back to tap to talk', { timeoutMs: 30000 }, async ($, on) => {
  const [taken, closing] = [gate(), gate()]
  const { toasts } = world(on, [line({ type: 'ready', port: 4321, device: 'cuda', client: '1' }), line({ type: 'taken' }), line({ type: 'log', text: 'end' })], taken.opened, closing.opened)

  const band = await begin($)
  await band.press({ key: 'voice-mode' })
  expect(await view(band)).toMatchObject({ title: 'LISTENING', mode: 'hands-free', buttons: HANDS_FREE.buttons })

  await taken.open()
  expect(await view(band)).toEqual(READY)
  expect(toasts.at(-1)).toBe('Another session took the microphone. Press Talk to take it back.')
  await closing.open()
  await band.unmount()
})

test('voice mode runs the relay as the client it reports, shows loading while the engine restarts, and ends when the engine quits', { timeoutMs: 30000 }, async ($, on) => {
  const [restarting, restarted, quitting] = [gate(), gate(), gate()]
  const { argv, spoken, clients, toasts } = world(
    on,
    [
      line({ type: 'ready', port: 4321, device: 'cuda', client: '1' }),
      line({ type: 'speech' }) + line({ type: 'partial', text: 'list the fi' }) + line({ type: 'loading' }),
      line({ type: 'ready', port: 5555, device: 'cuda', client: '2' }),
      line({ type: 'end', text: 'Voice engine quit; voice mode off.' }),
    ],
    restarting.opened,
    restarted.opened,
    quitting.opened,
  )

  const band = await begin($)
  await band.press({ key: 'voice-mute' })
  expect(argv.at(-1)).toMatch(/\/sidecar\/relay\.py$/)
  expect([spoken, clients]).toEqual([['http://127.0.0.1:4321/talk '], ['1']])

  await restarting.open()
  await band.press({ key: 'voice-mute' })
  expect(spoken).toHaveLength(1)
  expect(await view(band)).toMatchObject({ title: 'LOADING', hint: 'loading Whisper…' })

  await restarted.open()
  expect(await head(band)).toBe('READY')
  expect(toasts.filter(toast => toast.startsWith('Voice mode on'))).toHaveLength(1)
  await band.press({ key: 'voice-mute' })
  expect([spoken.at(-1), clients.at(-1)]).toEqual(['http://127.0.0.1:5555/talk ', '2'])

  await quitting.open()
  expect(await head(band)).toBe(undefined)
  expect(toasts.at(-1)).toBe('Voice engine quit; voice mode off.')
  await band.unmount()
})
