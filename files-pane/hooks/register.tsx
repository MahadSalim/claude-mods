import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput, FsEntry, Register } from 'claude-code'

import type {
  FilesPaneGrepHit,
  FilesPaneNameHit,
  FilesPaneResults,
  FilesPaneTab,
  FilesPaneView,
} from '../types'

const PANE = 'files'
const TITLE = 'Files'
const COMMAND = 'explorer'

const MAX_VIEW_BYTES = 300 * 1024
const BINARY_PROBE = 8192
const WINDOW_LINES = 300
const WINDOW_CHARS = 80000
const HIT_CONTEXT = 3
const MAX_HITS = 100
const MAX_TREE_ROWS = 1500
const FALLBACK_CAP = 5000
const INDEX_TTL_MS = 30000
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.gradle'])

const expanded = atom({ plugin: 'files-pane', key: 'expanded' } as const, [] as string[])
const filter = atom({ plugin: 'files-pane', key: 'filter' } as const, '')
const results = atom(
  { plugin: 'files-pane', key: 'results' } as const,
  { kind: 'none' } as FilesPaneResults,
)
const tabs = atom({ plugin: 'files-pane', key: 'tabs' } as const, [] as FilesPaneTab[])
const active = atom({ plugin: 'files-pane', key: 'active' } as const, null as string | null)
const modified = atom({ plugin: 'files-pane', key: 'modified' } as const, [] as string[])
const view = atom({ plugin: 'files-pane', key: 'view' } as const, 'tree' as FilesPaneView)

/** Cached project file list, keyed by cwd. */
let fileIndex: { cwd: string; files: string[]; at: number } | null = null
/** Cached file text, keyed by absolute path. */
const textCache = new Map<string, { mtimeMs: number; size: number; text: string }>()
/** Sequence number of the latest filter request. */
let searchSeq = 0

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

const isAbsolute = (p: string) => /^[a-zA-Z]:\//.test(p) || p.startsWith('/')

/** Path relative to `cwd` with `/` separators, or null when outside it. */
function toRel(cwd: string, path: string): string | null {
  const p = norm(path).replace(/^\.\//, '')
  if (!isAbsolute(p)) return p
  const c = norm(cwd)
  if (p.toLowerCase() === c.toLowerCase()) return ''
  if (p.toLowerCase().startsWith(c.toLowerCase() + '/')) return p.slice(c.length + 1)
  return null
}

const toAbs = (cwd: string, rel: string) => (rel ? `${norm(cwd)}/${rel}` : norm(cwd))

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)

const dirName = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

