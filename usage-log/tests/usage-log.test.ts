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

/** Answers what usage-log calls beneath it; returns the files it wrote, the session id it reads and the dashboard's server. */
const world = (on: On) => {
  const files: Record<string, string> = {}
  const session = { id: 's1' }
  const server = { isUp: false, starts: [] as (readonly string[])[] }
  const cleared: string[] = []
  const held = (path: string) => files[path.replaceAll('\\', '/')]
  mock.clock(on, { now: 1000 })
  mock.env(on, { CLAUDE_CONFIG_DIR: 'C:/cfg' })
  mock.store(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    server.isUp = true
    server.starts.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', ($, e) => {
    if (!server.isUp) {
      throw new Error('connection refused')
    }

    server.isUp = !e.url.endsWith('/api/stop')

    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  on('fs.write', ($, e) => ((files[e.path.replaceAll('\\', '/')] = e.text), { value: undefined }))
  on('fs.read', ($, e) => {
    const text = held(e.path)

    if (text === undefined) {
      throw new Error('no such file')
    }

    return { value: text }
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: held(e.path)?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('ui.invalidate', ($, e) => (cleared.push(e.event), { value: undefined }))
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

  return { files, session, server, cleared }
}
const RULES = 'C:/cfg/usage-log/rules.json'
const CONTEXT = 'C:/cfg/usage-log/context.json'
const DAY = 86_400_000
const SECTIONS = [
  { id: 'intro', text: 'I', scope: 'shared' },
  { id: 'tone', text: 'T', scope: 'shared' },
  { id: 'memory', text: 'M', scope: 'session' },
  { id: 'env', text: 'E', scope: 'session' },
] as const
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as const
const TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn1', reason: 'answer' } as const
/** Answers the context events as the engine does, changing nothing. */
const engine = (on: On) => {
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('prompt.compose', () => ({ sections: SECTIONS }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
}
const describe = ($: Engine, tool: string) => $.tool.describe({ tool, description: 'long', provider: { plugin: 'engine', tier: 'core' } } as never)
const attach = ($: Engine, type: string) => $.prompt.attachment({ type, text: 'reminder', origin: { kind: 'engine' } } as never).then(attached => attached.text)
const START ={ cwd: 'C:/work', surface: 'desktop', isInteractive: true } as const
const toggle = ($: Engine, args = '') => $.command.run({ command: 'usage-dashboard', args }).then(ran => ran.text)
/** The log files of one session id, by path. */
const named = (files: Record<string, string>, id: string) => Object.keys(files).filter(path => path.includes(`/events/${id}.`))
/** The rows of every log file of one session id. */
const rows = (files: Record<string, string>, id: string): Row[] =>
  named(files, id).flatMap(path => files[path]!.trim().split('\n').map(line => JSON.parse(line)))
let calls = 0
const call = ($: Engine, tool: string, more: object = {}) => $.tool.call({ tool, tool_use_id: `t${calls++}`, ...more } as never)

test('a turn logs its plan readings before and after, and its outcome', async ($, on) => {
  const { files } = world(on)

  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 'turn1' })
  await $.turn.complete({ answer: 'done', durationMs: 4200, isAborted: false, turnId: 'turn1', reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 3, output_tokens: 9 } as never })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'turn2', agentId: 'sub', reason: 'aborted' })

  const [started, before, after, aborted] = rows(files, 's1')
  expect(named(files, 's1')).toEqual(['C:/cfg/usage-log/events/s1.1000-0.jsonl'])
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

test('a session starts the dashboard once, and the command turns it off and on', async ($, on) => {
  const { server } = world(on)

  await $.session.start(START)
  await $.session.start(START)

  expect(server.starts).toEqual([['node', '-e', expect.any(String), expect.stringMatching('/dashboard/server.mjs$')]])
  expect(await toggle($)).toBe('Usage dashboard is off.')
  expect(server.isUp).toBe(false)
  expect(await toggle($)).toBe('Usage dashboard is on: http://127.0.0.1:5198')
  expect(server.starts.length).toBe(2)
})

test('auto start turned off leaves the dashboard down at the start', async ($, on) => {
  const { server } = world(on)

  expect(await toggle($, 'auto')).toBe('Usage dashboard auto start is off.')
  await $.session.start(START)
  expect(server.starts).toEqual([])
  expect(await toggle($, 'auto')).toBe('Usage dashboard auto start is on.')
  await $.session.start(START)
  expect(server.starts.length).toBe(1)
})

test('rules defer and rewrite tools, drop and rewrite blocks and skills, and arrange the system prompt', async ($, on) => {
  const { files, cleared } = world(on)
  engine(on)
  files[RULES] = JSON.stringify({
    rules: {
      't:Bash': { a: 'rewrite', text: 'Runs a command.' },
      't:WebFetch': { a: 'defer' },
      'b:todo_reminder': { a: 'drop' },
      'k:listing': { a: 'rewrite', text: 'No skills.' },
      'k:pdf': { a: 'rewrite', text: 'Short.' },
      's:memory': { a: 'drop' },
      's:intro': { a: 'rewrite', text: 'Hi' },
    },
    order: ['env', 'tone', 'intro', 'memory'],
  })

  await $.turn.start({ text: 'hi', turnId: 'turn1' })
  await $.turn.start({ text: 'again', turnId: 'turn2' })

  expect(cleared).toEqual(['tool.describe', 'prompt.section', 'prompt.attachment'])
  expect(await describe($, 'Bash')).toEqual({ description: 'Runs a command.' })
  expect(await describe($, 'WebFetch')).toEqual({ description: 'long', isDeferred: true })
  expect(await describe($, 'Read')).toEqual({ description: 'long' })
  expect(await attach($, 'todo_reminder')).toBe(null)
  expect(await attach($, 'skill_listing')).toBe('No skills.')
  expect(await attach($, 'plan_mode')).toBe('reminder')
  expect((await $.skill.prompt({ skill: 'pdf', text: 'long' })).text).toBe('Short.')
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual([
    { id: 'tone', text: 'T', scope: 'shared' },
    { id: 'intro', text: 'Hi', scope: 'shared' },
    { id: 'env', text: 'E', scope: 'session' },
  ])
})

test('without rules the context passes through', async ($, on) => {
  const { cleared } = world(on)
  engine(on)

  await $.turn.start({ text: 'hi', turnId: 'turn1' })

  expect(cleared).toEqual([])
  expect(await describe($, 'Bash')).toEqual({ description: 'long' })
  expect(await attach($, 'todo_reminder')).toBe('reminder')
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)
})

test('what a session loads is merged into the catalog at the turn end', async ($, on) => {
  const { files } = world(on)
  const tool = { kind: 'tools', text: '', chars: 0 }
  engine(on)
  files[CONTEXT] = JSON.stringify({
    sessions: { old: { at: 1000 - 8 * DAY }, s0: { at: 900 } },
    items: { 't:Gone': { ...tool, name: 'Gone', at: 1000 - 31 * DAY }, 't:Kept': { ...tool, name: 'Kept', at: 900 } },
  })

  await describe($, 'Bash')
  await attach($, 'skill_listing')
  await attach($, 'todo_reminder')
  await attach($, 'todo_reminder')
  await $.prompt.compose(COMPOSE)
  await $.turn.complete(TURN)

  const catalog = JSON.parse(files[CONTEXT]!)
  expect(Object.keys(catalog.sessions)).toEqual(['s0', 's1'])
  expect(Object.keys(catalog.items)).toEqual(['t:Kept', 't:Bash', 'k:listing', 'b:todo_reminder', 's:intro', 's:tone', 's:memory', 's:env'])
  expect(catalog.items['t:Bash']).toEqual({ kind: 'tools', name: 'Bash', text: 'long', chars: 4, deferred: false, at: 1000 })
  expect(catalog.items['s:memory']).toEqual({ kind: 'sections', name: 'memory', text: 'M', chars: 1, scope: 'session', pos: 2, at: 1000 })
  expect(rows(files, 's1')[0]!.blocks).toEqual({ skill_listing: 1, todo_reminder: 2 })
})

test('a read over the cap is refused, a slice under it and a subagent read run', async ($, on) => {
  const { files } = world(on)
  files[RULES] = JSON.stringify({ cap: { on: true, k: 1, part: true } })
  files['C:/work/big.md'] = 'line\n'.repeat(2000)

  await $.turn.start({ text: 'hi', turnId: 'turn1' })

  expect((await call($, 'Read', { file_path: 'C:/work/big.md' })).deny).toMatch('big.md is about 3K tokens. The cap is 1K a read.')
  expect((await call($, 'Read', { file_path: 'C:/work/big.md', offset: 1, limit: 100 })).result).toBe('ran')
  expect((await call($, 'Read', { file_path: 'C:/work/big.md', agentId: 'sub' })).result).toBe('ran')
  expect(rows(files, 's1').filter(row => row.ev === 'tool').map(row => row.outcome)).toEqual(['denied', 'ok', 'ok'])
})

test('permission asks, commands and settings hook runs are logged, never their input', async ($, on) => {
  const { files } = world(on)
  on('tool.check', () => ({ decision: 'ask' }))
  on('command.run', () => ({ text: 'ran' }))
  on('classic.SessionStart', () => ({}))

  await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 't9' })
  await $.tool.check({ tool: 'Bash', input: { command: 'git push' } })
  await $.command.run({ command: 'compact', args: 'secret' })
  await $.classic.SessionStart({ source: 'clear' })
  await $.turn.complete(TURN)

  const [ask, command, end] = rows(files, 's1')
  expect(ask).toEqual({ at: 1000, ev: 'ask', tool: 'Bash', id: 't9' })
  expect(command).toEqual({ at: 1000, ev: 'command', command: 'compact' })
  expect(end!.hooks).toEqual({ SessionStart: { n: 1, ms: 0, blocked: 0 } })
  expect(JSON.stringify(rows(files, 's1'))).not.toMatch(/secret|git push/)
})
