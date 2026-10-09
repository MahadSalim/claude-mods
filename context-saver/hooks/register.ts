import type { EngineInterface, Register } from 'claude-code'

type Options = { isOn: boolean; ctx: number; slices: boolean }

const BYTES_PER_TOKEN = 4
// Files the Read tool does not return as text.
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/i

/** Whether the agent-delegation mod is on in its No subagents mode. */
const hasNoSubagents = async ($: EngineInterface) => {
  const rows = await $.config.list().catch(() => [])
  const held = (field: string) => rows.find(row => row.key === `agent-delegation.${field}`)?.value

  return held('isOn') === true && held('mode') === 'No subagents'
}

export const register: Register = (on, options) => {
  const c = options as Options

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (!c.isOn || e.agentId !== undefined || NOT_TEXT.test(e.file_path) || (await hasNoSubagents($))) {
      return next(e)
    }

    const isSlice = c.slices && e.limit !== undefined
    const start = Math.max(0, (e.offset ?? 1) - 1)
    const end = start + (e.limit ?? 0)
    const bytes = await (isSlice
      ? $.fs.read(e.file_path).then(text => text.split('\n').slice(start, end).join('\n').length)
      : $.fs.stat(e.file_path).then(stat => stat.size)
    ).catch(() => 0)
    const tokens = Math.round(bytes / BYTES_PER_TOKEN / 1000)

    return tokens > c.ctx
      ? {
          deny: `${$.plugin.name}: ${e.file_path} is about ${tokens}k tokens${isSlice ? ' in that slice' : ''}. The cap is ${c.ctx}k. Do not read it yourself. Start a subagent with the Agent tool, tell it what you need from the file, and work from its summary.${c.slices ? ' Or read a slice under the cap with offset and limit.' : ''}`,
        }
      : next(e)
  })
}
