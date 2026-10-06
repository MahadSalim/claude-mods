import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

const DONE = { value: undefined }
const SNIPPETS = [
  { text: 'Run the tests.', isOn: true },
  { text: 'Use British spelling.', isOn: false },
  { text: 'Keep it short.', isOn: true },
]

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
    args: JSON.stringify({ on: {}, apply: 'direct', style: 'fix wording', snippets: SNIPPETS, ...config }),
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

/** Answers the calls prompt-tools makes beneath it, and returns what it asked and showed. */
const world = (on: On, reply: object, pick = 'Rewritten') => {
  const seen = { systems: [] as string[], questions: [] as string[], toasts: [] as string[] }
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('model.complete', ($, e) => (seen.systems.push(e.system ?? ''), { value: reply }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const { question } = e.questions[0]
    seen.questions.push(question)

    return { result: { questions: e.questions, answers: { [question]: pick } } }
  })
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), DONE))

  return seen
}
const ANSWER = { isAnswered: true, text: ' Fix the login failure on mobile. ', usage: {} }
const typed = ($: Engine, text: string, kind = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } as never })

test('a prompt passes untouched with no config and with both toggles off', { plugins: [hub] }, async ($, on) => {
  world(on, ANSWER)
  expect((await typed($, 'fix login')).text).toBe('fix login')
  await configure($, {})
  expect((await typed($, 'fix login')).text).toBe('fix login')
})

test('append adds the switched-on snippets to typed prompts only', { plugins: [hub] }, async ($, on) => {
  world(on, ANSWER)
  await configure($, { on: { append: true } })

  expect((await typed($, 'fix login')).text).toBe('fix login\n\nRun the tests.\n\nKeep it short.')
  expect((await typed($, '/compact')).text).toBe('/compact')
  expect((await typed($, 'agent done', 'task-notification')).text).toBe('agent done')
})

test('rewrite replaces the prompt directly, before the snippets', { plugins: [hub] }, async ($, on) => {
  const seen = world(on, ANSWER)
  await configure($, { on: { rewrite: true, append: true }, style: 'expand' })

  expect((await typed($, 'fix the login thing')).text).toBe('Fix the login failure on mobile.\n\nRun the tests.\n\nKeep it short.')
  expect(seen.systems[0]).toMatch('Goal, Constraints, Done when')
  expect(seen.questions).toHaveLength(0)
  expect((await typed($, 'x'.repeat(4001))).text).toStartWith('xxx')
  expect(seen.systems).toHaveLength(1)
})

test('rewrite keeps the prompt when the model gives no answer', { plugins: [hub] }, async ($, on) => {
  const seen = world(on, { isAnswered: false, reason: 'aborted', usage: {} })
  await configure($, { on: { rewrite: true } })

  expect((await typed($, 'fix the login thing')).text).toBe('fix the login thing')
  expect(seen.toasts).toEqual(['Rewrite skipped: aborted'])
})

for (const [pick, sent] of [
  ['Rewritten', 'Fix the login failure on mobile.'],
  ['Mine', 'fix the login thing'],
  ['Fix login, mobile only', 'Fix login, mobile only'],
]) {
  test(`the rewrite dialog sends the pick: ${pick}`, { plugins: [hub] }, async ($, on) => {
    const seen = world(on, ANSWER, pick)
    await configure($, { on: { rewrite: true }, apply: 'dialog' })

    expect((await typed($, 'fix the login thing')).text).toBe(sent)
    expect(seen.questions[0]).toMatch('Fix the login failure on mobile.')
  })
}
