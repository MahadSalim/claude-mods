import { read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const CONFIG = { plugin: 'agent-rules', key: 'config' } as const

const MAX_BLOCKS = 3
const ASK_HINT = 'When you need an answer from the user, call the AskUserQuestion tool. Do not end a reply with a question.'
const ASK_BLOCK = 'Your reply ends with a question. Ask it again with the AskUserQuestion tool.'
const TASK_HINT =
  'Track work of three or more steps in the task list. Create the tasks first. Mark each one in_progress when you start it and completed when you finish it. Do not end the turn while a task is open, unless you are asking the user a question.'

type Task = { id: string; subject: string; status: string }

/** Returns the re-prompt naming the open tasks, or undefined with none open. */
const openTasks = async ($: EngineInterface) => {
  const { result } = await $.tool.call({ tool: 'TaskList' }).catch(() => ({ result: undefined }))
  const open = ((result as { tasks?: Task[] } | undefined)?.tasks ?? []).filter(task => task.status !== 'completed')

  return open.length
    ? `The task list still has open tasks: ${open.map(task => `#${task.id} ${task.subject}`).join('; ')}. Finish them and mark them completed, or mark the ones that no longer apply deleted. Then end the turn.`
    : undefined
}

export const register: Register = on => {
  // Turn ends this mod refused since the last prompt.
  let blocks = 0

  on('prompt.submit', async ($, e, next) => {
    blocks = 0
    const c = await read($, CONFIG)
    const hints = [c?.on.ask && c.hint && ASK_HINT, c?.on.tasks && TASK_HINT].filter(hint => typeof hint === 'string')

    return next(hints.length ? { ...e, context: [...(e.context ?? []), ...hints] } : e)
  })

  on('classic.Stop', async ($, e, next) => {
    const c = await read($, CONFIG)
    const asks = (e.last_assistant_message ?? '').trimEnd().endsWith('?')
    const block = blocks >= MAX_BLOCKS ? undefined : c?.on.ask && asks ? ASK_BLOCK : c?.on.tasks && !asks ? await openTasks($) : undefined

    if (!block) {
      return next(e)
    }

    blocks += 1

    return { block }
  })
}
