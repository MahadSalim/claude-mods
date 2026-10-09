import { expect, test } from 'claude-code/testing'
import type { ConfigRow, ConfigValue, On } from 'claude-code'

const NAME = 'ui-mod'
const SURFACES = ['terminal', 'desktop'] as const
const SITE = { scroll: { offset: 0, bodyRows: 20 }, view: {} }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, ...SITE } } as const
const PANE = { component: 'Pane', requestId: NAME, props: { title: 'Mods', isFocused: false, bodyColumns: 40, placement: 'dock', ...SITE } } as const
const DONE = { value: undefined }

const row = (plugin: string, field: string, kind: ConfigRow['kind'], value: ConfigValue, more: Partial<ConfigRow> = {}): ConfigRow => ({
  key: `${plugin}.${field}`,
  label: field,
  kind,
  value,
  provider: { plugin, tier: plugin === 'engine' ? 'core' : 'user' } as ConfigRow['provider'],
  isLocked: false,
  ...more,
})

/** Answers the calls ui-mod makes beneath it over these rows, and returns what it showed. */
const world = (on: On, rows: ConfigRow[]) => {
  const toasts: string[] = []
  const shown: string[] = []
  on('config.list', () => ({ value: rows }))
  on('config.set', ($, e) => {
    const held = rows.find(one => one.key === e.key)

    if (!held || (typeof e.value === 'number' && e.value > 9)) {
      return { deny: `${e.key} refused` }
    }

    held.value = e.value

    return { value: e.value }
  })
  on('ui.toast', ($, e) => (toasts.push(e.text), DONE))
  on('ui.open', ($, e) => (shown.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', ($, e) => (shown.splice(shown.indexOf(e.id), 1), DONE))
  on('ui.panes', () => ({ value: shown.map(id => ({ id, title: 'Mods', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))

  return { toasts, shown }
}

test('the band button opens and closes the pane, and hides with no settings', async ($, on) => {
  const rows = [row('engine', 'theme', 'text', 'dark')]
  const { shown } = world(on, rows)

  for (const surface of SURFACES) {
    const bare = await $.ui.mount({ plugin: NAME, surface, ...BAND })
    expect(await bare.find({ key: NAME })).toBeUndefined()
    await bare.unmount()

    rows.push(row('a', 'isOn', 'boolean', true))
    const band = await $.ui.mount({ plugin: NAME, surface, ...BAND })
    await band.press({ key: NAME })
    expect(shown).toEqual([NAME])
    await band.press({ key: NAME })
    expect(shown).toEqual([])
    await band.unmount()
    rows.pop()
  }
})

test('the pane draws one control per row of the other mods and writes each change', async ($, on) => {
  const rows: ConfigRow[] = []
  const { toasts } = world(on, rows)

  for (const surface of SURFACES) {
    rows.splice(
      0,
      rows.length,
      row('engine', 'theme', 'text', 'dark'),
      row('a', 'isOn', 'boolean', true),
      row('a', 'mode', 'choice', 'x', { options: ['x', 'y'] }),
      row('b', 'cap', 'number', 4),
      row('b', 'note', 'text', 'hi'),
      row('b', 'held', 'boolean', true, { isLocked: true }),
    )
    toasts.length = 0
    const pane = await $.ui.mount({ plugin: NAME, surface, ...PANE })
    const prop = async (key: string, name: string) => (await pane.find({ key }))?.props[name]
    const value = (key: string) => rows.find(one => one.key === key)?.value

    expect(await pane.find({ key: 'engine.theme' })).toBeUndefined()
    expect(await pane.find({ key: 'b.held' })).toBeUndefined()
    expect(await prop('a.isOn', 'label')).toBe('●')

    await pane.press({ key: 'a.isOn' })
    expect(value('a.isOn')).toBe(false)
    expect(await prop('a.isOn', 'label')).toBe('○')

    await pane.select({ key: 'a.mode', value: 'y' })
    expect(await prop('a.mode', 'value')).toBe('y')

    await pane.input({ key: 'b.cap', text: '7' })
    expect(value('b.cap')).toBe(7)
    await pane.input({ key: 'b.note', text: 'yo' })
    expect(await prop('b.note', 'value')).toBe('yo')

    await pane.input({ key: 'b.cap', text: 'many' })
    await pane.input({ key: 'b.cap', text: '99' })
    expect(value('b.cap')).toBe(7)
    expect(toasts).toEqual(['b.cap takes a number.', 'b.cap refused'])
    await pane.unmount()
  }
})
