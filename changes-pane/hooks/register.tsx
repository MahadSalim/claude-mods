import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput, Register, RenderChildren } from 'claude-code'

import type {
  ChangesBase,
  ChangesDiff,
  ChangesFile,
  ChangesSnapshot,
  ChangesView,
} from '../types'

type $ = EngineInterface

const PANE = 'changes'
const TITLE = 'Changes'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_FILE_BYTES = 200 * 1024
const MAX_DIFF_CHARS = 90_000
const MAX_UNTRACKED_COUNTED = 200
const NARROW_COLUMNS = 70
const DEBOUNCE_MS = 600
const REFRESH_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
])

const BASES: { label: string; value: ChangesBase }[] = [
  { label: 'working tree', value: 'working' },
  { label: 'staged', value: 'staged' },
  { label: 'unstaged', value: 'unstaged' },
  { label: 'last commit', value: 'last' },
]

const EMPTY_SNAPSHOT: ChangesSnapshot = {
  status: 'idle',
  root: '',
  branch: '',
  files: [],
  added: 0,
  deleted: 0,
}

const baseAtom = atom({ plugin: 'changes-pane', key: 'base' } as const, 'working' as ChangesBase)
const viewAtom = atom({ plugin: 'changes-pane', key: 'view' } as const, 'list' as ChangesView)
const selectedAtom = atom({ plugin: 'changes-pane', key: 'selected' } as const, null as string | null)
const confirmAtom = atom({ plugin: 'changes-pane', key: 'confirm' } as const, null as string | null)
const showDiffAtom = atom({ plugin: 'changes-pane', key: 'showDiff' } as const, false)
const busyAtom = atom({ plugin: 'changes-pane', key: 'busy' } as const, false)
const snapshotAtom = atom({ plugin: 'changes-pane', key: 'snapshot' } as const, EMPTY_SNAPSHOT, {
  shape: 'snapshot-1',
})
const diffAtom = atom({ plugin: 'changes-pane', key: 'diff' } as const, null as ChangesDiff | null, {
  shape: 'diff-1',
})

/** Sequence number of the latest refresh. */
let generation = 0
/** Pending debounced refresh. */
let pending: { cancel: () => void } | null = null

type GitResult = { ok: boolean; stdout: string; stderr: string }

async function git($: $, cwd: string, args: string[]): Promise<GitResult> {
  try {
    const r = await $.process.run(
      ['git', '-c', 'core.quotePath=false', '--no-optional-locks', ...args],
      { cwd, timeoutMs: 20_000 },
    )
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr }
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err) }
  }
}

/** Splits NUL-separated git output into its fields. */
function fields(out: string): string[] {
  const list = out.split('\0')
  if (list.length > 0 && list[list.length - 1] === '') list.pop()
  return list
}

/** Parses `git status --porcelain=v1 -z` output. */
function parseStatus(out: string): ChangesFile[] {
  const toks = fields(out)
  const files: ChangesFile[] = []
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i] ?? ''
    if (tok.length < 4) continue
    const x = tok.charAt(0)
    const y = tok.charAt(1)
    const path = tok.slice(3)
    let oldPath: string | undefined
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = toks[i + 1]
      i++
    }
    files.push({ path, oldPath, status: '', x, y, added: null, deleted: null })
  }
  return files
}

/** Parses `git diff --name-status -z` output. */
function parseNameStatus(out: string): ChangesFile[] {
  const toks = fields(out)
  const files: ChangesFile[] = []
  for (let i = 0; i < toks.length; i++) {
    const letter = toks[i]?.charAt(0) || 'M'
    if (letter === 'R' || letter === 'C') {
      files.push({
        path: toks[i + 2] ?? '',
        oldPath: toks[i + 1],
        status: letter,
        x: letter,
        y: ' ',
        added: null,
        deleted: null,
      })
      i += 2
    } else {
      files.push({
        path: toks[i + 1] ?? '',
        status: letter,
        x: letter,
        y: ' ',
        added: null,
        deleted: null,
      })
      i += 1
    }
  }
  return files.filter(f => f.path !== '')
}

