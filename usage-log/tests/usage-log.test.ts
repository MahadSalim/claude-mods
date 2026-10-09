import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }]
const USAGE = {
  startedAt: 0,
  context: { tokens: 50_000, window: 1_000_000, percent: 5 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-08T20:00:00Z' },
    { kind: 'seven_day', percentUsed: 40 },
  ],
  cost: { usd: 1.25 },
}

type Row = Record<string, any>

/** Answers what usage-log calls beneath it; returns the files it wrote and the session id it reads. */
const world = (on: On) => {
  const files: Record<string, string> = {}
  const session = { id: 's1' }
  mock.clock(on, { now: 1000 })
  on('fs.write', ($, e) => ((files[e.path.replaceAll('\\', '/')] = e.text), { value: undefined }))
  on('session.id', () => ({ value: session.id }))
  on('session.usage', () => ({ value: USAGE }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.version', () => ({ value: { version: '2.1.293' } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 900, tokensAfter: 100 }) as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ran' }))
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'no' }))
  on('tool.call', { tool: 'Edit' }, () => ({ isError: true, result: 'boom' }) as never)

  return { files, session }
}
/** The log files of one session id, by path. */
const named = (files: Record<string, string>, id: string) => Object.keys(files).filter(path => path.includes(`/events/${id}.`))
/** The rows of every log file of one session id. */
const rows = (files: Record<string, string>, id: string): Row[] =>
  named(files, id).flatMap(path => files[path]!.trim().split('\n').map(line => JSON.parse(line)))
let calls = 0
const call = ($: Engine, tool: string, more: object = {}) => $.tool.call({ tool, tool_use_id: `t${calls++}`, ...more } as never)

test('a turn logs its plan readings before and after, and its outcome', async ($, on) => {
  const { files } = world(on)

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 'turn1' })
  await $.turn.complete({ answer: 'done', durationMs: 4200, isAborted: false, turnId: 'turn1', reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 3, output_tokens: 9 } as never })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'turn2', agentId: 'sub', reason: 'aborted' })

  const [started, before, after, aborted] = rows(files, 's1')
  expect(Object.keys(files)).toEqual([expect.stringMatching('/dashboard/data/events/s1.1000-0.jsonl$')])
  expect(started).toEqual(expect.objectContaining({ at: 1000, ev: 'session.start', cwd: 'C:/work', model: 'claude-opus-5-5', version: '2.1.293' }))
  expect(before).toEqual(expect.objectContaining({ ev: 'turn.start', turnId: 'turn1', usage: USAGE }))
  expect(after).toEqual(expect.objectContaining({ ev: 'turn.end', turnId: 'turn1', reason: 'answer', durationMs: 4200, usage: USAGE }))
  expect(after!.tokens.output_tokens).toBe(9)
  expect(aborted).toEqual(expect.objectContaining({ ev: 'turn.end', agentId: 'sub', reason: 'aborted' }))
})

test('a tool call logs its start, its end and its outcome, never its input', async ($, on) => {
  const { files } = world(on)

  expect((await call($, 'Read', { file_path: 'secret.md', agentId: 'sub' })).result).toBe('ran')
  expect((await call($, 'Bash', { command: 'ls' })).deny).toBe('no')
  await call($, 'Edit', { file_path: 'a.md', old_string: 'a', new_string: 'b' })

  const logged = rows(files, 's1')
  expect(logged.map(row => [row.tool, row.outcome])).toEqual([['Read', 'ok'], ['Bash', 'denied'], ['Edit', 'error']])
  expect(logged[0]).toEqual(expect.objectContaining({ ev: 'tool', agentId: 'sub', startedAt: 1000, at: 1000 }))
  expect(JSON.stringify(logged)).not.toMatch('secret.md')
})

test('measurements, compactions and the end are logged', async ($, on) => {
  const { files } = world(on)
  const { startedAt, ...measured } = USAGE

  await $.session.measure({ ...measured, changed: ['rateLimits'] })
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } as never })

  const [measure, compact, end] = rows(files, 's1')
  expect(measure).toEqual({ at: 1000, ev: 'measure', changed: ['rateLimits'], usage: measured })
  expect(compact).toEqual({ at: 1000, ev: 'compact', trigger: 'manual', tokensBefore: 900, tokensAfter: 100 })
  expect(end).toEqual(expect.objectContaining({ ev: 'session.end', reason: 'clear', usage: USAGE }))
})

test('each session id and each full file gets its own file', async ($, on) => {
  const { files, session } = world(on)

  await call($, 'Read', { file_path: 'a.md' })
  session.id = 's2'
  for (let i = 0; i < 1000; i++) {
    await call($, 'Read', { file_path: 'a.md' })
  }

  expect(rows(files, 's1').length).toBe(1)
  expect(rows(files, 's2').length).toBe(1000)
  expect(named(files, 's2').length).toBe(2)
})
