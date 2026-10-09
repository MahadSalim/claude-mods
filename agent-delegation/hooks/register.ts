import type { Register } from 'claude-code'

type Model = 'inherit' | 'haiku' | 'sonnet' | 'opus'
type Options = { isOn: boolean; mode: 'Default' | 'Orchestrator' | 'No subagents'; open: string; cap: number; reader: Model; editor: Model; other: Model }

// Tool names one setting entry stands for.
const GROUPS: Record<string, string[]> = {
  Agent: ['Agent', 'TaskOutput', 'TaskStop'],
  Tasks: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite'],
}

// Agent types this mod ships, and the model setting each one reads.
const ROLES: Record<string, 'reader' | 'editor'> = { 'agent-delegation:reader': 'reader', 'agent-delegation:editor': 'editor' }
const AGENTS = [
  {
    name: 'reader',
    description: 'Read-only work: find, read and summarise files or web pages. Changes nothing.',
    prompt: 'You read and report. Find what the task asks for, read it, and answer with the facts and their file paths. Change nothing.',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  },
  {
    name: 'editor',
    description: 'Work that changes files: write code, edit files, run commands.',
    prompt: 'You carry out one task that changes files. Make the change, verify it, and report what you changed.',
  },
]

export const register: Register = (on, options) => {
  const c = options as Options
  /** The delegation mode in force: none while the mod is off. */
  const mode = c.isOn ? c.mode : undefined
  const open = c.open.split(',').map(name => name.trim()).filter(Boolean)
  const note = mode === 'Orchestrator'
    ? `Orchestrator mode is on. Delegate all work to subagents with the Agent tool. You may call only these tools yourself: ${open.join(', ')}.`
    : mode === 'No subagents'
      ? 'No-subagents mode is on. Do not start new subagents. SendMessage to an existing subagent still works.'
      : undefined

  on('session.start', async ($, e, next) => {
    await Promise.all(AGENTS.map(spec => $.agent.register(spec)))

    return next(e)
  })

  on('prompt.submit', ($, e, next) => next(note ? { ...e, context: [...(e.context ?? []), note] } : e))

  on('tool.call', ($, e, next) => {
    const isMain = e.agentId === undefined && next.origin.plugin === 'engine'
    const isOpen = open.some(name => (GROUPS[name] ?? [name]).includes(e.tool))

    return mode === 'Orchestrator' && isMain && !isOpen
      ? { deny: `${$.plugin.name}: Orchestrator mode is on. The main agent may not call ${e.tool}. Delegate this work to a subagent with the Agent tool.` }
      : next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (!c.isOn) {
      return next(e)
    }

    if (c.mode === 'No subagents') {
      return { deny: `${$.plugin.name}: No-subagents mode is on. Do the work yourself, or SendMessage an existing subagent.` }
    }

    const agents = c.cap ? await $.agent.list() : []

    if (c.cap && agents.length >= c.cap) {
      const names = agents.map(agent => agent.name ?? agent.id).join(', ')

      return { deny: `${$.plugin.name}: This session reached its cap of ${c.cap} subagents. Reuse one with SendMessage: ${names}.` }
    }

    const model = c[ROLES[e.subagentType] ?? 'other']

    return next(model === 'inherit' || e.fork ? e : { ...e, model })
  })
}
