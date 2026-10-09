import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NAME = 'agent-delegation'
const SPAWN = { tool_use_id: 't1', prompt: 'p', description: 'd', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: true, fork: false } as const
/** Marks a tool call as a subagent's. */
const SUB: object = { agentId: 'sub' }

/** Answers the calls agent-delegation makes beneath it, with these subagents. */
const world = (on: On, agents: { id: string }[] = []) => {
  on('agent.register', ($, e) => ({ value: { agent: `${NAME}:${e.name}` } }))
  on('agent.list', () => ({ value: agents.map(agent => ({ ...agent, description: '', type: 'general-purpose', status: 'completed' })) }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({ result: 'ran' }))
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'parent', agentId: 'a1' }))
}
let calls = 0
const call = ($: Engine, tool: string, more: object = {}) => $.tool.call({ tool, tool_use_id: `r${calls++}`, ...more } as never)
const typed = ($: Engine) => $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
const spawn = ($: Engine, subagentType: string) => $.agent.spawn({ ...SPAWN, subagentType })

test('default mode leaves tools alone, routes models by agent type and caps spawns', async ($, on) => {
  const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  world(on, agents)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  expect((await call($, 'Read', { file_path: 'a.md' })).result).toBe('ran')
  expect((await typed($)).context).toBeUndefined()
  expect((await spawn($, `${NAME}:reader`)).model).toBe('haiku')
  expect((await spawn($, `${NAME}:editor`)).model).toBe('sonnet')
  expect((await spawn($, 'general-purpose')).model).toBe('parent')

  agents.push({ id: 'd' })
  expect((await spawn($, 'general-purpose')).deny).toMatch('cap of 4 subagents. Reuse one with SendMessage: a, b, c, d.')
})

test('the cap and model settings apply', { options: { cap: 0, reader: 'opus', other: 'haiku' } }, async ($, on) => {
  world(on, Array.from({ length: 9 }, (_, i) => ({ id: `a${i}` })))

  expect((await spawn($, `${NAME}:reader`)).model).toBe('opus')
  expect((await spawn($, 'general-purpose')).model).toBe('haiku')
})

test('orchestrator mode denies main-agent tools outside the open set', { options: { mode: 'Orchestrator', open: 'Agent, Tasks ,Skill' } }, async ($, on) => {
  world(on)

  expect((await call($, 'Read', { file_path: 'a.md' })).deny).toMatch('Orchestrator mode')
  expect((await call($, 'Read', { file_path: 'a.md', ...SUB })).result).toBe('ran')
  expect((await call($, 'TaskList')).result).toBe('ran')
  expect((await call($, 'Agent', { description: 'd', prompt: 'p' })).result).toBe('ran')
  expect((await typed($)).context?.[0]).toMatch('only these tools yourself: Agent, Tasks, Skill.')
})

test('no-subagents mode refuses spawns', { options: { mode: 'No subagents' } }, async ($, on) => {
  world(on)

  expect((await spawn($, 'general-purpose')).deny).toMatch('No-subagents mode')
  expect((await typed($)).context?.[0]).toMatch('No-subagents mode is on')
  expect((await call($, 'Read', { file_path: 'a.md' })).result).toBe('ran')
})

test('nothing applies while the mod is off', { options: { isOn: false, mode: 'Orchestrator', cap: 1 } }, async ($, on) => {
  world(on, [{ id: 'a' }])

  expect((await call($, 'Read', { file_path: 'a.md' })).result).toBe('ran')
  expect((await typed($)).context).toBeUndefined()
  expect((await spawn($, `${NAME}:reader`)).model).toBe('parent')
})