/** Parses `git diff --numstat -z` output into counts keyed by new path. */
function parseNumstat(out: string): Map<string, { added: number | null; deleted: number | null }> {
  const toks = fields(out)
  const map = new Map<string, { added: number | null; deleted: number | null }>()
  for (let i = 0; i < toks.length; i++) {
    const parts = (toks[i] ?? '').split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? null : Number(parts[0])
    const deleted = parts[1] === '-' ? null : Number(parts[1])
    let path = parts.slice(2).join('\t')
    if (path === '') {
      path = toks[i + 2] ?? ''
      i += 2
    }
    map.set(path, { added, deleted })
  }
  return map
}

function letterFor(f: ChangesFile, base: ChangesBase): string {
  if (f.x === '?') return '?'
  if (base === 'staged') return f.x
  if (base === 'unstaged') return f.y
  if (f.x === 'U' || f.y === 'U') return 'U'
  return f.x !== ' ' ? f.x : f.y
}

function isUntracked(f: ChangesFile): boolean {
  return f.x === '?'
}

function isStaged(f: ChangesFile): boolean {
  return f.x !== ' ' && f.x !== '?' && f.x !== '!'
}

function isUnstaged(f: ChangesFile): boolean {
  return f.y !== ' ' && f.y !== '!'
}

