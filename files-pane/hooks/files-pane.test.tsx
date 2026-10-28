import { expect, test } from 'claude-code/testing'

const CWD = 'C:/proj'

const fix = (p: string) => p.replace(/\\/g, '/')

const TREE: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  [CWD]: [
    { name: 'src', kind: 'dir' },
    { name: '.git', kind: 'dir' },
    { name: '.github', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
    { name: 'b.txt', kind: 'file' },
  ],
  [`${CWD}/src`]: [{ name: 'main.ts', kind: 'file' }],
  [`${CWD}/.github`]: [],
}

const FILES: Record<string, string> = {
  [`${CWD}/src/main.ts`]: 'const a = 1\nconst b = 2\n',
  [`${CWD}/README.md`]: '# hi\n',
}

const pane = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
  ({
    plugin: 'files-pane',
    component: 'Pane',
    requestId: 'files',
    surface,
    props: {
      title: 'Files',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

function engine(on: any, stdout = 'src/main.ts\0README.md\0b.txt\0') {
  on('session.cwd', () => ({ value: CWD }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (TREE[fix(e.path)] ?? []).map(one => ({ ...one, size: 10, mtimeMs: 1, isLink: false })),
  }))
  on('fs.stat', (_: unknown, e: { path: string }) => ({
    value: { kind: FILES[fix(e.path)] !== undefined ? 'file' : 'dir', size: 10, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: FILES[fix(e.path)] ?? '' }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`tree, expand and open on ${surface}`, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount(pane(surface, 120))

    expect(await ui.find({ key: 't:.git' })).toBeUndefined()
    expect(await ui.find({ key: 't:.github' })).toBeDefined()
    expect((await ui.find({ key: 't:src' }))?.text).toContain('▶ src')
    expect(await ui.find({ type: 'Text', text: /Open files appear here/ })).toBeDefined()

    await ui.press({ key: 't:src' })
    expect((await ui.find({ key: 't:src' }))?.text).toContain('▼ src')
    await ui.press({ key: 't:src/main.ts' })
    expect((await ui.find({ type: 'Code' }))?.text).toContain('const b = 2')
    expect(await ui.find({ key: 'tab:src/main.ts' })).toBeDefined()

    await ui.press({ key: 'act-close' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  })

  test(`session edits are marked on ${surface}`, async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: {} }))
    await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\b.txt', content: 'x' } as any)
    const ui = await $.ui.mount(pane(surface, 120))
    expect((await ui.find({ key: 't:b.txt' }))?.text).toContain('●')
    expect((await ui.find({ key: 't:README.md' }))?.text).not.toContain('●')
    await ui.unmount()
  })

  test(`content search on ${surface}`, async ($, on) => {
    engine(on, 'src/main.ts\x002\x00const b = 2\n')
    const ui = await $.ui.mount(pane(surface, 120))
    await ui.input({ key: 'filter', text: '?const b', kind: 'change' })
    expect((await ui.find({ key: 'g:src/main.ts:2' }))?.text).toContain('2 const b = 2')
    expect(await ui.find({ type: 'Text', text: 'src/main.ts' })).toBeDefined()
    await ui.press({ key: 'g:src/main.ts:2' })
    expect((await ui.find({ type: 'Text', text: /match at line 2/ }))).toBeDefined()
    await ui.unmount()
  })

  test(`narrow toolbar, sizes and back action on ${surface}`, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount(pane(surface, 37))
    expect(await ui.find({ type: 'Text', text: 'proj' })).toBeDefined()
    expect(await ui.find({ key: 'show-tree' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '10B' })).toBeDefined()
    expect((await ui.find({ key: 't:README.md' }))?.text).toContain('  README.md')
    await ui.press({ key: 't:README.md' })
    expect(await ui.find({ type: 'Text', text: '1 line' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.press({ key: 'back-tree' })
    expect(await ui.find({ key: 't:src' })).toBeDefined()
    await ui.unmount()
  })

  test(`filename filter on ${surface}`, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount(pane(surface, 60))
    await ui.input({ key: 'filter', text: 'main', kind: 'change' })
    expect(await ui.find({ key: 'n:src/main.ts' })).toBeDefined()
    expect(await ui.find({ key: 'n:README.md' })).toBeUndefined()
    await ui.press({ key: 'n:src/main.ts' })
    expect((await ui.find({ type: 'Code' }))?.text).toContain('const a = 1')
    await ui.unmount()
  })
}
