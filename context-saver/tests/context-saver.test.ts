import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

/** Stands in for agent-rules: `/cfg <json>` writes its config. */
const hub: Plugin = {
  name: 'agent-rules',
  register(on) {
    on('command.run', { command: 'cfg' }, async ($, e) => {
      await $.state.set({ plugin: 'agent-rules', key: 'config' }, JSON.parse(e.args))

      return { text: 'set' }
    })
  },
}
const configure = ($: Engine, config: object) =>
  $.command.run({
    command: 'cfg',
    args: JSON.stringify({ on: { context: true }, ctx: 25, slices: true, ...config }),
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

// 1000 lines of 400 bytes: about 100k tokens.
const BIG = Array.from({ length: 1000 }, () => 'x'.repeat(399)).join('\n')
const FILES: Record<string, string> = { 'big.md': BIG, 'small.md': 'hello', 'shot.png': BIG }

/** Answers the calls context-saver makes beneath it, from FILES. */
const world = (on: On) => {
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ran' }))
  const text = (path: string) => FILES[path.split(/[\\/]/).pop() ?? '']
  on('fs.read', ($, e) => (text(e.path) === undefined ? { deny: 'ENOENT' } : { value: text(e.path)! }))
  on('fs.stat', ($, e) =>
    text(e.path) === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text(e.path)!.length, mtimeMs: 0, isLink: false } },
  )
}
let calls = 0
const read = ($: Engine, file_path: string, more: object = {}) => $.tool.call({ tool: 'Read', tool_use_id: `r${calls++}`, file_path, ...more })

test('reads pass with no config and with the toggle off', { plugins: [hub] }, async ($, on) => {
  world(on)
  expect((await read($, 'big.md')).result).toBe('ran')
  await configure($, { on: {} })
  expect((await read($, 'big.md')).result).toBe('ran')
})

test('a whole-file read over the cap is refused for the main agent only', { plugins: [hub] }, async ($, on) => {
  world(on)
  await configure($, {})

  const refused = await read($, 'big.md')
  expect(refused.deny).toMatch('big.md is about 100k tokens. The cap is 25k.')
  expect(refused.deny).toMatch('Or read a slice')
  expect((await read($, 'big.md', { agentId: 'sub' })).result).toBe('ran')
  expect((await read($, 'small.md')).result).toBe('ran')
  expect((await read($, 'shot.png')).result).toBe('ran')
  expect((await read($, 'missing.md')).result).toBe('ran')
})

test('a slice passes under the cap and is refused over it', { plugins: [hub] }, async ($, on) => {
  world(on)
  await configure($, {})

  expect((await read($, 'big.md', { offset: 500, limit: 100 })).result).toBe('ran')
  expect((await read($, 'big.md', { limit: 600 })).deny).toMatch('about 60k tokens in that slice')

  await configure($, { slices: false })
  const refused = await read($, 'big.md', { offset: 500, limit: 100 })
  expect(refused.deny).toMatch('about 100k tokens.')
  expect(refused.deny).not.toMatch('Or read a slice')
})

test('the cap setting moves the line, and no-subagents mode turns the gate off', { plugins: [hub] }, async ($, on) => {
  world(on)
  await configure($, { ctx: 100 })
  expect((await read($, 'big.md')).result).toBe('ran')
  await configure($, { mode: 'noSubagents' })
  expect((await read($, 'big.md')).result).toBe('ran')
})