/** Byte count as `512B`, `4.2k` or `1.3M`. */
const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)}k`
      : `${(bytes / (1024 * 1024)).toFixed(1)}M`

/** Text cut to `width` cells, ending in `…` when cut. */
const clip = (text: string, width: number) =>
  text.length <= width ? text : width <= 1 ? '…' : text.slice(0, width - 1) + '…'

const ancestors = (rel: string) => {
  const parts = rel.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

const byDirThenName = (a: FsEntry, b: FsEntry) => {
  const ad = a.kind === 'dir' ? 0 : 1
  const bd = b.kind === 'dir' ? 0 : 1
  if (ad !== bd) return ad - bd
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  return an < bn ? -1 : an > bn ? 1 : 0
}

async function listDir($: EngineInterface, cwd: string, rel: string): Promise<FsEntry[]> {
  try {
    const entries = await $.fs.list(toAbs(cwd, rel))
    return entries.filter(entry => entry.name !== '.git').sort(byDirThenName)
  } catch {
    return []
  }
}

async function gitFiles($: EngineInterface, cwd: string): Promise<string[] | null> {
  try {
    const run = await $.process.run(
      ['git', '-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z'],
      { cwd, timeoutMs: 15000 },
    )
    if (run.exitCode !== 0) return null
    return [...new Set(run.stdout.split('\0').filter(Boolean).map(norm))]
  } catch {
    return null
  }
}

async function walkFiles($: EngineInterface, cwd: string): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0 && files.length < FALLBACK_CAP) {
    const dir = queue.shift() as string
    let entries: FsEntry[] = []
    try {
      entries = await $.fs.list(toAbs(cwd, dir))
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.kind === 'dir') {
        if (!SKIP_DIRS.has(entry.name)) queue.push(rel)
      } else {
        files.push(rel)
        if (files.length >= FALLBACK_CAP) break
      }
    }
  }
  return files
}

async function projectFiles($: EngineInterface, cwd: string): Promise<string[]> {
  const now = Date.now()
  if (fileIndex && fileIndex.cwd === cwd && now - fileIndex.at < INDEX_TTL_MS) {
    return fileIndex.files
  }
  const files = (await gitFiles($, cwd)) ?? (await walkFiles($, cwd))
  fileIndex = { cwd, files, at: now }
  return files
}

const isSubsequence = (needle: string, hay: string) => {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

/** Lower is better; -1 is no match. */
function matchScore(path: string, query: string): number {
  const p = path.toLowerCase()
  const base = baseName(p)
  if (base === query) return 0
  if (base.startsWith(query)) return 1
  if (base.includes(query)) return 2
  if (p.includes(query)) return 3
  if (isSubsequence(query, base)) return 4
  if (isSubsequence(query, p)) return 5
  return -1
}

async function nameSearch($: EngineInterface, query: string): Promise<FilesPaneResults> {
  const cwd = await $.session.cwd()
  const files = await projectFiles($, cwd)
  const q = query.toLowerCase().replace(/\s+/g, '')
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const score = matchScore(path, q)
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
  const hits: FilesPaneNameHit[] = scored.slice(0, MAX_HITS).map(({ path }) => ({ path }))
  return { kind: 'name', query, hits, total: scored.length }
}

function parseGrep(stdout: string): FilesPaneGrepHit[] {
  const hits: FilesPaneGrepHit[] = []
  for (const row of stdout.split('\n')) {
    if (!row) continue
    const parts = row.split('\0')
    if (parts.length < 3) continue
    const line = Number(parts[1])
    if (!Number.isFinite(line)) continue
    hits.push({ path: norm(parts[0] ?? ''), line, text: parts.slice(2).join(' ').trim() })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}

async function contentSearch($: EngineInterface, query: string): Promise<FilesPaneResults> {
  const cwd = await $.session.cwd()
  const base = ['git', '-c', 'core.quotepath=off', 'grep', '-n', '-I', '-i', '-F', '-z', '--no-color']
  const tail = ['--untracked', '-e', query, '--', '.']
  try {
    let run = await $.process.run([...base, '--max-count=5', ...tail], { cwd, timeoutMs: 20000 })
    if (run.exitCode > 1) {
      run = await $.process.run([...base, ...tail], { cwd, timeoutMs: 20000 })
    }
    if (run.exitCode > 1) {
      return {
        kind: 'content',
        query,
        hits: [],
        isBusy: false,
        note: 'Content search needs a git repository.',
      }
    }
    const hits = parseGrep(run.stdout)
    return { kind: 'content', query, hits, isBusy: false, note: hits.length ? undefined : 'No matches.' }
  } catch {
    return { kind: 'content', query, hits: [], isBusy: false, note: 'Content search failed to run.' }
  }
}

async function runFilter($: EngineInterface, value: string) {
  const seq = ++searchSeq
  await update($, filter, () => value)
  const text = value.trim()
  if (!text) {
    await update($, results, () => ({ kind: 'none' }) as FilesPaneResults)
    return
  }
  if (text.startsWith('?')) {
    const query = text.slice(1).trim()
    if (query.length < 2) {
      await update($, results, () => ({
        kind: 'content',
        query,
        hits: [],
        isBusy: false,
        note: 'Type at least 2 characters to search in files.',
      }) as FilesPaneResults)
      return
    }
    await update($, results, previous => ({
      kind: 'content',
      query,
      hits: previous.kind === 'content' ? previous.hits : [],
      isBusy: true,
    }) as FilesPaneResults)
    const found = await contentSearch($, query)
    if (seq === searchSeq) await update($, results, () => found)
    return
  }
  const found = await nameSearch($, text)
  if (seq === searchSeq) await update($, results, () => found)
}

async function openFile($: EngineInterface, rel: string, line?: number) {
  const start = line ? Math.max(1, line - HIT_CONTEXT) : 1
  await update($, tabs, list => {
    const tab: FilesPaneTab = line ? { path: rel, start, hit: line } : { path: rel, start }
    const at = list.findIndex(one => one.path === rel)
    if (at < 0) return [...list, tab]
    if (!line) return list
    return list.map(one => (one.path === rel ? tab : one))
  })
  await update($, active, () => rel)
  await update($, view, () => 'viewer' as FilesPaneView)
}

async function closeFile($: EngineInterface, rel: string) {
  let next: string | null = null
  await update($, tabs, list => {
    const at = list.findIndex(one => one.path === rel)
    const rest = list.filter(one => one.path !== rel)
    next = rest.length ? (rest[Math.min(Math.max(at, 0), rest.length - 1)]?.path ?? null) : null
    return rest
  })
  await update($, active, current => (current === rel ? next : current))
}

async function revealDir($: EngineInterface, rel: string) {
  const dirs = rel ? [...ancestors(rel), rel] : []
  await update($, expanded, list => [...new Set([...list, ...dirs])])
  await update($, view, () => 'tree' as FilesPaneView)
}

async function readText(
  $: EngineInterface,
  abs: string,
): Promise<{ text?: string; note?: string }> {
  let stat
  try {
    stat = await $.fs.stat(abs)
  } catch {
    return { note: 'This file no longer exists.' }
  }
  if (stat.kind !== 'file') return { note: 'Not a regular file.' }
  if (stat.size > MAX_VIEW_BYTES) {
    return { note: `This file is ${Math.round(stat.size / 1024)} KB, too large to preview.` }
  }
  const cached = textCache.get(abs)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { text: cached.text }
  }
  let text: string
  try {
    text = await $.fs.read(abs)
  } catch {
    return { note: 'This file could not be read.' }
  }
  if (text.slice(0, BINARY_PROBE).includes('\0')) {
    return { note: 'Binary file, not shown.' }
  }
  textCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  return { text }
}

const MODIFYING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

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
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Code } = elements
  const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : null
  const cwd = await $.session.cwd()
  const columns = e.props.bodyColumns
  const isWide = columns >= 90
  const budget = Math.max(10, columns - 2)
  const treeWidth = isWide ? Math.max(24, Math.floor(budget * 0.35)) : budget

  const filterText = await read($, filter)
  const found = await read($, results)
  const openTabs = await read($, tabs)
  const activePath = await read($, active)
  const changed = new Set(await read($, modified))
  const open = new Set(await read($, expanded))
  const half = await read($, view)

  const dot = <Text color="warning"> ●</Text>

  const hasChangedBelow = (rel: string) => {
    for (const path of changed) if (path.startsWith(rel + '/')) return true
    return false
  }

  async function treeRows() {
    const rows: { rel: string; name: string; depth: number; isDir: boolean; size: number }[] = []
    let isCut = false
    async function walk(dir: string, depth: number) {
      for (const entry of await listDir($, cwd, dir)) {
        if (rows.length >= MAX_TREE_ROWS) {
          isCut = true
          return
        }
        const rel = dir ? `${dir}/${entry.name}` : entry.name
        const isDir = entry.kind === 'dir'
        rows.push({ rel, name: entry.name, depth, isDir, size: entry.size })
        if (isDir && open.has(rel)) await walk(rel, depth + 1)
      }
    }
    await walk('', 0)
    return { rows, isCut }
  }

  const filterField = Input ? (
    <Box flexDirection="row" gap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
      <Text dimColor>⌕</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Input
          key="filter"
          value={filterText}
          placeholder="Filter, or ? to search in files"
          submitLabel="search"
          onInput={(value: string) => void runFilter($, value)}
          onSubmit={(value: string) => void runFilter($, value)}
        />
      </Box>
      {filterText ? (
        <Button key="filter-clear" plain dimColor onPress={() => void runFilter($, '')}>
          ×
        </Button>
      ) : null}
    </Box>
  ) : null

  async function treePanel() {
    if (found.kind === 'name') {
      return (
        <Box flexDirection="column">
          {found.hits.length === 0 && <Text dimColor>No matching files.</Text>}
          {found.hits.map(hit => (
            <Box key={`nr:${hit.path}`} flexDirection="row" gap={1}>
              <Button key={`n:${hit.path}`} plain onPress={() => void openFile($, hit.path)}>
                {clip(baseName(hit.path), treeWidth - 2)}
                {changed.has(hit.path) ? dot : ''}
              </Button>
              <Box flexShrink={1}>
                <Text dimColor wrap="truncate-start">{dirName(hit.path)}</Text>
              </Box>
            </Box>
          ))}
          {found.total > found.hits.length && (
            <Text dimColor>
              {found.total - found.hits.length} more; refine the filter
            </Text>
          )}
        </Box>
      )
    }
    if (found.kind === 'content') {
      const groups: { path: string; hits: FilesPaneGrepHit[] }[] = []
      for (const hit of found.hits) {
        const last = groups[groups.length - 1]
        if (last && last.path === hit.path) last.hits.push(hit)
        else groups.push({ path: hit.path, hits: [hit] })
      }
      return (
        <Box flexDirection="column" gap={1}>
          {found.isBusy && <Text dimColor>Searching…</Text>}
          {found.note && <Text dimColor>{found.note}</Text>}
          {groups.map(group => {
            const digits = String(Math.max(...group.hits.map(hit => hit.line))).length
            return (
              <Box key={`gf:${group.path}`} flexDirection="column">
                <Text bold wrap="truncate-start">
                  {group.path}
                  {changed.has(group.path) ? dot : ''}
                </Text>
                <Box flexDirection="column" paddingLeft={2}>
                  {group.hits.map(hit => (
                    <Button
                      key={`g:${hit.path}:${hit.line}`}
                      plain
                      onPress={() => void openFile($, hit.path, hit.line)}
                    >
                      <Text dimColor>{String(hit.line).padStart(digits)}</Text>
                      {' ' + clip(hit.text, treeWidth - 3 - digits)}
                    </Button>
                  ))}
                </Box>
              </Box>
            )
          })}
          {found.hits.length >= MAX_HITS && <Text dimColor>First {MAX_HITS} matches shown.</Text>}
        </Box>
      )
    }
    const { rows, isCut } = await treeRows()
    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>This folder is empty.</Text>}
        {rows.map(row => {
          const isOpen = open.has(row.rel)
          const isDot = row.name.startsWith('.')
          const isActive = row.rel === activePath
          const mark = row.isDir
            ? !isOpen && hasChangedBelow(row.rel)
            : changed.has(row.rel)
          const size = row.isDir ? '' : formatSize(row.size)
          const room = treeWidth - 2 * row.depth - 2 - (mark ? 2 : 0) - (size ? size.length + 1 : 0)
          const name = clip(row.name, Math.max(4, room))
          return (
            <Box key={`tr:${row.rel}`} flexDirection="row" justifyContent="space-between">
              <Box flexDirection="row" flexShrink={1}>
                {Array.from({ length: row.depth }, () => (
                  <Box width={2} flexShrink={0}>
                    <Text dimColor>│</Text>
                  </Box>
                ))}
                <Button
                  key={`t:${row.rel}`}
                  plain
                  onPress={() =>
                    void (row.isDir
                      ? update($, expanded, list =>
                          list.includes(row.rel)
                            ? list.filter(one => one !== row.rel && !one.startsWith(row.rel + '/'))
                            : [...list, row.rel],
                        )
                      : openFile($, row.rel))
                  }
                >
                  {row.isDir ? <Text dimColor>{isOpen ? '▼ ' : '▶ '}</Text> : '  '}
                  {row.isDir ? (
                    <Text bold color="suggestion" dimColor={isDot}>{name}</Text>
                  ) : isActive ? (
                    <Text bold color="suggestion">{name}</Text>
                  ) : (
                    <Text dimColor={isDot}>{name}</Text>
                  )}
                  {mark ? dot : ''}
                </Button>
              </Box>
              {size ? (
                <Box flexShrink={0}>
                  <Text dimColor>{size}</Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
        {isCut && <Text dimColor>Tree cut at {MAX_TREE_ROWS} rows; collapse folders to see more.</Text>}
      </Box>
    )
  }

  async function viewerPanel() {
    const tab = openTabs.find(one => one.path === activePath)
    const strip = openTabs.length ? (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {openTabs.map((one, at) => (
          <Box flexDirection="row" gap={1}>
            {at > 0 ? <Text dimColor>│</Text> : null}
            <Button key={`tab:${one.path}`} plain onPress={() => void update($, active, () => one.path)}>
              {one.path === activePath ? (
                <Text bold color="suggestion">{baseName(one.path)}</Text>
              ) : (
                <Text dimColor>{baseName(one.path)}</Text>
              )}
              {changed.has(one.path) ? dot : ''}
            </Button>
            <Button key={`x:${one.path}`} plain dimColor onPress={() => void closeFile($, one.path)}>
              ×
            </Button>
          </Box>
        ))}
      </Box>
    ) : null

    if (!tab) {
      return (
        <Box flexDirection="column" gap={1}>
          {strip}
          <Box flexDirection="row" gap={1}>
            <Text dimColor>◇</Text>
            <Text dimColor>Open files appear here</Text>
          </Box>
        </Box>
      )
    }

    const actions = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button
          key="act-copy"
          plain
          dimColor
          onPress={press =>
            void $.ui.copy({ text: tab.path, surface: press.surface }).then(done => {
              if (done.isCopied) $.ui.toast(`Copied ${tab.path}`)
            })
          }
        >
          Copy path
        </Button>
        <Button
          key="act-mention"
          plain
          dimColor
          onPress={() => void $.prompt.fill({ text: `@${tab.path} `, mode: 'insert' })}
        >
          @ mention
        </Button>
        <Button key="act-close" plain dimColor role="dismiss" onPress={() => void closeFile($, tab.path)}>
          Close
        </Button>
      </Box>
    )

    const header = (count: string | null, extra: typeof strip = null) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Box flexShrink={1}>
            <Text bold wrap="truncate-start">
              {tab.path}
            </Text>
          </Box>
          {count ? (
            <Box flexShrink={0}>
              <Text dimColor>{count}</Text>
            </Box>
          ) : null}
        </Box>
        {tab.hit ? <Text dimColor>{`match at line ${tab.hit}`}</Text> : null}
        {extra}
        {actions}
      </Box>
    )

    const loaded = await readText($, toAbs(cwd, tab.path))
    if (loaded.text === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          {strip}
          {header(null)}
          <Text dimColor>{loaded.note}</Text>
        </Box>
      )
    }

    const lines = loaded.text.split(/\r?\n/)
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const total = lines.length
    const first = Math.min(Math.max(1, tab.start), Math.max(1, total))
    let last = first - 1
    let chars = 0
    while (last < total && last - first + 1 < WINDOW_LINES) {
      chars += (lines[last] ?? '').length + 1
      if (chars > WINDOW_CHARS && last >= first) break
      last++
    }
    const source = lines.slice(first - 1, last).join('\n')
    const step = (to: number) =>
      void update($, tabs, list =>
        list.map(one => (one.path === tab.path ? { ...one, start: Math.max(1, to) } : one)),
      )

    const windowRow =
      total > last - first + 1 ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text dimColor>{`Lines ${first}–${last}`}</Text>
          {first > 1 && (
            <Button key="win-up" plain dimColor onPress={() => step(first - WINDOW_LINES)}>
              ▴ Earlier
            </Button>
          )}
          {last < total && (
            <Button key="win-down" plain dimColor onPress={() => step(last + 1)}>
              Later ▼
            </Button>
          )}
        </Box>
      ) : null

    return (
      <Box flexDirection="column" gap={1}>
        {strip}
        {header(`${total} ${total === 1 ? 'line' : 'lines'}`, windowRow)}
        {source.length === 0 ? (
          <Text dimColor>(empty file)</Text>
        ) : (
          <Code source={source} path={tab.path} startLine={first} wrap="truncate-end" />
        )}
      </Box>
    )
  }

  const refresh = () => {
    fileIndex = null
    textCache.clear()
    void (filterText.trim()
      ? runFilter($, filterText)
      : update($, expanded, list => [...list]))
  }

  const refreshButton = <Button key="refresh" plain dimColor label="↻" onPress={refresh} />

  const rootName = (
    <Box flexShrink={1}>
      <Text bold wrap="truncate-end">
        {baseName(norm(cwd)) || norm(cwd)}
      </Text>
    </Box>
  )

  if (isWide) {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          {rootName}
          {refreshButton}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          <Box flexDirection="column" gap={1} width={treeWidth} flexShrink={0}>
            {filterField}
            {await treePanel()}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {await viewerPanel()}
          </Box>
        </Box>
      </Box>
    )
  }

  const isTree = half === 'tree'
  const segmented = (
    <Box flexDirection="row" gap={1}>
      <Button key="show-tree" plain dimColor={!isTree} onPress={() => void update($, view, () => 'tree' as FilesPaneView)}>
        {isTree ? <Text bold color="suggestion">Tree</Text> : 'Tree'}
      </Button>
      <Text dimColor>│</Text>
      <Button key="show-viewer" plain dimColor={isTree} onPress={() => void update($, view, () => 'viewer' as FilesPaneView)}>
        {isTree ? 'Viewer' : <Text bold color="suggestion">Viewer</Text>}
      </Button>
    </Box>
  )

  const toolbar = (
    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
      {isTree ? (
        rootName
      ) : (
        <Button key="back-tree" plain dimColor onPress={() => void update($, view, () => 'tree' as FilesPaneView)}>
          ‹ Tree
        </Button>
      )}
      <Box flexDirection="row" flexShrink={0} columnGap={2}>
        {segmented}
        {refreshButton}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {toolbar}
      {isTree ? filterField : null}
      {isTree ? await treePanel() : await viewerPanel()}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open the Files pane, or a file in its viewer',
      argumentHint: '[path]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const cwd = await $.session.cwd()
    const arg = String(e.args ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/^@/, '')
    await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: 80 })
    if (!arg) return { text: 'Files pane opened.' }

    const rel = toRel(cwd, arg)
    if (rel === null) return { text: `${arg} is outside the project.` }
    let kind: string
    try {
      kind = (await $.fs.stat(toAbs(cwd, rel))).kind
    } catch {
      return { text: `No such file: ${arg}` }
    }
    if (kind === 'dir') {
      await revealDir($, rel)
      return { text: `Files pane opened at ${rel || '.'}.` }
    }
    await update($, expanded, list => [...new Set([...list, ...ancestors(rel)])])
    await openFile($, rel)
    return { text: `Opened ${rel} in the Files pane.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (!MODIFYING_TOOLS.has(tool) || ran.deny || ran.isError) return ran
    const input = e as unknown as Record<string, unknown>
    const path = input.file_path ?? input.notebook_path
    if (typeof path !== 'string') return ran
    const cwd = await $.session.cwd()
    const rel = toRel(cwd, path)
    if (rel) {
      await update($, modified, list => (list.includes(rel) ? list : [...list, rel]))
      fileIndex = null
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    framed($, e, await drawPane($, inset(e))),
  )
}
