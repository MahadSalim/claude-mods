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
const configure = ($: Engine, isOn: object, hint = true) =>
  $.command.run({
    command: 'cfg',
    args: JSON.stringify({ on: isOn, hint }),
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

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

test('nothing is added or blocked with no config and with both toggles off', { plugins: [hub] }, async ($, on) => {
  world(on, OPEN)
  expect((await typed($)).context).toBeUndefined()
  expect((await stop($, 'Which one?')).block).toBeUndefined()
  await configure($, {})
  expect((await typed($)).context).toBeUndefined()
  expect((await stop($, 'Done.')).block).toBeUndefined()
})

test('the hidden hints follow the toggles and the hint setting', { plugins: [hub] }, async ($, on) => {
  world(on)
  await configure($, { ask: true, tasks: true })
  expect((await typed($)).context).toHaveLength(2)
  await configure($, { ask: true, tasks: true }, false)
  expect((await typed($)).context?.[0]).toMatch('task list')
  expect((await typed($)).context).toHaveLength(1)
})

test('a reply that ends with a question is sent back to AskUserQuestion', { plugins: [hub] }, async ($, on) => {
  world(on)
  await configure($, { ask: true })
  expect((await stop($, 'Which library do you want?  \n')).block).toMatch('AskUserQuestion')
  expect((await stop($, 'Done.')).block).toBeUndefined()
})

test('open tasks keep the turn going, a question ends it, and the blocks are capped', { plugins: [hub] }, async ($, on) => {
  world(on, OPEN)
  await configure($, { tasks: true })
  await typed($)

  expect((await stop($, 'Done.')).block).toMatch('#2 Test the parser; #3 Ship it.')
  expect((await stop($, 'Which one?')).block).toBeUndefined()
  expect((await stop($, 'Done.')).block).toBeDefined()
  expect((await stop($, 'Done.')).block).toBeDefined()
  expect((await stop($, 'Done.')).block).toBeUndefined()

  await typed($)
  expect((await stop($, 'Done.')).block).toBeDefined()
})

test('a finished task list lets the turn end', { plugins: [hub] }, async ($, on) => {
  world(on, [OPEN[0]!])
  await configure($, { tasks: true })
  expect((await stop($, 'Done.')).block).toBeUndefined()
})
