import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 1000 lines of 400 bytes: about 100k tokens.
const BIG = Array.from({ length: 1000 }, () => 'x'.repeat(399)).join('\n')
const FILES: Record<string, string> = { 'big.md': BIG, 'small.md': 'hello', 'shot.png': BIG }

/** Answers the calls context-saver makes beneath it, from FILES and these agent-delegation settings. */
const world = (on: On, delegation: Record<string, unknown> = {}) => {
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ran' }))
  const text = (path: string) => FILES[path.split(/[\\/]/).pop() ?? '']
  on('fs.read', ($, e) => (text(e.path) === undefined ? { deny: 'ENOENT' } : { value: text(e.path)! }))
  on('fs.stat', ($, e) =>
    text(e.path) === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text(e.path)!.length, mtimeMs: 0, isLink: false } },
  )
  on('config.list', () => ({
    value: Object.entries(delegation).map(([field, value]) => ({
      key: `agent-delegation.${field}`,
      label: field,
      kind: 'text',
      value,
      provider: { plugin: 'agent-delegation', tier: 'user' },
      isLocked: false,
    })),
  }) as never)
}
let calls = 0
const read = ($: Engine, file_path: string, more: object = {}) => $.tool.call({ tool: 'Read', tool_use_id: `r${calls++}`, file_path, ...more })

test('reads pass while the mod is off', { options: { isOn: false } }, async ($, on) => {
  world(on)
  expect((await read($, 'big.md')).result).toBe('ran')
})

test('a whole-file read over the cap is refused for the main agent only', async ($, on) => {
  world(on, { isOn: false, mode: 'No subagents' })

  const refused = await read($, 'big.md')
  expect(refused.deny).toMatch('big.md is about 100k tokens. The cap is 25k.')
  expect(refused.deny).toMatch('Or read a slice')
  expect((await read($, 'big.md', { agentId: 'sub' })).result).toBe('ran')
  expect((await read($, 'small.md')).result).toBe('ran')
  expect((await read($, 'shot.png')).result).toBe('ran')
  expect((await read($, 'missing.md')).result).toBe('ran')
})

test('a slice passes under the cap and is refused over it', async ($, on) => {
  world(on)

  expect((await read($, 'big.md', { offset: 500, limit: 100 })).result).toBe('ran')
  expect((await read($, 'big.md', { limit: 600 })).deny).toMatch('about 60k tokens in that slice')
})

test('a slice counts as the whole file with slices off', { options: { slices: false } }, async ($, on) => {
  world(on)

  const refused = await read($, 'big.md', { offset: 500, limit: 100 })
  expect(refused.deny).toMatch('about 100k tokens.')
  expect(refused.deny).not.toMatch('Or read a slice')
})

test('the cap setting moves the line', { options: { ctx: 100 } }, async ($, on) => {
  world(on)
  expect((await read($, 'big.md')).result).toBe('ran')
})

test('reads pass while agent-delegation blocks subagents', async ($, on) => {
  world(on, { isOn: true, mode: 'No subagents' })
  expect((await read($, 'big.md')).result).toBe('ran')
})
