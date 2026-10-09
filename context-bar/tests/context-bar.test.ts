import { expect, test } from 'claude-code/testing'

const NAME = 'context-bar'
const SURFACES = ['terminal', 'desktop'] as const
const SITE = { scroll: { offset: 0, bodyRows: 20 }, view: {} }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, ...SITE } } as const

test('the bar fills with the context window and redraws when it moves', async ($, on) => {
  let percent: number | undefined
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent }, rateLimits: [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box', props: { key: 'below' }, children: [] }))

  for (const surface of SURFACES) {
    percent = undefined
    const band = await $.ui.mount({ plugin: NAME, surface, ...BAND })
    const drawn = async () => JSON.stringify(await band.find({ key: 'context' }))
    expect(await drawn()).toMatch('Context ░░░░░░░░░░ 0%')
    expect(await band.find({ key: 'below' })).toBeDefined()

    percent = 42
    await $.session.measure({ context: { window: 200000, percent }, rateLimits: [], changed: ['context'] })
    expect(await drawn()).toMatch('Context ████░░░░░░ 42%')
    await band.unmount()
  }
})
