import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const DONE = { value: undefined }

/** Answers the calls prompt-tools makes beneath it, and returns what it asked and showed. */
const world = (on: On, reply: object, pick = 'Rewritten') => {
  const seen = { systems: [] as string[], questions: [] as string[], toasts: [] as string[] }
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('model.complete', ($, e) => (seen.systems.push(e.system ?? ''), { value: reply as never }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const { question } = e.questions[0]!
    seen.questions.push(question)

    return { result: { questions: e.questions, answers: { [question]: pick } } }
  })
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), DONE))

  return seen
}
const ANSWER = { isAnswered: true, text: ' Fix the login failure on mobile. ', usage: {} }
const typed = ($: Engine, text: string, kind = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } as never })

test('a prompt passes untouched with the default settings', async ($, on) => {
  const seen = world(on, ANSWER)
  expect((await typed($, 'fix login')).text).toBe('fix login')
  expect(seen.systems).toHaveLength(0)
})

test('append adds its text to typed prompts only', { options: { append: 'Run the tests.' } }, async ($, on) => {
  world(on, ANSWER)

  expect((await typed($, 'fix login')).text).toBe('fix login\n\nRun the tests.')
  expect((await typed($, '/compact')).text).toBe('/compact')
  expect((await typed($, 'agent done', 'task-notification')).text).toBe('agent done')
})

test('rewrite replaces the prompt directly, before the appended text', { options: { rewrite: true, apply: 'direct', style: 'expand', append: 'Run the tests.' } }, async ($, on) => {
  const seen = world(on, ANSWER)

  expect((await typed($, 'fix the login thing')).text).toBe('Fix the login failure on mobile.\n\nRun the tests.')
  expect(seen.systems[0]).toMatch('Goal, Constraints, Done when')
  expect(seen.questions).toHaveLength(0)
  expect((await typed($, 'x'.repeat(4001))).text).toStartWith('xxx')
  expect(seen.systems).toHaveLength(1)
})

test('rewrite keeps the prompt when the model gives no answer', { options: { rewrite: true } }, async ($, on) => {
  const seen = world(on, { isAnswered: false, reason: 'aborted', usage: {} })

  expect((await typed($, 'fix the login thing')).text).toBe('fix the login thing')
  expect(seen.toasts).toEqual(['Rewrite skipped: aborted'])
})

for (const [pick, sent] of [
  ['Rewritten', 'Fix the login failure on mobile.'],
  ['Mine', 'fix the login thing'],
  ['Fix login, mobile only', 'Fix login, mobile only'],
]) {
  test(`the rewrite dialog sends the pick: ${pick}`, { options: { rewrite: true } }, async ($, on) => {
    const seen = world(on, ANSWER, pick)

    expect((await typed($, 'fix the login thing')).text).toBe(sent)
    expect(seen.questions[0]).toMatch('Fix the login failure on mobile.')
  })
}
