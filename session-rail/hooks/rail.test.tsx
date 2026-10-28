import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-rail',
  component: 'Pane',
  requestId: 'session-rail',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the rail lists its sections and a written file', async ($, on) => {
  on('command.register', () => ({ value: { command: 'rail' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Write',
    file_path: '/work/src/app.ts',
    content: 'x',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'h-env' })).toBeDefined()
    expect(await ui.find({ key: 'h-servers' })).toBeDefined()
    const row = await ui.find({ type: 'Text', text: /app\.ts/ })
    expect(row).toBeDefined()
    await ui.unmount()
  }
})

test('refresh marks a live server and lists connectors', async ($, on) => {
  on('session.cwd', () => ({ value: 'C:\\Users\\Mahad\\Projects\\Spendable' }))
  on('session.model', () => ({ value: 'opus' }))
  on('env.get', () => ({ value: 'C:\\Users\\Mahad' }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [] } }))
  on('tool.list', () => ({
    value: [{ name: 'mcp__github__get_me', description: '', mcp: true }],
  }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({
    value: JSON.stringify({ configurations: [{ name: 'emu', port: 8790 }] }),
  }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '' } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /emu/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^:8790$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(running|stopped)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /github/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Project$/ })).toBeDefined()
  expect(
    (await ui.find({ type: 'Text', text: /Spendable$/ }))?.text,
  ).toBe('~\\Projects\\Spendable')
  await ui.unmount()
})

test('the context section draws a stacked bar and its legend', async ($, on) => {
  on('session.cwd', () => ({ value: '/' }))
  on('session.model', () => ({ value: 'opus' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 400000,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 2200, kind: 'used', color: '', isDeferred: false },
            { name: 'System tools', tokens: 36600, kind: 'used', color: '', isDeferred: false },
            { name: 'System tools (deferred)', tokens: 46600, kind: 'deferred', color: '', isDeferred: true },
            { name: 'Custom agents', tokens: 46, kind: 'used', color: '', isDeferred: false },
            { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer', color: '', isDeferred: false },
            { name: 'Free space', tokens: 322500, kind: 'free', color: '', isDeferred: false },
          ],
          totalTokens: 44500,
          maxTokens: 400000,
          rawMaxTokens: 400000,
          autocompactSource: 'model-default',
          percentage: 11,
          gridRows: [],
          model: 'opus',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          autoCompactThreshold: 367000,
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
    },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /^11% used$/ })).toBeDefined()
  const bar = await ui.find({ type: 'Text', text: /^█+░+▒+$/ })
  expect(bar?.text.length).toBe(PANE.props.bodyColumns - 4)
  expect(bar?.text.match(/█/g)?.length).toBeGreaterThanOrEqual(3)
  expect(await ui.find({ type: 'Text', text: /Deferred system/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(deferred\)/ })).toBeUndefined()
  expect(
    await ui.find({ type: 'Text', text: /^Auto-compact at 367k · 322\.5k left$/ }),
  ).toBeDefined()
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
})
