import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'changes-pane',
  component: 'Pane',
  requestId: 'changes',
  props: {
    title: 'Changes',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const DIFF = [
  'diff --git a/src/a b.ts b/src/a b.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a b.ts',
  '+++ b/src/a b.ts',
  '@@ -1,2 +1,3 @@',
  ' a',
  '-b',
  '+c',
  '+d',
  '',
].join('\n')

function fakeGit(argv: readonly string[]): { exitCode: number; stdout: string } {
  const args = argv.slice(4)
  const has = (s: string) => args.includes(s)
  if (has('--show-toplevel')) return { exitCode: 0, stdout: 'C:/repo\n' }
  if (args[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'main\n' }
  if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc1234\n' }
  if (args[0] === 'status') {
    return { exitCode: 0, stdout: ' M src/a b.ts\0?? new file.txt\0A  lib/x.js\0' }
  }
  if (has('--numstat')) return { exitCode: 0, stdout: '2\t1\tsrc/a b.ts\x005\t0\tlib/x.js\0' }
  if (args[0] === 'diff' && has('src/a b.ts')) return { exitCode: 0, stdout: DIFF }
  return { exitCode: 0, stdout: '' }
}

test('lists changes and shows a diff, on terminal and desktop', async ($, on) => {
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 12, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'hello\nworld\n' }))
  on('process.run', (_, e) => {
    const r = fakeGit(e.argv)
    return {
      value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^3 files/ }))?.text).toBe('3 files')
    expect(await ui.find({ type: 'Text', text: '+9' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '█████████' })).toBeDefined()
    expect(await ui.find({ key: 'view:list' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ key: 'file:src/a b.ts' })).toBeDefined()
    expect(await ui.find({ key: 'file:new file.txt' })).toBeDefined()

    await ui.press({ key: 'file:src/a b.ts' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    expect(String(code?.props.source).startsWith('@@ -1,2 +1,3 @@')).toBe(true)

    await ui.press({ key: 'file:new file.txt' })
    const added = await ui.find({ type: 'Code' })
    expect(added?.props.source).toBe('@@ -0,0 +1,2 @@\n+hello\n+world')
    expect(await ui.find({ key: 'stage' })).toBeDefined()

    await ui.press({ key: 'view:tree' })
    expect(await ui.find({ key: 'dir:src' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src' })).toBeDefined()
    await ui.press({ key: 'view:list' })
    expect(await ui.find({ key: 'dir:src' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a clean tree shows one empty state and no summary', async ($, on) => {
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(4)
    const stdout =
      args.includes('--show-toplevel') ? 'C:/repo\n'
      : args[0] === 'symbolic-ref' ? 'master\n'
      : args[0] === 'rev-parse' ? 'abc1234\n'
      : ''
    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 37 }, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: 'Working tree clean' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Nothing to commit on master' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /files?$/ })).toBeUndefined()
  expect(await ui.find({ key: 'view:list' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'No changes to show' })).toBeUndefined()
  await ui.unmount()
})

test('outside a repository the pane says so', async ($, on) => {
  on('session.cwd', () => ({ value: 'C:/nowhere' }))
  on('process.run', () => ({
    value: {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/nowhere', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: 'Not a git repository' })).toBeDefined()
  await ui.unmount()
})

test('narrow pane swaps list and diff; discard asks twice', async ($, on) => {
  const ran: string[] = []
  on('command.register', () => ({ value: { command: 'changes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', (_, e) => {
    ran.push(e.argv.slice(4).join(' '))
    return {
      value: { ...fakeGit(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, bodyColumns: 50 },
    surface: 'terminal',
  })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'file:src/a b.ts' })
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ key: 'file:lib/x.js' })).toBeUndefined()
  expect((await ui.find({ type: 'Code' }))?.props.format).toBe('diff')

  await ui.press({ key: 'discard' })
  expect((await ui.find({ key: 'discard' }))?.text).toBe('Confirm discard')
  expect(ran.some(c => c.startsWith('restore'))).toBe(false)
  await ui.press({ key: 'discard' })
  expect(ran.some(c => c === 'restore --source=HEAD --staged --worktree -- src/a b.ts')).toBe(true)

  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'file:lib/x.js' })).toBeDefined()
  await ui.unmount()
})