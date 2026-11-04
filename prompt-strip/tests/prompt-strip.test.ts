import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const RULES = 'C:/cfg/prompt-strip/rules.json'
const CATALOG = 'C:/cfg/prompt-strip/catalog.json'
const ENGINE = { plugin: 'engine', tier: 'core' } as const
const SECTIONS = [
  { id: 'intro', text: 'I', scope: 'shared' },
  { id: 'tone', text: 'T', scope: 'shared' },
  { id: 'memory', text: 'M', scope: 'session' },
  { id: 'env', text: 'E', scope: 'session' },
] as const
const BLOCKS = [
  { name: 'claudeMd', text: 'rules' },
  { name: 'userEmail', text: 'me@x' },
  { name: 'currentDate', text: 'today' },
] as const
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as const
const TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn1', reason: 'answer' } as const

/** Answers what prompt-strip calls beneath it, and the loading events as the engine does; returns the files it wrote, the caches it cleared and the dashboard's server. */
const world = (on: On) => {
  const files: Record<string, string> = {}
  const cleared: string[] = []
  const server = { isUp: false, starts: 0 }
  mock.clock(on, { now: 1000 })
  mock.env(on, { CLAUDE_CONFIG_DIR: 'C:/cfg' })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ((server.isUp = true), server.starts++, { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', ($, e) => {
    if (!server.isUp) {
      throw new Error('connection refused')
    }

    server.isUp = !e.url.endsWith('/api/stop')

    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  const key = (path: string) => path.replaceAll('\\', '/')
  on('fs.write', ($, e) => ((files[key(e.path)] = e.text), { value: undefined }))
  on('fs.read', ($, e) => {
    const text = files[key(e.path)]

    if (text === undefined) {
      throw new Error('no such file')
    }

    return { value: text }
  })
  on('ui.invalidate', ($, e) => (cleared.push(e.event), { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: SECTIONS }))
  on('prompt.context', () => ({ blocks: BLOCKS }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('agent.offer', () => ({ isOffered: true }))
  on('command.describe', ($, e) => ({ description: e.description, argumentHint: e.argumentHint, isHidden: e.isHidden }))

  return { files, cleared, server }
}
const describe = ($: Engine, tool: string) => $.tool.describe({ tool, description: 'long', provider: ENGINE })
const attach = ($: Engine, type: string) => $.prompt.attachment({ type, text: 'reminder', origin: { kind: 'engine' } } as never).then(attached => attached.text)
const offer = ($: Engine, agent: string) => $.agent.offer({ agent, description: 'Searches.', source: 'built-in', provider: ENGINE }).then(offered => offered.isOffered)
const command = ($: Engine, name: string) => $.command.describe({ command: name, description: 'Does it.', isHidden: false, immediate: false, provider: ENGINE })

test('rules strip, rewrite, add and reorder across every layer', async ($, on) => {
  const { files, cleared } = world(on)
  files[RULES] = JSON.stringify({
    rules: {
      's:memory': { off: true },
      's:intro': { text: 'Hi' },
      'c:userEmail': { off: true },
      'c:claudeMd': { text: 'short rules' },
      'r:todo_reminder': { off: true },
      'r:skill_listing': { text: 'No skills.' },
      't:Bash': { text: 'Runs a command.' },
      't:WebFetch': { off: true },
      'k:pdf': { off: true },
      'k:docx': { text: 'Short.' },
      'a:Plan': { off: true },
      'm:review': { off: true, text: 'Reviews.' },
    },
    order: ['tone', 'intro', 'prompt-strip:mine', 'env'],
    added: [{ id: 'mine', text: 'Mine.' }, { id: 'empty', text: '  ' }, { id: 'parked', text: 'Later.', off: true }],
  })

  await $.turn.start({ text: 'hi', turnId: 'turn1' })
  await $.turn.start({ text: 'again', turnId: 'turn2' })

  expect(cleared).toEqual(['prompt.section', 'prompt.context', 'prompt.attachment', 'tool.describe', 'command.describe'])
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual([
    { id: 'tone', text: 'T', scope: 'shared' },
    { id: 'intro', text: 'Hi', scope: 'shared' },
    { id: 'prompt-strip:mine', text: 'Mine.', scope: 'session' },
    { id: 'env', text: 'E', scope: 'session' },
  ])
  expect((await $.prompt.context({ blocks: BLOCKS })).blocks).toEqual([
    { name: 'claudeMd', text: 'short rules' },
    { name: 'currentDate', text: 'today' },
  ])
  expect(await attach($, 'todo_reminder')).toBe(null)
  expect(await attach($, 'skill_listing')).toBe('No skills.')
  expect(await attach($, 'plan_mode')).toBe('reminder')
  expect(await describe($, 'Bash')).toEqual({ description: 'Runs a command.' })
  expect(await describe($, 'WebFetch')).toEqual({ description: 'long', isDeferred: true })
  expect(await describe($, 'Read')).toEqual({ description: 'long' })
  expect((await $.skill.prompt({ skill: 'pdf', text: 'long', frontmatter: {} } as never)).text).toBe('')
  expect((await $.skill.prompt({ skill: 'docx', text: 'long', frontmatter: {} } as never)).text).toBe('Short.')
  expect(await offer($, 'Plan')).toBe(false)
  expect(await offer($, 'Explore')).toBe(true)
  expect(await command($, 'review')).toEqual(expect.objectContaining({ description: 'Reviews.', isHidden: true }))
  expect(await command($, 'init')).toEqual(expect.objectContaining({ description: 'Does it.', isHidden: false }))
})

test('without rules, and with rules paused, everything passes through', async ($, on) => {
  const { files, cleared } = world(on)

  await $.turn.start({ text: 'hi', turnId: 'turn1' })
  expect(cleared).toEqual([])
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)

  files[RULES] = JSON.stringify({ paused: true, rules: { 's:intro': { off: true }, 't:Bash': { off: true }, 'a:Plan': { off: true } }, added: [{ id: 'mine', text: 'Mine.' }] })
  await $.turn.start({ text: 'again', turnId: 'turn2' })

  expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)
  expect((await $.prompt.context({ blocks: BLOCKS })).blocks).toEqual(BLOCKS)
  expect(await describe($, 'Bash')).toEqual({ description: 'long' })
  expect(await offer($, 'Plan')).toBe(true)
})

test('what a session loads is merged into the catalog at the turn end, as the engine computed it', async ($, on) => {
  const { files } = world(on)
  files[RULES] = JSON.stringify({ rules: { 's:intro': { text: 'Hi' } } })
  files[CATALOG] = JSON.stringify({ items: { 't:Old': { kind: 'tools', name: 'Old', text: '', chars: 0, at: 1000 - 31 * 86_400_000 }, 't:Kept': { kind: 'tools', name: 'Kept', text: '', chars: 0, at: 900 } } })

  await $.turn.start({ text: 'hi', turnId: 'turn1' })
  await $.prompt.compose(COMPOSE)
  await $.prompt.context({ blocks: BLOCKS })
  await attach($, 'todo_reminder')
  await attach($, 'todo_reminder')
  await describe($, 'Bash')
  await offer($, 'Plan')
  await command($, 'init')
  await $.turn.complete(TURN)

  const catalog = JSON.parse(files[CATALOG]!)
  expect(Object.keys(catalog.items)).toEqual(['t:Kept', 's:intro', 's:tone', 's:memory', 's:env', 'c:claudeMd', 'c:userEmail', 'c:currentDate', 'r:todo_reminder', 't:Bash', 'a:Plan', 'm:init'])
  expect(catalog.items['s:intro']).toEqual({ kind: 'sections', name: 'intro', text: 'I', chars: 1, scope: 'shared', at: 1000 })
  expect(catalog.items['r:todo_reminder']).toEqual(expect.objectContaining({ kind: 'reminders', count: 2, source: 'engine' }))
  expect(catalog.items['t:Bash']).toEqual(expect.objectContaining({ kind: 'tools', deferred: false, source: 'engine' }))
  expect(catalog.compose).toEqual({ ids: ['intro', 'tone', 'memory', 'env'], model: 'm', at: 1000 })
})

test('the command opens the dashboard and stops it', async ($, on) => {
  const { server } = world(on)

  expect((await $.command.run({ command: 'prompt-strip', args: '' })).text).toMatch('http://127.0.0.1:5199')
  expect((await $.command.run({ command: 'prompt-strip', args: '' })).text).toMatch('http://127.0.0.1:5199')
  expect(server.starts).toBe(1)
  expect((await $.command.run({ command: 'prompt-strip', args: 'stop' })).text).toBe('prompt-strip dashboard stopped.')
  expect((await $.command.run({ command: 'prompt-strip', args: 'stop' })).text).toBe('prompt-strip dashboard was not running.')
})
