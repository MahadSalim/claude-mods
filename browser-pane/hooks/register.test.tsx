import { expect, mock, test } from 'claude-code/testing'

import { htmlToMarkdown, pixelsToCells, snapshotRows } from './register'

const PANE = {
  plugin: 'browser-pane',
  component: 'Pane',
  requestId: 'browser',
  props: {
    title: 'Browser',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  surface: 'terminal',
} as const

const RUN = {
  command: 'browser',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const HTML = `<!doctype html><html><head><title>Demo &amp; Co</title><style>p{}</style></head>
<body><script>alert(1)</script><h2>Intro</h2><p>Hello <a href="/docs?a=1&amp;b=2">the docs</a>
and <img alt="a logo" src="x.png">.</p><ul><li>One</li><li>Two</li></ul><pre>  x = 1
  y = 2</pre></body></html>`

test('html becomes readable markdown with absolute links', async () => {
  const { title, text, links } = htmlToMarkdown(HTML, 'https://example.com/a/')
  expect(title).toBe('Demo & Co')
  expect(text).toContain('# Demo & Co')
  expect(text).toContain('## Intro')
  expect(text).toContain('[the docs](https://example.com/docs?a=1&b=2)')
  expect(text).toContain('_a logo_')
  expect(text).toContain('- One')
  expect(text).toContain('  x = 1')
  expect(text.includes('alert')).toBe(false)
  expect(links[0]?.href).toBe('https://example.com/docs?a=1&b=2')
})

test('the new tab page lists the servers of launch.json', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'browser' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({
    value: JSON.stringify({
      version: '0.0.1',
      configurations: [{ name: 'spendable-emulator', runtimeExecutable: 'node', runtimeArgs: ['x.js'], port: 8790 }],
    }),
  }))
  on('http.fetch', () => {
    throw new Error('refused')
  })

  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...RUN, args: '' })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: 'spendable-emulator' }))?.key).toBe('srv-open-spendable-emulator')
  expect((await ui.find({ type: 'Text', text: ':8790' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^stopped$/ }))?.text).toBe('stopped')
  expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('subtle')
  expect((await ui.find({ key: 'srv-toggle-spendable-emulator' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'srv-logs-spendable-emulator' }))?.props.plain).toBe(true)
  expect((await ui.find({ key: 'cfg-toggle' }))?.text).toBe('launch.json')
  await ui.unmount()
})

test('pixels become half-block raster cells', async () => {
  const rgb = Uint8Array.of(255, 0, 0, 0, 0, 255)
  const words = new Uint32Array(Uint8Array.from(atob(pixelsToCells(rgb, 1, 1)), c => c.charCodeAt(0)).buffer)
  expect([...words]).toEqual([0x2580, 0xff0000, 0x0000ff])
  expect(snapshotRows(68)).toBe(21)
})

test('the command opens a page in the pane', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'browser' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('fs.exists', () => ({ value: false }))
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: { 'content-type': 'text/html' }, text: HTML },
  }))

  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...RUN, args: 'https://example.com/' })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  const page = await ui.find({ type: 'Markdown' })
  expect(page?.text).toContain('## Intro')
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^No snapshot: Microsoft Edge is not installed/ }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})

test('a loaded page shows a rendered snapshot above its text', async ($, on) => {
  const clock = mock.clock(on)
  const columns = PANE.props.bodyColumns - 4
  const rows = snapshotRows(columns)
  const pixels = new Uint8Array(columns * rows * 2 * 3).fill(200)
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'browser' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('fs.exists', (_, e) => ({ value: /msedge\.exe$/.test(e.path) }))
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: { 'content-type': 'text/html' }, text: HTML },
  }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return {
      value: {
        exitCode: 0,
        stdout: btoa(String.fromCharCode(...pixels)),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...RUN, args: 'https://example.com/' })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'snap-retake' })
  await clock.settle()
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props.columns).toBe(columns)
  expect(raster?.props.rows).toBe(rows)
  expect(ran[0]?.[0]).toBe('powershell.exe')
  expect((await ui.find({ key: 'mode-snapshot' }))?.text).toBe('Snapshot')
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('## Intro')

  await ui.press({ key: 'mode-text' })
  await clock.settle()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})