function lineCount(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

type FileText = { text: string } | { note: string }

async function readWorktreeFile($: $, root: string, path: string): Promise<FileText> {
  const full = `${root}/${path}`
  try {
    const stat = await $.fs.stat(full)
    if (stat.kind !== 'file') return { note: 'Not a regular file' }
    if (stat.size > MAX_FILE_BYTES) {
      return { note: `File too large to show (${Math.round(stat.size / 1024)} KB)` }
    }
    const text = await $.fs.read(full)
    if (typeof text !== 'string') return { note: 'Binary file' }
    if (text.includes('\0')) return { note: 'Binary file' }
    return { text: text.replace(/\r\n/g, '\n') }
  } catch (err) {
    return { note: `Could not read file: ${String(err)}` }
  }
}

/** Builds an all-added hunk from a file's text. */
function addedHunk(text: string): string {
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`
}

/** Keeps the hunks of a diff, cut at a hunk boundary when long. */
function hunksOf(diff: string): { source: string; note?: string } {
  const text = diff.replace(/\r\n/g, '\n')
  const start = text.startsWith('@@') ? 0 : text.indexOf('\n@@')
  if (start < 0) {
    if (/^Binary files .* differ$/m.test(text)) return { source: '', note: 'Binary file' }
    return { source: '', note: 'No textual changes' }
  }
  let source = text.slice(start === 0 ? 0 : start + 1)
  const fileBreak = source.indexOf('\ndiff --git ')
  if (fileBreak >= 0) source = source.slice(0, fileBreak)
  source = source.replace(/\n+$/, '')
  if (source.length <= MAX_DIFF_CHARS) return { source }
  const cut = source.lastIndexOf('\n@@', MAX_DIFF_CHARS)
  if (cut <= 0) return { source: '', note: 'Diff too large to show' }
  return { source: source.slice(0, cut), note: 'Diff cut short: later hunks not shown' }
}

async function hasRef($: $, root: string, ref: string): Promise<boolean> {
  return (await git($, root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).ok
}

/** The `git diff` arguments that select a base. */
async function diffArgs($: $, root: string, base: ChangesBase): Promise<string[]> {
  if (base === 'staged') return ['diff', '--cached']
  if (base === 'unstaged') return ['diff']
  if (base === 'working') return ['diff', (await hasRef($, root, 'HEAD')) ? 'HEAD' : EMPTY_TREE]
  const parent = (await hasRef($, root, 'HEAD~1')) ? 'HEAD~1' : EMPTY_TREE
  return ['diff', parent, 'HEAD']
}

async function computeSnapshot($: $, base: ChangesBase): Promise<ChangesSnapshot> {
  const cwd = await $.session.cwd()
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { ...EMPTY_SNAPSHOT, status: 'not-repo' }
  const root = top.stdout.trim().replace(/\\/g, '/')

  const sym = await git($, root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  let branch = sym.stdout.trim()
  if (!sym.ok || branch === '') {
    const sha = await git($, root, ['rev-parse', '--short', 'HEAD'])
    branch = sha.ok ? `(detached ${sha.stdout.trim()})` : '(no commits)'
  }

  let files: ChangesFile[]
  if (base === 'last') {
    if (!(await hasRef($, root, 'HEAD'))) {
      return { ...EMPTY_SNAPSHOT, status: 'ok', root, branch }
    }
    const args = await diffArgs($, root, base)
    const ns = await git($, root, [...args, '--name-status', '-z'])
    if (!ns.ok) return { ...EMPTY_SNAPSHOT, status: 'error', root, branch, error: ns.stderr.trim() }
    files = parseNameStatus(ns.stdout)
  } else {
    const st = await git($, root, ['status', '--porcelain=v1', '-uall', '-z'])
    if (!st.ok) return { ...EMPTY_SNAPSHOT, status: 'error', root, branch, error: st.stderr.trim() }
    files = parseStatus(st.stdout).filter(f => {
      if (base === 'staged') return isStaged(f)
      if (base === 'unstaged') return isUnstaged(f)
      return true
    })
    for (const f of files) f.status = letterFor(f, base)
  }

  const args = await diffArgs($, root, base)
  const num = await git($, root, [...args, '--numstat', '-z'])
  const counts = num.ok ? parseNumstat(num.stdout) : new Map()
  let counted = 0
  for (const f of files) {
    const c = counts.get(f.path)
    if (c) {
      f.added = c.added
      f.deleted = c.deleted
    } else if (isUntracked(f) && counted < MAX_UNTRACKED_COUNTED) {
      counted++
      const body = await readWorktreeFile($, root, f.path)
      if ('text' in body) {
        f.added = lineCount(body.text)
        f.deleted = 0
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  let added = 0
  let deleted = 0
  for (const f of files) {
    added += f.added ?? 0
    deleted += f.deleted ?? 0
  }
  return { status: 'ok', root, branch, files, added, deleted }
}

async function computeDiff(
  $: $,
  snap: ChangesSnapshot,
  base: ChangesBase,
  file: ChangesFile,
): Promise<ChangesDiff> {
  if (isUntracked(file) && base !== 'staged' && base !== 'last') {
    const body = await readWorktreeFile($, snap.root, file.path)
    if ('note' in body) return { path: file.path, base, source: '', note: body.note }
    if (body.text === '') return { path: file.path, base, source: '', note: 'Empty file' }
    const hunk = hunksOf(addedHunk(body.text))
    return { path: file.path, base, ...hunk }
  }
  const args = await diffArgs($, snap.root, base)
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const r = await git($, snap.root, [...args, '-M', '--', ...paths])
  if (!r.ok) return { path: file.path, base, source: '', note: r.stderr.trim() || 'git diff failed' }
  return { path: file.path, base, ...hunksOf(r.stdout) }
}

/** Recomputes the snapshot and the selected file's diff. */
async function refresh($: $): Promise<void> {
  const mine = ++generation
  const base = await read($, baseAtom)
  const snap = await computeSnapshot($, base)
  if (mine !== generation) return
  await update($, snapshotAtom, () => snap)

  const selected = await read($, selectedAtom)
  const file = snap.files.find(f => f.path === selected)
  if (!file) {
    if (selected !== null) {
      await update($, selectedAtom, () => null)
      await update($, showDiffAtom, () => false)
      await update($, confirmAtom, () => null)
    }
    await update($, diffAtom, () => null)
    return
  }
  const diff = await computeDiff($, snap, base, file)
  if (mine !== generation) return
  await update($, diffAtom, () => diff)
}

function scheduleRefresh($: $): void {
  pending?.cancel()
  pending = $.clock.after(DEBOUNCE_MS, () => {
    pending = null
    void isPaneOpen($).then(open => (open ? refresh($) : undefined))
  })
}

async function isPaneOpen($: $): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

async function select($: $, path: string): Promise<void> {
  await update($, selectedAtom, () => path)
  await update($, showDiffAtom, () => true)
  await update($, confirmAtom, () => null)
  const snap = await read($, snapshotAtom)
  const base = await read($, baseAtom)
  const file = snap.files.find(f => f.path === path)
  if (!file) return
  await update($, diffAtom, () => ({ path, base, source: '', note: 'Loading…' }))
  const diff = await computeDiff($, snap, base, file)
  if ((await read($, selectedAtom)) === path) await update($, diffAtom, () => diff)
}

async function runAction($: $, args: string[], label: string): Promise<void> {
  const snap = await read($, snapshotAtom)
  await update($, busyAtom, () => true)
  try {
    const r = await git($, snap.root, args)
    if (!r.ok) $.ui.toast(`${label} failed: ${r.stderr.trim().split('\n')[0] ?? ''}`)
  } finally {
    await update($, busyAtom, () => false)
    await refresh($)
  }
}

async function stage($: $, file: ChangesFile): Promise<void> {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  await runAction($, ['add', '-A', '--', ...paths], 'Stage')
}

async function unstage($: $, file: ChangesFile): Promise<void> {
  const snap = await read($, snapshotAtom)
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  if (await hasRef($, snap.root, 'HEAD')) {
    await runAction($, ['restore', '--staged', '--', ...paths], 'Unstage')
  } else {
    await runAction($, ['rm', '--cached', '-q', '--', ...paths], 'Unstage')
  }
}

async function discard($: $, file: ChangesFile, base: ChangesBase): Promise<void> {
  await update($, confirmAtom, () => null)
  if (isUntracked(file)) {
    await runAction($, ['clean', '-f', '-q', '--', file.path], 'Discard')
    return
  }
  if (base === 'unstaged') {
    await runAction($, ['restore', '--worktree', '--', file.path], 'Discard')
    return
  }
  if (file.x === 'A') {
    await runAction($, ['rm', '-f', '-q', '--', file.path], 'Discard')
    return
  }
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  if (file.oldPath && file.x === 'R') {
    await runAction($, ['rm', '-f', '-q', '--', file.path], 'Discard')
    await runAction($, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.oldPath], 'Discard')
    return
  }
  await runAction($, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths], 'Discard')
}

const STATUS_COLOR: Record<string, string> = {
  M: 'warning',
  T: 'warning',
  A: 'success',
  C: 'success',
  D: 'error',
  U: 'error',
  R: 'suggestion',
  '?': 'subtle',
}

/** Cells in the summary's added/removed proportion bar. */
const BAR_CELLS = 10

const CLEAN_TITLE: Record<ChangesBase, string> = {
  working: 'Working tree clean',
  staged: 'Nothing staged',
  unstaged: 'No unstaged changes',
  last: 'Last commit has no changes',
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function nameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** Added and removed cell counts of the proportion bar. */
function barCells(added: number, deleted: number): { add: number; del: number } {
  const total = added + deleted
  if (total === 0) return { add: 0, del: 0 }
  const filled = Math.min(BAR_CELLS, total)
  let add = Math.round((filled * added) / total)
  if (added > 0 && add === 0) add = 1
  if (deleted > 0 && add === filled) add = filled - 1
  return { add, del: filled - add }
}

/** A folder of the tree view. */
type TreeNode = { name: string; path: string; dirs: Map<string, TreeNode>; files: ChangesFile[] }

function buildTree(files: ChangesFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of files) {
    let node = root
    const dir = dirOf(f.path)
    if (dir !== '') {
      for (const part of dir.split('/')) {
        let child = node.dirs.get(part)
        if (!child) {
          child = {
            name: part,
            path: node.path === '' ? part : `${node.path}/${part}`,
            dirs: new Map(),
            files: [],
          }
          node.dirs.set(part, child)
        }
        node = child
      }
    }
    node.files.push(f)
  }
  return root
}

function sortedDirs(node: TreeNode): TreeNode[] {
  return [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The path of the file drawn last in the tree view. */
function lastTreeFile(node: TreeNode): string | null {
  const last = node.files[node.files.length - 1]
  if (last) return last.path
  const dirs = sortedDirs(node)
  const dir = dirs[dirs.length - 1]
  return dir ? lastTreeFile(dir) : null
}

/** The Pane input with the frame's two columns taken from its body. */
function inset(e: RenderInput<'Pane'>): RenderInput<'Pane'> {
  if (e.props.placement !== 'dock') return e
  return { ...e, props: { ...e.props, bodyColumns: e.props.bodyColumns - 2 } } as RenderInput<'Pane'>
}

/** Wraps a docked pane's body in a rounded frame that fills the dock. */
function framed($: EngineInterface, e: RenderInput<'Pane'>, body: RenderElement): RenderElement {
  if (e.props.placement !== 'dock') return body
  const { Box } = $.ui.resolve(e)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="promptBorder"
      minHeight={e.props.scroll.bodyRows}
    >
      {body}
    </Box>
  )
}

/** Draws the pane's body. */
const drawPane = async ($: EngineInterface, e: RenderInput<'Pane'>) => {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const snap = await read($, snapshotAtom)
  const base = await read($, baseAtom)
  const view = await read($, viewAtom)
  const selected = await read($, selectedAtom)
  const confirm = await read($, confirmAtom)
  const showDiff = await read($, showDiffAtom)
  const busy = await read($, busyAtom)
  const diff = await read($, diffAtom)
  const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 80
  const isNarrow = columns < NARROW_COLUMNS
  const budget = columns - 2

  const refreshIcon = (
    <Button key="refresh" plain dimColor label="↻" onPress={() => void refresh($)} />
  )

  if (snap.status === 'idle' || snap.status === 'not-repo') {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={1}>
            {snap.status === 'not-repo' && <Text dimColor>○</Text>}
            <Text dimColor wrap="truncate-end">
              {snap.status === 'idle' ? 'Loading…' : 'Not a git repository'}
            </Text>
          </Box>
          {refreshIcon}
        </Box>
      </Box>
    )
  }

  const file = snap.files.find(f => f.path === selected) ?? null

  const chooseBase = (value: string) => {
    void (async () => {
      await update($, baseAtom, () => value as ChangesBase)
      await update($, confirmAtom, () => null)
      await refresh($)
    })()
  }

  const basePicker = (() => {
    if (e.surface !== 'mobile') {
      const { Select } = $.ui.resolve(e)
      return (
        <Select
          key="base"
          options={BASES}
          value={base}
          onSelect={(value: string) => chooseBase(value)}
        />
      )
    }
    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {BASES.map((b, i) => (
          <Box key={`basegroup:${b.value}`} flexDirection="row" gap={1}>
            {i > 0 && <Text dimColor>│</Text>}
            {b.value === base ? (
              <Button key={`base:${b.value}`} plain label={b.label} onPress={() => chooseBase(b.value)}>
                <Text bold color="suggestion">{b.label}</Text>
              </Button>
            ) : (
              <Button key={`base:${b.value}`} plain dimColor onPress={() => chooseBase(b.value)}>
                {b.label}
              </Button>
            )}
          </Box>
        ))}
      </Box>
    )
  })()

  const toolbar = (
    <Box flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexDirection="row" gap={1} flexShrink={1}>
        <Text bold wrap="truncate-end">{snap.branch}</Text>
        <Text dimColor>→</Text>
        {basePicker}
      </Box>
      {refreshIcon}
    </Box>
  )

  const errorBlock = snap.status === 'error' && (
    <Text color="error" wrap="wrap">{snap.error ?? 'git failed'}</Text>
  )

  if (snap.files.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {toolbar}
        {errorBlock}
        {snap.status !== 'error' && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color="success">✓</Text>
              <Text color="success" wrap="truncate-end">{CLEAN_TITLE[base]}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {base === 'working' ? `Nothing to commit on ${snap.branch}` : `on ${snap.branch}`}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const countLabel = `${snap.files.length} ${snap.files.length === 1 ? 'file' : 'files'}`
  const addedLabel = `+${snap.added}`
  const removedLabel = `−${snap.deleted}`
  const cells = barCells(snap.added, snap.deleted)
  const summaryWidth =
    countLabel.length + 2 + addedLabel.length + 1 + removedLabel.length + 2 + BAR_CELLS +
    (busy ? 2 + 'working…'.length : 0)
  const toggleWidth = 'List │ Tree'.length
  const toggleOnOwnRow = summaryWidth + 2 + toggleWidth > budget

  const viewToggle = (
    <Box flexDirection="row" gap={1}>
      {(['list', 'tree'] as const).map((v, i) => (
        <Box key={`viewgroup:${v}`} flexDirection="row" gap={1}>
          {i > 0 && <Text dimColor>│</Text>}
          {v === view ? (
            <Button key={`view:${v}`} plain label={v === 'list' ? 'List' : 'Tree'} onPress={() => undefined}>
              <Text bold color="suggestion">{v === 'list' ? 'List' : 'Tree'}</Text>
            </Button>
          ) : (
            <Button key={`view:${v}`} plain dimColor onPress={() => void update($, viewAtom, () => v)}>
              {v === 'list' ? 'List' : 'Tree'}
            </Button>
          )}
        </Box>
      ))}
    </Box>
  )

  const summaryLine = (
    <Box flexDirection="row" columnGap={2}>
      <Text>{countLabel}</Text>
      <Box flexDirection="row" gap={1}>
        <Text color="diffAdded">{addedLabel}</Text>
        <Text color="diffRemoved">{removedLabel}</Text>
      </Box>
      <Text>
        <Text color="diffAdded">{'█'.repeat(cells.add)}</Text>
        <Text color="diffRemoved">{'█'.repeat(cells.del)}</Text>
        <Text dimColor>{'░'.repeat(BAR_CELLS - cells.add - cells.del)}</Text>
      </Text>
      {busy && <Text dimColor>working…</Text>}
    </Box>
  )

  const summary = toggleOnOwnRow ? (
    <Box flexDirection="column">
      {summaryLine}
      {viewToggle}
    </Box>
  ) : (
    <Box flexDirection="row" justifyContent="space-between" gap={2}>
      {summaryLine}
      {viewToggle}
    </Box>
  )

  const actions = file && base !== 'last' && (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {(isUnstaged(file) || isUntracked(file)) && base !== 'staged' && (
        <Button key="stage" plain dimColor onPress={() => void stage($, file)}>Stage</Button>
      )}
      {isStaged(file) && base !== 'unstaged' && (
        <Button key="unstage" plain dimColor onPress={() => void unstage($, file)}>Unstage</Button>
      )}
      <Button
        key="discard"
        plain
        dimColor={confirm !== file.path}
        onPress={() => {
          if (confirm === file.path) void discard($, file, base)
          else void update($, confirmAtom, () => file.path)
        }}
      >
        {confirm === file.path ? 'Confirm discard' : 'Discard'}
      </Button>
      {confirm === file.path && (
        <Button key="cancel" plain dimColor onPress={() => void update($, confirmAtom, () => null)}>
          Cancel
        </Button>
      )}
    </Box>
  )

  const diffBody = (f: ChangesFile, trailingGap: boolean) => (
    <Box flexDirection="column" paddingLeft={2} marginBottom={trailingGap ? 1 : 0}>
      {actions}
      {diff && diff.path === f.path && diff.source !== '' && (
        <Code source={diff.source} path={f.path} format="diff" />
      )}
      {diff && diff.path === f.path && diff.note && <Text dimColor wrap="wrap">{diff.note}</Text>}
      {(!diff || diff.path !== f.path) && <Text dimColor>Loading…</Text>}
    </Box>
  )

  const fileLine = (f: ChangesFile, showDir: boolean) => {
    const secondary = f.oldPath ? `← ${f.oldPath}` : showDir ? dirOf(f.path) : ''
    const isSelected = f.path === selected
    return (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
          <Text color={STATUS_COLOR[f.status] ?? 'subtle'}>{f.status}</Text>
          <Button key={`file:${f.path}`} plain label={nameOf(f.path)} onPress={() => void select($, f.path)}>
            <Text bold color={isSelected ? 'suggestion' : undefined} wrap="truncate-end">
              {nameOf(f.path)}
            </Text>
          </Button>
          {secondary !== '' && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-start">{secondary}</Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {f.added === null && f.deleted === null && <Text dimColor>bin</Text>}
          {(f.added !== null || f.deleted !== null) && (
            <Text color="diffAdded">{`+${f.added ?? 0}`}</Text>
          )}
          {(f.added !== null || f.deleted !== null) && (
            <Text color="diffRemoved">{`−${f.deleted ?? 0}`}</Text>
          )}
        </Box>
      </Box>
    )
  }

  const tree = view === 'tree' ? buildTree(snap.files) : null
  const lastPath = tree ? lastTreeFile(tree) : (snap.files[snap.files.length - 1]?.path ?? null)

  const row = (f: ChangesFile, showDir: boolean) => (
    <Box key={`row:${f.path}`} flexDirection="column">
      {fileLine(f, showDir)}
      {!isNarrow && file?.path === f.path && diffBody(f, f.path !== lastPath)}
    </Box>
  )

  const folder = (node: TreeNode): RenderChildren => (
    <Box key={`dir:${node.path}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text dimColor>▼</Text>
        <Text bold color="suggestion" wrap="truncate-end">{node.name}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {sortedDirs(node).map(folder)}
        {node.files.map(f => row(f, false))}
      </Box>
    </Box>
  )

  const list = tree ? (
    <Box flexDirection="column">
      {sortedDirs(tree).map(folder)}
      {tree.files.map(f => row(f, false))}
    </Box>
  ) : (
    <Box flexDirection="column">{snap.files.map(f => row(f, true))}</Box>
  )

  if (isNarrow && file && showDiff) {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Button key="back" plain dimColor onPress={() => void update($, showDiffAtom, () => false)}>
            ◂ Files
          </Button>
          {refreshIcon}
        </Box>
        <Box flexDirection="column">
          {fileLine(file, true)}
          {diffBody(file, false)}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {toolbar}
      {errorBlock}
      {summary}
      {list}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'changes',
      description: 'Open the Changes pane: changed files and their diffs',
    })
    const result = await next(e)
    void refresh($)
    return result
  })

  on('command.run', { command: 'changes' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: 80 })
    void refresh($)
    return {
      text: opened.isPlaced ? 'Changes pane opened.' : `Changes pane not placed: ${opened.reason}`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    scheduleRefresh($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (REFRESH_TOOLS.has(String(e.tool))) scheduleRefresh($)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    framed($, e, await drawPane($, inset(e))),
  )
}
