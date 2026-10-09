import type { EngineInterface, Register } from 'claude-code'

type Options = { ask: boolean; hint: boolean; tasks: boolean }

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

export const register: Register = (on, options) => {
  const c = options as Options
  const hints = [...(c.ask && c.hint ? [ASK_HINT] : []), ...(c.tasks ? [TASK_HINT] : [])]
  // Turn ends this mod refused since the last prompt.
  let blocks = 0

  on('prompt.submit', ($, e, next) => {
    blocks = 0

    return next(hints.length ? { ...e, context: [...(e.context ?? []), ...hints] } : e)
  })

  on('classic.Stop', async ($, e, next) => {
    const asks = (e.last_assistant_message ?? '').trimEnd().endsWith('?')
    const block = blocks >= MAX_BLOCKS ? undefined : c.ask && asks ? ASK_BLOCK : c.tasks && !asks ? await openTasks($) : undefined

    if (!block) {
      return next(e)
    }

    blocks += 1

    return { block }
  })
}
