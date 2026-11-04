import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = 'C:/cfg'
const LISTING = [
  'The following skills are available:',
  '- my-skill: Mine.',
  '- old-skill: Turned off.',
  '- anthropic-skills:pdf: Read PDFs.',
].join('\n')

/**
 * Answers the mod's `$.fs` calls from a map of paths to file text. Off Windows the engine reads
 * `C:/cfg` as a relative path and puts the working folder in front, so paths are matched from ROOT.
 */
function disk(on: On, files: Record<string, string>) {
  const norm = (path: string) => {
    const unix = path.replace(/\\/g, '/')
    const at = unix.indexOf(ROOT)
    return at < 0 ? unix : unix.slice(at)
  }
  const store = new Map(Object.entries(files))
  on('fs.read', ($, e) => (store.has(norm(e.path)) ? { value: store.get(norm(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => {
    store.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: [...store.keys()].some(key => key === norm(e.path) || key.startsWith(`${norm(e.path)}/`)) }))
  on('fs.list', ($, e) => {
    const dir = `${norm(e.path ?? '')}/`
    const children = new Map<string, 'file' | 'dir'>()
    for (const key of store.keys()) {
      if (!key.startsWith(dir)) continue
      const [head = '', ...rest] = key.slice(dir.length).split('/')
      children.set(head, rest.length ? 'dir' : 'file')
    }
    return { value: [...children].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  return store
}

/** Stubs what `session.start` calls, with the config folder at ROOT. */
function session(on: On, files: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: ROOT })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'Compact', source: 'builtin' as const }] }))
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Run a command', mcp: false }] }))
  return { files: disk(on, files), clock }
}

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }
const ENGINE = { kind: 'engine' as const }

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

test('turned-off skills leave the listing and the Skill tool, and other skills get a folder', async ($, on) => {
  const { files } = session(on, {
    [`${ROOT}/skills/my-skill/SKILL.md`]: '---\nname: my-skill\n---\n',
    [`${ROOT}/skills/disabled/old-skill/SKILL.md`]: '---\nname: old-skill\n---\n',
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ran' }))
  await start($)

  const listing = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })
  expect(listing.text).toBe(LISTING.replace('- old-skill: Turned off.\n', ''))
  expect(JSON.parse(files.get(`${ROOT}/skills/anthropic-skills__pdf/skill.json`)!)).toMatchObject({ name: 'anthropic-skills:pdf', source: 'syncedSkills' })
  expect(files.has(`${ROOT}/skills/my-skill/skill.json`)).toBe(false)

  expect(await $.tool.call({ tool: 'Skill', skill: 'old-skill' })).toMatchObject({ deny: expect.stringMatching(/turned off/) })
  expect(await $.tool.call({ tool: 'Skill', skill: 'my-skill' })).toMatchObject({ result: 'ran' })
})

test('system prompt sections follow their files', async ($, on) => {
  const { files } = session(on, {
    [`${ROOT}/prompts/disabled/tone.md`]: 'old tone',
    [`${ROOT}/prompts/tools.md`]: 'my own tools text',
    [`${ROOT}/settings-manager/prompt-defaults.json`]: JSON.stringify({ tools: 'core tools v1' }),
  })
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'core intro', scope: 'shared' as const },
      { id: 'tools', text: 'core tools v2', scope: 'shared' as const },
      { id: 'tone', text: 'core tone', scope: 'shared' as const },
    ],
  }))
  await start($)

  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => [s.id, s.text])).toEqual([
    ['intro', 'core intro'],
    ['tools', 'my own tools text'],
  ])
  expect(files.get(`${ROOT}/prompts/intro.md`)).toBe('core intro')
})

test('originals follow Claude while edits win, and a reset file follows Claude again', async ($, on) => {
  let live = 'core tools v2'
  const { files, clock } = session(on, {
    [`${ROOT}/prompts/tools.md`]: 'my own tools text',
    [`${ROOT}/prompts/reminders/auto_mode.md`]: 'my auto mode text',
    [`${ROOT}/settings-manager/prompt-defaults.json`]: JSON.stringify({ tools: 'core tools v1', 'prompts/reminders/auto_mode': 'Auto mode is on.' }),
  })
  on('prompt.compose', () => ({ sections: [{ id: 'tools', text: live, scope: 'shared' as const }] }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  await start($)
  const compose = async () => (await $.prompt.compose(COMPOSE)).sections[0]?.text
  const originals = () => JSON.parse(files.get(`${ROOT}/settings-manager/prompt-defaults.json`)!)

  expect(await compose()).toBe('my own tools text')
  expect(await $.prompt.attachment({ type: 'auto_mode', text: 'Auto mode is on.', origin: ENGINE })).toEqual({ text: 'my auto mode text' })
  await clock.advance(2000)
  expect(originals()).toMatchObject({ tools: 'core tools v2', 'prompts/reminders/auto_mode': 'Auto mode is on.' })

  files.set(`${ROOT}/prompts/tools.md`, originals().tools)
  live = 'core tools v3'
  expect(await compose()).toBe('core tools v3')
  expect(files.get(`${ROOT}/prompts/tools.md`)).toBe('core tools v3')
})

test('turned-off subagents, reminders and commands are withheld', async ($, on) => {
  const { files } = session(on, {
    [`${ROOT}/agents/disabled/Plan.json`]: JSON.stringify({ name: 'Plan' }),
    [`${ROOT}/prompts/reminders/disabled/todo_reminder.md`]: 'sample',
    [`${ROOT}/commands/disabled/compact.json`]: JSON.stringify({ name: 'compact' }),
  })
  const provider = { plugin: 'engine', tier: 'core' as const }
  on('agent.offer', () => ({ isOffered: true }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('command.run', () => ({ text: 'ran' }))
  await start($)

  expect(await $.agent.offer({ agent: 'Plan', description: 'Plans', source: 'built-in', provider })).toEqual({ isOffered: false })
  expect(await $.agent.offer({ agent: 'Explore', description: 'Explores', source: 'built-in', provider })).toEqual({ isOffered: true })
  expect(await $.prompt.attachment({ type: 'todo_reminder', text: 'todo', origin: { kind: 'engine' } })).toEqual({ text: null })
  expect(await $.prompt.attachment({ type: 'auto_mode', text: 'Auto mode is on.', origin: { kind: 'engine' } })).toEqual({ text: 'Auto mode is on.' })
  expect(files.get(`${ROOT}/prompts/reminders/auto_mode.md`)).toBe('Auto mode is on.')
  expect((await $.command.run({ command: 'compact', args: '' })).text).toMatch(/turned off/)
  expect(await $.command.run({ command: 'clear', args: '' })).toEqual({ text: 'ran' })
})

test('/settings-manager starts the window with the config folder', async ($, on) => {
  session(on)
  const runs: (readonly string[])[] = []
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await start($)

  // A session start starts the tray icon without opening the window.
  expect(runs[0]).toEqual([expect.anything(), expect.anything(), ROOT, '--tray'])
  expect(await $.command.run({ command: 'settings-manager', args: '' })).toEqual({})
  expect(runs[1]?.[0]).toBe('node')
  expect(runs[1]?.[1]).toMatch(/app\/main\.mjs$/)
  expect(runs[1]?.slice(2)).toEqual([ROOT])
})
