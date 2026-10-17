import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NAME = 'live-voice-mode'
const SITE = { scroll: { offset: 0, bodyRows: 20 }, view: {} }
const BAND = { plugin: NAME, surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, ...SITE } } as const
const DONE = { value: undefined }

declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const line = (event: object) => `${JSON.stringify(event)}\n`
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

/** Answers the calls the mod makes beneath it, with a sidecar that writes `lines` and waits for `gate` before its last. */
const world = (on: On, lines: string[], gate: Promise<void>) => {
  const submitted: string[] = []
  const spoken: string[] = []
  const aborted: string[] = []
  on('ui.toast', () => DONE)
  on('ui.log', () => DONE)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('process.spawn', async function* () {
    for (const text of lines.slice(0, -1)) {
      yield { stream: 'stdout' as const, text }
    }
    await gate
    yield { stream: 'stdout' as const, text: lines.at(-1)! }

    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text }))
  on('http.fetch', ($, e) => (spoken.push(`${e.url} ${e.init?.body}`), { value: { status: 204, ok: true, headers: {}, text: '' } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.abort', ($, e) => (aborted.push(e.turnId), DONE))

  return { submitted, spoken, aborted }
}

test('voice mode submits what it hears, speaks the reply, and ends on the stop phrase', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  const { submitted, spoken } = world(
    on,
    [
      line({ type: 'ready', port: 4321, device: 'cuda' }),
      line({ type: 'speech' }) + line({ type: 'heard', text: 'list the files' }),
      line({ type: 'heard', text: 'Stop voice mode.' }),
    ],
    gate,
  )
  const shows = async (text: RegExp) => {
    const band = await $.ui.mount(BAND)
    const found = await band.find({ type: 'Text', text })
    await band.unmount()

    return found !== undefined
  }

  await $.command.run({ command: 'live-voice', args: '' } as never)
  await settle()
  expect(submitted).toEqual(['list the files'])
  expect(await shows(/thinking/)).toBe(true)

  const answer = 'Done. Here:\n```ts\nconst a = 1\n```\nSee `register.tsx` and **this**.'
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer, durationMs: 1, isAborted: false })
  expect(spoken).toEqual(['http://127.0.0.1:4321/speak Done. Here: Code block omitted. See register.tsx and this.'])
  expect(await shows(/speaking/)).toBe(true)

  open()
  await settle()
  expect(await shows(/Voice/)).toBe(false)
})

test('the band mutes the microphone', async ($, on) => {
  const { spoken } = world(on, [line({ type: 'ready', port: 4321, device: 'cuda' }), line({ type: 'log', text: 'end' })], new Promise<void>(() => {}))

  await $.command.run({ command: 'live-voice', args: '' } as never)
  await settle()
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'voice-mute' })
  await band.unmount()
  expect(spoken).toEqual(['http://127.0.0.1:4321/mute '])

  const muted = await $.ui.mount(BAND)
  expect(await muted.find({ type: 'Text', text: /mic muted/ })).not.toBe(undefined)
  await muted.unmount()
})

test('speaking during a running turn ends that turn before submitting', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  const { submitted, aborted } = world(
    on,
    [line({ type: 'ready', port: 4321, device: 'cuda' }), line({ type: 'heard', text: 'no, do the other one' })],
    gate,
  )

  await $.command.run({ command: 'live-voice', args: '' } as never)
  await settle()
  await $.turn.start({ turnId: 't1', text: 'list the files' })
  open()
  await settle()
  expect(aborted).toEqual(['t1'])
  expect(submitted).toEqual(['no, do the other one'])
})
