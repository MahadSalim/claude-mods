import type { ConfigRow, ConfigValue, EngineInterface, Register } from 'claude-code'

const PANE = 'ui-mod'

/** The settings rows of every other plugin. */
const rowsOf = async ($: EngineInterface) => (await $.config.list()).filter(row => !['engine', $.plugin.name].includes(row.provider.plugin))

/** Closes the pane when the surface shows it, opens it otherwise. */
const togglePane = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown) ? $.ui.close({ id: PANE }) : $.ui.open({ id: PANE, title: 'Mods', closeOnEscape: true })

/** Writes one setting, shows a refusal, and redraws. */
const set = async ($: EngineInterface, key: string, value: ConfigValue) => {
  const { deny } = Number.isNaN(value) ? { deny: `${key} takes a number.` } : await $.config.set({ key, value })

  if (deny) {
    $.ui.toast(deny)
  }

  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('config.set', async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.surface === 'mobile' || e.props.hasSurvey || !(await rowsOf($)).length) {
      return below
    }

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box flexGrow={1} flexDirection="column">
          {below}
        </Box>
        <Button key={PANE} label="Mods" onPress={() => togglePane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') {
      return next(e)
    }

    const { Box, Button, Input, Markdown, Select, Text } = $.ui.resolve(e)
    const rows = await rowsOf($)
    /** The element that shows one row's value and changes it. */
    const control = ({ key, kind, value, options = [], isLocked }: ConfigRow) =>
      isLocked || typeof value === 'object' ? (
        <Text dimColor>{String(value)}</Text>
      ) : kind === 'boolean' ? (
        <Button key={key} label={value ? '●' : '○'} variant={value ? 'primary' : 'secondary'} dimColor={!value} onPress={() => set($, key, !value)} />
      ) : kind === 'choice' ? (
        <Select key={key} value={String(value)} options={options.map(option => ({ value: option }))} onSelect={picked => set($, key, picked)} />
      ) : (
        <Input key={key} value={String(value)} submitLabel="save" onSubmit={text => set($, key, kind === 'number' ? Number(text) : text)} />
      )

    return (
      <Box flexDirection="column" rowGap={1}>
        {[...new Set(rows.map(row => row.provider.plugin))].map(mod => (
          <Box flexDirection="column" rowGap={e.surface === 'desktop' ? 1 : 0} borderStyle="round" borderDimColor paddingX={1}>
            <Markdown text={`### ${mod}`} />
            {rows
              .filter(row => row.provider.plugin === mod)
              .map(row => (
                <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
                  <Text>{row.label}</Text>
                  {control(row)}
                </Box>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
