import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/** Answers the calls turn-rules makes beneath it, with this task list. */
const world = (on: On, tasks: object[] = []) => {
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'TaskList' }, () => ({ result: { tasks } }))
}
const OPEN = [
  { id: '1', subject: 'Write the parser', status: 'completed', blockedBy: [] },
  { id: '2', subject: 'Test the parser', status: 'in_progress', blockedBy: [] },
  { id: '3', subject: 'Ship it', status: 'pending', blockedBy: [] },
]
const typed = ($: Engine) => $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
const stop = ($: Engine, last: string) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: last })

test('nothing is added or blocked with both rules off', { options: { ask: false, tasks: false } }, async ($, on) => {
  world(on, OPEN)
  expect((await typed($)).context).toBeUndefined()
  expect((await stop($, 'Which one?')).block).toBeUndefined()
  expect((await stop($, 'Done.')).block).toBeUndefined()
})

test('both hidden hints are added by default', async ($, on) => {
  world(on)
  expect((await typed($)).context).toHaveLength(2)
})

test('the ask hint follows the hint setting', { options: { hint: false } }, async ($, on) => {
  world(on)
  const { context } = await typed($)
  expect(context).toHaveLength(1)
  expect(context?.[0]).toMatch('task list')
})

test('a reply that ends with a question is sent back to AskUserQuestion', { options: { tasks: false } }, async ($, on) => {
  world(on)
  expect((await stop($, 'Which library do you want?  \n')).block).toMatch('AskUserQuestion')
  expect((await stop($, 'Done.')).block).toBeUndefined()
})

test('open tasks keep the turn going, a question ends it, and the blocks are capped', { options: { ask: false } }, async ($, on) => {
  world(on, OPEN)
  await typed($)

  expect((await stop($, 'Done.')).block).toMatch('#2 Test the parser; #3 Ship it.')
  expect((await stop($, 'Which one?')).block).toBeUndefined()
  expect((await stop($, 'Done.')).block).toBeDefined()
  expect((await stop($, 'Done.')).block).toBeDefined()
  expect((await stop($, 'Done.')).block).toBeUndefined()

  await typed($)
  expect((await stop($, 'Done.')).block).toBeDefined()
})

test('a finished task list lets the turn end', async ($, on) => {
  world(on, [OPEN[0]!])
  expect((await stop($, 'Done.')).block).toBeUndefined()
})
