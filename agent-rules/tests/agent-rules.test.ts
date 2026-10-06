import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NAME = 'agent-rules'
const SURFACES = ['terminal', 'desktop'] as const
const SITE = { scroll: { offset: 0, bodyRows: 20 }, view: {} }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, ...SITE } } as const
const PANE = { component: 'Pane', requestId: 'mods', props: { title: 'Mods', isFocused: false, bodyColumns: 40, placement: 'dock', ...SITE } } as const
const SPAWN = { tool_use_id: 't1', prompt: 'p', description: 'd', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: true, fork: false } as const
const DONE = { value: undefined }
/** Marks a tool call as a subagent's. */
const SUB: object = { agentId: 'sub' }

/** Answers the calls agent-rules makes beneath it, and returns what it showed and stored. */
const world = (on: On, agents: { id: string }[] = [], stored: Record<string, unknown> = {}) => {
  const toasts: string[] = []
  const shown: string[] = []
  on('store.get', ($, e) => ({ value: stored[e.key] }))
  on('store.set', ($, e) => ((stored[e.key] = e.value), DONE))
  on('ui.toast', ($, e) => (toasts.push(e.text), DONE))
  on('ui.open', ($, e) => (shown.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', ($, e) => (shown.splice(shown.indexOf(e.id), 1), DONE))
  on('ui.panes', () => ({ value: shown.map(id => ({ id, title: 'Mods', isShown: true, isFocused: false, isPlaced: true })) }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.register', ($, e) => ({ value: { agent: `${NAME}:${e.name}` } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${NAME}__${e.name}` } }))
  on('agent.list', () => ({ value: agents.map(agent => ({ ...agent, description: '', type: 'general-purpose', status: 'completed' })) }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({ result: 'ran' }))
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'parent', agentId: 'a1' }))

  return { toasts, shown, stored }
}

test('the band button counts the toggles and opens and closes the pane', async ($, on) => {
  const { shown } = world(on)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: NAME, surface, ...BAND })
    const pane = await $.ui.mount({ plugin: NAME, surface, ...PANE })
    const count = async () => (await band.find({ key: 'mods' }))?.props.label
    const prop = async (key: string, name: string) => (await pane.find({ key }))?.props[name]
    expect(await count()).toBe('Mods · 0 on')

    await band.press({ key: 'mods' })
    expect(shown).toEqual(['mods'])
    await band.press({ key: 'mods' })
    expect(shown).toEqual([])

    await pane.press({ key: 'tasks' })
    expect(await prop('tasks', 'label')).toBe('●')
    expect(await count()).toBe('Mods · 1 on')

    await pane.select({ key: 'mode', value: 'noSubagents' })
    expect(await prop('mode', 'value')).toBe('noSubagents')
    expect(await count()).toBe('Mods · 2 on')

    await pane.press({ key: 'tasks' })
    await pane.select({ key: 'mode', value: 'default' })
    expect(await count()).toBe('Mods · 0 on')
    await band.unmount()
    await pane.unmount()
  }
})

test('orchestrator mode denies main-agent tools outside the open set', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: NAME, surface: 'desktop', ...PANE })
  expect((await $.tool.call({ tool: 'Read', tool_use_id: 'r0', file_path: 'a.md' })).result).toBe('ran')
  await ui.select({ key: 'mode', value: 'orchestrator' })

  expect((await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'a.md' })).deny).toMatch('Orchestrator mode')
  expect((await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: 'a.md', ...SUB })).result).toBe('ran')
  expect((await $.tool.call({ tool: 'TaskList', tool_use_id: 'r3' })).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Agent', tool_use_id: 'r4', description: 'd', prompt: 'p' })).result).toBe('ran')

  const entered = await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(entered.context?.[0]).toMatch('Orchestrator mode is on')
})

