import type { Register } from 'claude-code'

// Cells the bar is drawn in.
const CELLS = 10

export const register: Register = on => {
  on('session.measure', ($, e, next) => {
    if (e.changed.includes('context')) {
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey) {
      return below
    }

    const { Box, Text } = $.ui.resolve(e)
    const { percent = 0 } = (await $.session.usage()).context
    const filled = Math.round((percent / 100) * CELLS)

    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box key="context">
          <Text dimColor>{`Context ${'█'.repeat(filled)}${'░'.repeat(CELLS - filled)} ${percent}%`}</Text>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          {below}
        </Box>
      </Box>
    )
  })
}
