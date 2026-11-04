import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = 'C:/cfg'
/** Where the window records the prompt files that the person edited. */
const EDITS = `${ROOT}/settings-manager/prompt-edits.json`
/** What is turned off, by name. */
const DISABLED = `${ROOT}/settings-manager/disabled.json`
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
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  return { files: disk(on, files), clock }
}

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }
const ENGINE = { kind: 'engine' as const }

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

test('skills in disabled.json leave the listing and the Skill tool, and no skill gets a folder', async ($, on) => {
  const { files, clock } = session(on, {
    [`${ROOT}/skills/my-skill/SKILL.md`]: '---\nname: my-skill\n---\n',
    [`${ROOT}/skills/old-skill/SKILL.md`]: '---\nname: old-skill\n---\n',
    [DISABLED]: JSON.stringify({ skills: ['old-skill'] }),
    // An older version noted a synced skill as yours.
    [`${ROOT}/settings-manager/catalog.json`]: JSON.stringify({ skills: { 'anthropic-skills:pdf': { source: 'userSettings' } } }),
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ran' }))
  await start($)

  const listing = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })
  expect(listing.text).toBe(LISTING.replace('- old-skill: Turned off.\n', ''))
  expect([...files.keys()].filter(path => path.endsWith('skill.json'))).toEqual([])
  await clock.advance(2000)
  expect(JSON.parse(files.get(`${ROOT}/settings-manager/catalog.json`)!).skills).toMatchObject({
    'my-skill': { source: 'userSettings' },
    'anthropic-skills:pdf': { source: 'syncedSkills' },
  })

  expect(await $.tool.call({ tool: 'Skill', skill: 'old-skill' })).toMatchObject({ deny: expect.stringMatching(/turned off/) })
  expect(await $.tool.call({ tool: 'Skill', skill: 'my-skill' })).toMatchObject({ result: 'ran' })
})

test('a disabled.json that is not valid JSON turns nothing off', async ($, on) => {
  session(on, { [DISABLED]: '{ not json' })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  await start($)

  expect((await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: ENGINE })).text).toBe(LISTING)
})