test('spawns are capped, routed by agent type, and refused in no-subagents mode', async ($, on) => {
  const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  world(on, agents)

  expect((await $.agent.spawn({ ...SPAWN, subagentType: 'agent-rules:reader' })).model).toBe('haiku')
  expect((await $.agent.spawn({ ...SPAWN, subagentType: 'agent-rules:editor' })).model).toBe('sonnet')
  expect((await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose' })).model).toBe('parent')

  agents.push({ id: 'd' })
  expect((await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose' })).deny).toMatch('cap of 4 subagents. Reuse one with SendMessage: a, b, c, d.')

  const ui = await $.ui.mount({ plugin: NAME, surface: 'desktop', ...PANE })
  await ui.select({ key: 'mode', value: 'noSubagents' })
  expect((await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose' })).deny).toMatch('No-subagents mode')
})

test('the pane changes settings, keeps snippets and saves defaults', async ($, on) => {
  const { stored } = world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: NAME, surface, ...PANE })
    const prop = async (key: string, name: string) => (await ui.find({ key }))?.props[name]
    const flipCards = async () => {
      for (const key of ['delegation', 'rewrite', 'append', 'ask']) {
        await ui.press({ key: `more:${key}` })
      }
    }

    expect(await ui.find({ key: 'cap' })).toBeUndefined()
    expect(await ui.find({ key: 'more:tasks' })).toBeUndefined()
    await flipCards()
    expect(await prop('more:ask', 'label')).toBe('▾')
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    await ui.select({ key: 'mode', value: 'orchestrator' })

    await ui.select({ key: 'cap', value: '0' })
    await ui.select({ key: 'style', value: 'expand' })
    await ui.press({ key: 'hint' })
    await ui.select({ key: 'open', value: 'Read' })
    await ui.input({ key: 'snippet', text: ' Run the tests ' })
    await ui.press({ key: 'snippet:0' })

    expect(await prop('cap', 'value')).toBe('0')
    expect(await prop('style', 'value')).toBe('expand')
    expect(await prop('hint', 'label')).toBe('Off')
    expect(await prop('open:Read', 'label')).toBe('Read ✕')
    expect(await prop('snippet:0', 'label')).toBe('○')
    expect(stored.defaults).toMatchObject({ snippets: [{ text: 'Run the tests', isOn: true }] })

    await ui.press({ key: 'save' })
    expect(stored.defaults).toMatchObject({ cap: 0, style: 'expand', hint: false, snippets: [{ text: 'Run the tests', isOn: false }] })

    await ui.press({ key: 'drop:0' })
    await ui.press({ key: 'hint' })
    await ui.press({ key: 'open:Read' })
    await ui.select({ key: 'cap', value: '4' })
    await ui.select({ key: 'style', value: 'fix wording' })
    expect(await ui.find({ key: 'snippet:0' })).toBeUndefined()
    expect(await ui.find({ key: 'open:Read' })).toBeUndefined()
    expect(stored.defaults).toMatchObject({ snippets: [] })
    await ui.select({ key: 'mode', value: 'default' })
    await flipCards()
    await ui.unmount()
  }
})

test('a new session starts from the stored defaults', async ($, on) => {
  world(on, [], { defaults: { cap: 7, on: { ask: true, orchestrator: true } } })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ plugin: NAME, surface: 'desktop', ...BAND })
  expect((await band.find({ key: 'mods' }))?.props.label).toBe('Mods · 2 on')
  const pane = await $.ui.mount({ plugin: NAME, surface: 'desktop', ...PANE })
  expect((await pane.find({ key: 'ask' }))?.props.label).toBe('●')
  expect((await pane.find({ key: 'mode' }))?.props.value).toBe('orchestrator')
  await pane.press({ key: 'more:delegation' })
  await pane.press({ key: 'more:context' })
  expect((await pane.find({ key: 'cap' }))?.props.value).toBe('7')
  expect((await pane.find({ key: 'ctx' }))?.props.value).toBe('25')
})

test('ui_test changes what the UI draws and leaves the session alone', async ($, on) => {
  const { shown, toasts } = world(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const call = (input: object) => $.tool.call({ tool: 'mcp__agent-rules__ui_test', tool_use_id: 'u', ...input })
  const band = await $.ui.mount({ plugin: NAME, surface: 'desktop', ...BAND })
  const pane = await $.ui.mount({ plugin: NAME, surface: 'desktop', ...PANE })
  const count = async () => (await band.find({ key: 'mods' }))?.props.label

  await call({ preview: { config: { mode: 'orchestrator' }, expanded: ['delegation'] }, pane: 'open', toast: 'hi' })
  expect(shown).toEqual(['mods'])
  expect(toasts).toEqual(['hi'])
  expect(await count()).toBe('Mods · 1 on')
  expect((await pane.find({ key: 'mode' }))?.props.value).toBe('orchestrator')
  expect((await pane.find({ key: 'cap' }))?.props.value).toBe('4')
  expect((await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: 'a.md' })).result).toBe('ran')

  await call({ preview: { config: { hint: false }, expanded: ['ask'] } })
  await pane.press({ key: 'hint' })

  await call({ preview: null, pane: 'close' })
  expect(shown).toEqual([])
  expect(await count()).toBe('Mods · 0 on')
  expect(await pane.find({ key: 'cap' })).toBeUndefined()
  await pane.press({ key: 'more:ask' })
  expect((await pane.find({ key: 'hint' }))?.props.label).toBe('Off')
})

test('/mods flips a toggle by name and opens the pane bare', async ($, on) => {
  const { shown } = world(on)
  const run = (args: string) =>
    $.command.run({ command: 'mods', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  expect((await run('ask tool')).text).toBe('Ask tool on.')
  expect((await run('no subagents')).text).toBe('Delegation: No subagents.')
  expect((await run('noSubagents')).text).toBe('Delegation: Default.')
  expect((await run('nope')).text).toMatch('Unknown mod')
  expect((await run('')).text).toBe('Mods pane opened.')
  expect(shown).toEqual(['mods'])
})