test('system prompt sections follow their files', async ($, on) => {
  const { files } = session(on, {
    [DISABLED]: JSON.stringify({ sections: ['tone'] }),
    [`${ROOT}/prompts/tools.md`]: 'my own tools text',
    [`${ROOT}/settings-manager/prompt-defaults.json`]: JSON.stringify({ tools: 'core tools v1' }),
    [EDITS]: JSON.stringify({ tools: {} }),
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
    [EDITS]: JSON.stringify({ tools: {}, 'prompts/reminders/auto_mode': {} }),
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

  // A reset in the window writes the original back and removes the edit record.
  files.set(`${ROOT}/prompts/tools.md`, originals().tools)
  files.set(EDITS, JSON.stringify({ 'prompts/reminders/auto_mode': {} }))
  await $.turn.start({ text: '', turnId: 't1' })
  live = 'core tools v3'
  expect(await compose()).toBe('core tools v3')
  expect(files.get(`${ROOT}/prompts/tools.md`)).toBe('core tools v3')
})

test('a file that differs from the live text without an edit record is not used', async ($, on) => {
  // Another session wrote its own text to the file, and this session's stored original is older.
  const { files } = session(on, {
    [`${ROOT}/prompts/tools.md`]: 'text from another session',
    [`${ROOT}/prompts/reminders/auto_mode.md`]: 'Auto mode text from another session.',
    [`${ROOT}/settings-manager/prompt-defaults.json`]: JSON.stringify({ tools: 'core tools v1', 'prompts/reminders/auto_mode': 'Auto mode v1.' }),
  })
  on('prompt.compose', () => ({ sections: [{ id: 'tools', text: 'core tools v2', scope: 'shared' as const }] }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  await start($)

  expect((await $.prompt.compose(COMPOSE)).sections[0]?.text).toBe('core tools v2')
  expect(await $.prompt.attachment({ type: 'auto_mode', text: 'Auto mode v2.', origin: ENGINE })).toEqual({ text: 'Auto mode v2.' })
  expect(files.get(`${ROOT}/prompts/tools.md`)).toBe('core tools v2')
})

test('messages sent mid-turn reach Claude as they are, and are never saved or replaced', async ($, on) => {
  const queued = (words: string) => `The user sent a new message while you were working:\n${words}\n\nAddress the message above.`
  const OLD = queued('I made this change yesterday.')
  // The state that the old code left behind: another session's message saved as the reminder's text,
  // marked as edited and turned off in every way the mod knows.
  const { files } = session(on, {
    [`${ROOT}/prompts/reminders/queued_command.md`]: OLD,
    // Turning off the person's messages is refused: they still reach Claude.
    [DISABLED]: JSON.stringify({ reminders: ['queued_command'] }),
    [`${ROOT}/settings-manager/prompt-defaults.json`]: JSON.stringify({ 'prompts/reminders/queued_command': queued('Something else.') }),
    [EDITS]: JSON.stringify({ 'prompts/reminders/queued_command': {} }),
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  await start($)

  for (const words of ['Push it when you are done.', 'Also add a test.']) {
    expect(await $.prompt.attachment({ type: 'queued_command', text: queued(words), origin: ENGINE })).toEqual({ text: queued(words) })
  }
  expect(files.get(`${ROOT}/prompts/reminders/queued_command.md`)).toBe(OLD)
  expect([...files.values()].some(text => text.includes('Push it when you are done.'))).toBe(false)
})

test('file contents can be turned off, but are never saved or replaced', async ($, on) => {
  const { files } = session(on, {
    [DISABLED]: JSON.stringify({ reminders: ['edited_text_file'] }),
    [`${ROOT}/prompts/reminders/file.md`]: 'contents from another session',
    [EDITS]: JSON.stringify({ 'prompts/reminders/file': {} }),
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  await start($)

  expect(await $.prompt.attachment({ type: 'edited_text_file', text: 'a.ts changed', origin: ENGINE })).toEqual({ text: null })
  expect(await $.prompt.attachment({ type: 'file', text: 'contents of a.ts', origin: ENGINE })).toEqual({ text: 'contents of a.ts' })
  expect([...files.values()].some(text => text.includes('contents of a.ts'))).toBe(false)
})

test('text that a hook or a plugin attached is passed on as it is', async ($, on) => {
  const { files } = session(on, {
    [`${ROOT}/prompts/reminders/hook_additional_context.md`]: 'replaced',
    [EDITS]: JSON.stringify({ 'prompts/reminders/hook_additional_context': {} }),
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  await start($)

  const origin = { kind: 'hook' as const, event: 'UserPromptSubmit' }
  expect(await $.prompt.attachment({ type: 'hook_additional_context', text: 'from my hook', origin })).toEqual({ text: 'from my hook' })
  expect(files.get(`${ROOT}/prompts/reminders/hook_additional_context.md`)).toBe('replaced')

  // Turning that text off still works.
  files.set(DISABLED, JSON.stringify({ reminders: ['hook_additional_context'] }))
  await $.turn.start({ text: '', turnId: 't1' })
  expect(await $.prompt.attachment({ type: 'hook_additional_context', text: 'from my hook', origin })).toEqual({ text: null })
})

test('turned-off subagents, reminders and commands are withheld', async ($, on) => {
  const { files } = session(on, {
    [DISABLED]: JSON.stringify({ agents: ['Plan'], reminders: ['todo_reminder'], commands: ['compact'] }),
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

test('the context breakdown is saved per session after start and after each turn', async ($, on) => {
  const { files, clock } = session(on)
  const asked: unknown[] = []
  let messages = 100
  on('session.id', () => ({ value: 'abc' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', ($, e) => {
    asked.push(e.breakdown)
    const categories = [
      { name: 'System prompt', tokens: 8600, color: 'promptBorder', isDeferred: false, kind: 'used' as const },
      { name: 'Messages', tokens: messages, color: 'inactive', isDeferred: false, kind: 'used' as const },
      { name: 'MCP tools (deferred)', tokens: 5000, color: 'inactive', isDeferred: true, kind: 'deferred' as const },
    ]
    const breakdown = {
      categories,
      totalTokens: 8600 + messages,
      maxTokens: 400000,
      rawMaxTokens: 400000,
      autocompactSource: 'auto' as const,
      percentage: 2,
      gridRows: [[{ color: 'inactive', isFilled: true, categoryName: 'Messages', tokens: messages, percentage: 0, squareFullness: 1 }]],
      model: 'claude-opus-5-5',
      memoryFiles: [{ path: 'C:/cfg/CLAUDE.md', type: 'User', tokens: 40 }],
      mcpTools: [{ name: 'mcp__github__get_me', serverName: 'github', tokens: 300, isLoaded: false }],
      agents: [{ agentType: 'reviewer', source: 'userSettings', tokens: 90 }],
      skills: { totalSkills: 1, includedSkills: 1, tokens: 50, skillFrontmatter: [{ name: 'pdf', source: 'plugin' as const, tokens: 50 }] },
      isAutoCompactEnabled: true,
      apiUsage: null,
    }
    return { value: { startedAt: 0, context: { window: 400000, breakdown }, rateLimits: [] } }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const saved = () => JSON.parse(files.get(`${ROOT}/settings-manager/context/abc.json`) ?? 'null')
  await start($)

  await clock.advance(3000)
  expect(asked).toEqual(['full'])
  expect(saved()).toMatchObject({
    id: 'abc',
    cwd: '/work',
    totalTokens: 8700,
    maxTokens: 400000,
    categories: [{ name: 'System prompt', tokens: 8600, kind: 'used' }, { name: 'Messages', tokens: 100 }, { kind: 'deferred' }],
    mcpTools: [{ serverName: 'github', tokens: 300 }],
    skills: [{ name: 'pdf', tokens: 50 }],
    agents: [{ name: 'reviewer', tokens: 90 }],
  })
  expect(saved().gridRows).toBeUndefined()

  // A turn that changed the context counts again; one that did not, does not.
  messages = 2000
  await $.session.measure({ context: { window: 400000 }, rateLimits: [], changed: ['cost'] })
  await clock.advance(3000)
  expect(asked).toHaveLength(1)
  await $.session.measure({ context: { window: 400000 }, rateLimits: [], changed: ['context'] })
  await clock.advance(3000)
  expect(asked).toHaveLength(2)
  expect(saved().totalTokens).toBe(10600)
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
