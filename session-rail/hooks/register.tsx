import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput, Register } from 'claude-code'

import type {
  RailConnector,
  RailContext,
  RailEnvironment,
  RailMcpServer,
  RailServer,
} from '../types'

const PANE = 'session-rail'
const TITLE = 'Session'
const COLUMNS = 44

/** Categorical theme keys for context categories, in draw order. */
const SERIES = [
  'claude',
  'suggestion',
  'success',
  'planMode',
  'warning',
  'autoAccept',
  'ide',
  'merged',
  'permission',
] as const

/** Maps a breakdown category to its theme key; `index` counts used categories. */
function categoryColor(kind: string, index: number): string {
  if (kind === 'free' || kind === 'deferred') return 'subtle'
  if (kind === 'buffer') return 'warning'
  return SERIES[index % SERIES.length] ?? 'subtle'
}

/** Display name of a breakdown category. */
function categoryLabel(name: string, kind: string): string {
  if (/^deferred/i.test(name)) return name
  if (kind !== 'deferred' && !/\(deferred\)/i.test(name)) return name
  const base = name.replace(/\s*\(deferred\)\s*/i, '')
  const lead = /^[A-Z][a-z]/.test(base) ? base[0]!.toLowerCase() + base.slice(1) : base
  return `Deferred ${lead}`
}

/** Replaces a leading home directory in `path` with `~`. */
function abbreviateHome(path: string, home: string | undefined): string {
  if (!home) return path
  const h = home.replace(/[\\/]+$/, '')
  if (!h || path.slice(0, h.length).toLowerCase() !== h.toLowerCase()) return path
  const next = path.charAt(h.length)
  return next === '' || next === '\\' || next === '/' ? `~${path.slice(h.length)}` : path
}

const expanded = atom({ plugin: 'session-rail', key: 'expanded' } as const, {
  env: true,
  context: true,
  outputs: true,
  connectors: true,
  servers: true,
} as Record<string, boolean>)
const environment = atom(
  { plugin: 'session-rail', key: 'environment' } as const,
  null as RailEnvironment | null,
)
const context = atom(
  { plugin: 'session-rail', key: 'context' } as const,
  null as RailContext | null,
  { shape: 'context-3' },
)
const outputs = atom(
  { plugin: 'session-rail', key: 'outputs' } as const,
  [] as string[],
)
const connectors = atom(
  { plugin: 'session-rail', key: 'connectors' } as const,
  [] as RailConnector[],
)
const servers = atom(
  { plugin: 'session-rail', key: 'servers' } as const,
  [] as RailServer[],
)
const busy = atom(
  { plugin: 'session-rail', key: 'busy' } as const,
  null as string | null,
)

const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

/** Formats a token count as 950, 3.1k, 400k or 1.2M. */
function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

/** Shortens text to `room` cells, keeping its tail behind an ellipsis. */
function shortenStart(text: string, room: number): string {
  if (room <= 1) return text.slice(-Math.max(0, room))
  return text.length <= room ? text : `…${text.slice(text.length - room + 1)}`
}

/** Shortens text to `room` cells, keeping its head before an ellipsis. */
function shortenEnd(text: string, room: number): string {
  if (room <= 1) return text.slice(0, Math.max(0, room))
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`
}

function splitPath(path: string): { dir: string; base: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0
    ? { dir: '', base: path }
    : { dir: path.slice(0, at), base: path.slice(at + 1) }
}

function serverLabel(server: string): string {
  return server.replace(/^claude_ai_/, '').replace(/_/g, ' ')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function refreshEnvironment($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const [host, branch, model, home] = await Promise.all([
    $.process
      .run(['hostname'], { timeoutMs: 5000 })
      .then(r => (r.exitCode === 0 ? r.stdout.trim() : 'unknown'))
      .catch(() => 'unknown'),
    $.process
      .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 })
      .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
      .catch(() => null),
    $.session.model().catch(() => 'unknown'),
    $.env
      .get('USERPROFILE')
      .catch(() => undefined)
      .then(v => v ?? $.env.get('HOME').catch(() => undefined)),
  ])
  const trimmed = cwd.replace(/[\\/]+$/, '') || cwd
  const env: RailEnvironment = {
    host,
    path: cwd,
    display: abbreviateHome(trimmed, home),
    branch,
    model,
  }
  await update($, environment, () => env)
}

async function refreshContext($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary', columns: 40 })
  const b = usage.context.breakdown
  if (!b) return
  const byServer = new Map<string, RailMcpServer>()
  for (const tool of b.mcpTools) {
    const row = byServer.get(tool.serverName) ?? {
      server: tool.serverName,
      count: 0,
      tokens: 0,
    }
    row.count += 1
    row.tokens += tool.tokens
    byServer.set(tool.serverName, row)
  }
  const snapshot: RailContext = {
    percentage: b.percentage,
    totalTokens: b.totalTokens,
    maxTokens: b.rawMaxTokens,
    autoCompactThreshold: b.isAutoCompactEnabled
      ? (b.autoCompactThreshold ?? null)
      : null,
    categories: b.categories.map((c, i, all) => ({
      name: c.name,
      tokens: c.tokens,
      color: categoryColor(
        c.kind,
        all.slice(0, i).filter(p => p.kind === 'used').length,
      ),
      kind: c.kind,
    })),
    mcp: [...byServer.values()].sort((a, z) => z.tokens - a.tokens),
    memory: b.memoryFiles.map(m => ({ path: m.path, type: m.type, tokens: m.tokens })),
    agents: b.agents.map(a => ({
      agentType: a.agentType,
      source: a.source,
      tokens: a.tokens,
    })),
  }
  await update($, context, () => snapshot)
}

async function refreshConnectors($: EngineInterface): Promise<void> {
  const tools = await $.tool.list().catch(err => {
    $.ui.log(`session-rail: tool.list failed: ${errorText(err)}`, { to: 'debug' })
    return []
  })
  const counts = new Map<string, number>()
  for (const tool of tools) {
    if (!tool.mcp) continue
    const server = tool.name.startsWith('mcp__')
      ? (tool.name.slice(5).split('__')[0] ?? tool.name)
      : tool.name
    counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  const ctx = await read($, context)
  for (const s of ctx?.mcp ?? []) {
    counts.set(s.server, Math.max(counts.get(s.server) ?? 0, s.count))
  }
  const list = [...counts.entries()]
    .map(([server, n]) => ({ server, tools: n }))
    .sort((a, z) => a.server.localeCompare(z.server))
  await update($, connectors, () => list)
}

async function probeUrl($: EngineInterface, url: string): Promise<boolean> {
  try {
    const r = await $.http.fetch(url)
    $.ui.log(`session-rail: ${url} answered ${r.status}`, { to: 'debug' })
    return true
  } catch (err) {
    $.ui.log(`session-rail: ${url} failed: ${errorText(err)}`, { to: 'debug' })
    return false
  }
}

async function probe($: EngineInterface, port: number): Promise<boolean> {
  const urls = [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]
  const anyUp = new Promise<boolean>(resolve => {
    let pending = urls.length
    for (const url of urls) {
      void probeUrl($, url).then(isUp => {
        pending -= 1
        if (isUp) resolve(true)
        else if (pending === 0) resolve(false)
      })
    }
  })
  const timeout = $.clock
    .sleep(5000)
    .then(() => {
      $.ui.log(`session-rail: port ${port} probe timed out`, { to: 'debug' })
      return false
    })
    .catch(() => false)
  return Promise.race([anyUp, timeout])
}

async function refreshServers($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const file = `${cwd.replace(/[\\/]+$/, '')}/.claude/launch.json`
  let configs: { name?: unknown; port?: unknown }[] = []
  try {
    if (await $.fs.exists(file)) {
      const parsed = JSON.parse(String(await $.fs.read(file))) as {
        configurations?: unknown
      }
      if (Array.isArray(parsed.configurations)) configs = parsed.configurations
    }
  } catch {
    configs = []
  }
  const list: RailServer[] = await Promise.all(
    configs.map(async (c, i) => {
      const port = typeof c.port === 'number' ? c.port : Number(c.port) || null
      const name = typeof c.name === 'string' ? c.name : `server ${i + 1}`
      const status: RailServer['status'] =
        port === null ? 'unknown' : (await probe($, port)) ? 'up' : 'down'
      return { name, port, status }
    }),
  )
  await update($, servers, () => list)
}

async function refreshAll($: EngineInterface): Promise<void> {
  await Promise.allSettled([
    refreshEnvironment($),
    refreshContext($).then(() => refreshConnectors($)),
    refreshServers($),
  ])
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
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(18, e.props.bodyColumns - 2)
  const open = await read($, expanded)
  const env = await read($, environment)
  const ctx = await read($, context)
  const files = await read($, outputs)
  const mcps = await read($, connectors)
  const devs = await read($, servers)
  const working = await read($, busy)

  const toggle = (id: string) =>
    update($, expanded, map => ({ ...map, [id]: !map[id] }))

  const refresh = async () => {
    await update($, busy, () => 'Refreshing…')
    try {
      await refreshAll($)
    } finally {
      await update($, busy, () => null)
    }
  }
  const compact = async () => {
    await update($, busy, () => 'Compacting…')
    try {
      const r = await $.session.compact()
      if ('skip' in r && typeof r.skip === 'string') {
        $.ui.toast(`Compact skipped: ${r.skip}`)
      } else {
        $.ui.toast('Session compacted')
      }
      await refreshContext($)
    } catch (err) {
      $.ui.toast(`Compact failed: ${errorText(err)}`)
    } finally {
      await update($, busy, () => null)
    }
  }

  const header = (id: string, title: string, count?: number) => (
    <Button key={`h-${id}`} plain onPress={() => toggle(id)}>
      <Text dimColor>{open[id] ? '▼' : '▶'} </Text>
      <Text bold>{title}</Text>
      {count ? <Text dimColor> {count}</Text> : ''}
    </Button>
  )

  const empty = (text: string) => <Text dimColor>○ {text}</Text>

  /** A dim label on the left and its value on the right. */
  const field = (label: string, value: string, truncateStart = false) => {
    const room = Math.max(1, width - label.length - 1)
    return (
      <Box justifyContent="space-between" gap={1}>
        <Box flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text wrap={truncateStart ? 'truncate-start' : 'truncate-end'}>
          {truncateStart ? shortenStart(value, room) : shortenEnd(value, room)}
        </Text>
      </Box>
    )
  }

  /** A coloured dot and name on the left, dim columns on the right. */
  const dotRow = (
    dot: { color: string; dim?: boolean },
    name: string,
    right: string[],
    opts: { dim?: boolean; widths?: number[] } = {},
  ) => {
    const widths = opts.widths ?? right.map(r => r.length)
    const used = widths.reduce((n, w) => n + w + 1, 0)
    const room = Math.max(1, width - 2 - used)
    return (
      <Box justifyContent="space-between" gap={1}>
        <Text dimColor={opts.dim} wrap="truncate-end">
          <Text color={dot.color} dimColor={dot.dim}>
            ●
          </Text>{' '}
          {shortenEnd(name, room)}
        </Text>
        <Box gap={1} flexShrink={0}>
          {right.map((r, i) => (
            <Text dimColor>{r.padStart(widths[i] ?? r.length)}</Text>
          ))}
        </Box>
      </Box>
    )
  }

  /** A name on the left and a dim value on the right, for nested lists. */
  const leaf = (name: string, value: string) => {
    const room = Math.max(1, width - 2 - value.length - 1)
    return (
      <Box justifyContent="space-between" gap={1}>
        <Text wrap="truncate-end">{shortenEnd(name, room)}</Text>
        <Text dimColor>{value}</Text>
      </Box>
    )
  }

  const blocks = []

  const envBlock = [header('env', 'Environment')]
  if (open.env) {
    if (!env) {
      envBlock.push(<Text dimColor>Reading…</Text>)
    } else {
      envBlock.push(field('Machine', env.host))
      envBlock.push(field('Project', env.display ?? env.path, true))
      envBlock.push(field('Branch', env.branch ?? '—'))
      envBlock.push(field('Model', env.model))
    }
  }
  blocks.push(<Box flexDirection="column">{envBlock}</Box>)

  const ctxBlock = [
    <Box justifyContent="space-between">
      {header('context', 'Context')}
      <Button key="refresh" plain dimColor label="↻" onPress={() => void refresh()} />
    </Box>,
  ]
  if (open.context) {
    if (!ctx) {
      ctxBlock.push(<Text dimColor>Measuring…</Text>)
    } else {
      const max = Math.max(1, ctx.maxTokens)
      ctxBlock.push(
        <Box justifyContent="space-between" gap={1}>
          <Text>{ctx.percentage}% used</Text>
          <Text dimColor>
            {fmtK(ctx.totalTokens)} / {fmtK(max)}
          </Text>
        </Box>,
      )

      const used = ctx.categories.filter(c => c.kind === 'used' && c.tokens > 0)
      const buffer = ctx.categories.filter(c => c.kind === 'buffer' && c.tokens > 0)
      const cellsOf = (tokens: number) => Math.max(1, Math.round((tokens / max) * width))
      const segments = [...used, ...buffer].map(c => ({ c, n: cellsOf(c.tokens) }))
      let over = segments.reduce((n, s) => n + s.n, 0) - width
      while (over > 0) {
        const widest = segments.reduce<(typeof segments)[number] | null>(
          (best, s) => (s.n > 1 && (!best || s.n > best.n) ? s : best),
          null,
        )
        if (!widest) break
        widest.n -= 1
        over -= 1
      }
      const freeCells = Math.max(0, width - segments.reduce((n, s) => n + s.n, 0))
      const usedSegs = segments.filter(s => s.c.kind === 'used')
      const bufferSegs = segments.filter(s => s.c.kind === 'buffer')
      ctxBlock.push(
        <Text wrap="truncate-end">
          {usedSegs.map(s => (
            <Text color={s.c.color}>{'█'.repeat(s.n)}</Text>
          ))}
          <Text color="subtle">{'░'.repeat(freeCells)}</Text>
          {bufferSegs.map(s => (
            <Text color="warning" dimColor>
              {'▒'.repeat(s.n)}
            </Text>
          ))}
        </Text>,
      )

      const widths = [6, 6]
      for (const c of ctx.categories) {
        const isDeferred = c.kind === 'deferred'
        const tokens = fmtK(c.tokens)
        const pct = isDeferred ? '' : `${((c.tokens / max) * 100).toFixed(1)}%`
        ctxBlock.push(
          dotRow(
            { color: c.color, dim: c.kind === 'buffer' || isDeferred },
            categoryLabel(c.name, c.kind),
            [tokens, pct],
            { dim: isDeferred, widths },
          ),
        )
      }
      if (ctx.autoCompactThreshold !== null) {
        const left = Math.max(0, ctx.autoCompactThreshold - ctx.totalTokens)
        ctxBlock.push(
          <Text dimColor wrap="truncate-end">
            Auto-compact at {fmtK(ctx.autoCompactThreshold)} · {fmtK(left)} left
          </Text>,
        )
      }

      const sub = (id: string, title: string, count: number) => (
        <Button key={`s-${id}`} plain onPress={() => toggle(id)}>
          <Text dimColor>{open[id] ? '▼' : '▶'} </Text>
          {title}
          <Text dimColor> {count}</Text>
        </Button>
      )
      const nested = (rows: ReturnType<typeof leaf>[]) => (
        <Box flexDirection="column" paddingLeft={2}>
          {rows.length ? rows : <Text dimColor>none</Text>}
        </Box>
      )
      const mcpTools = ctx.mcp.reduce((n, s) => n + s.count, 0)
      ctxBlock.push(sub('mcp', 'MCP tools', mcpTools))
      if (open.mcp) {
        ctxBlock.push(
          nested(ctx.mcp.map(s => leaf(`${serverLabel(s.server)} ×${s.count}`, fmtK(s.tokens)))),
        )
      }
      ctxBlock.push(sub('memory', 'Memory files', ctx.memory.length))
      if (open.memory) {
        ctxBlock.push(
          nested(ctx.memory.map(m => leaf(`${splitPath(m.path).base} (${m.type})`, fmtK(m.tokens)))),
        )
      }
      ctxBlock.push(sub('agents', 'Custom agents', ctx.agents.length))
      if (open.agents) {
        ctxBlock.push(nested(ctx.agents.map(a => leaf(a.agentType, fmtK(a.tokens)))))
      }
    }
    ctxBlock.push(
      <Box>
        <Button
          key="compact"
          variant="primary"
          label="Compact session"
          onPress={() => void compact()}
        />
      </Box>,
    )
  }
  if (working) ctxBlock.push(<Text dimColor>{working}</Text>)
  blocks.push(<Box flexDirection="column">{ctxBlock}</Box>)

  const outBlock = [header('outputs', 'Outputs', files.length)]
  if (open.outputs) {
    if (files.length === 0) outBlock.push(empty('No files written yet'))
    for (const file of [...files].reverse()) {
      const { dir, base } = splitPath(file)
      const name = shortenEnd(base, width)
      const room = width - name.length - 1
      outBlock.push(
        <Text wrap="truncate-end">
          {name}
          {room > 3 && dir ? <Text dimColor> {shortenStart(dir, room)}</Text> : ''}
        </Text>,
      )
    }
  }
  blocks.push(<Box flexDirection="column">{outBlock}</Box>)

  const conBlock = [header('connectors', 'Connectors', mcps.length)]
  if (open.connectors) {
    if (mcps.length === 0) conBlock.push(empty('No MCP servers connected'))
    const shown = open.more ? mcps : mcps.slice(0, 3)
    for (const m of shown) {
      conBlock.push(
        dotRow(
          { color: m.tools > 0 ? 'success' : 'subtle' },
          serverLabel(m.server),
          [`${m.tools} tool${m.tools === 1 ? '' : 's'}`],
        ),
      )
    }
    if (mcps.length > 3) {
      conBlock.push(
        <Box>
          <Button
            key="more"
            plain
            dimColor
            label={open.more ? 'Show less' : `Show ${mcps.length - 3} more`}
            onPress={() => toggle('more')}
          />
        </Box>,
      )
    }
  }
  blocks.push(<Box flexDirection="column">{conBlock}</Box>)

  const devBlock = [header('servers', 'Servers', devs.length)]
  if (open.servers) {
    if (devs.length === 0) devBlock.push(empty('No servers in .claude/launch.json'))
    for (const s of devs) {
      const state =
        s.status === 'up' ? 'running' : s.status === 'down' ? 'stopped' : 'unknown'
      const color =
        s.status === 'up' ? 'success' : s.status === 'down' ? 'subtle' : 'inactive'
      devBlock.push(
        dotRow({ color }, s.name, s.port === null ? [state] : [`:${s.port}`, state], {
          widths: s.port === null ? [state.length] : [`:${s.port}`.length, 7],
        }),
      )
    }
  }
  blocks.push(<Box flexDirection="column">{devBlock}</Box>)

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {blocks}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rail',
      description: 'Toggle the session rail pane',
    })
    void $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })
    $.clock.after(1, () => void refreshAll($))
    $.clock.every(15000, () => {
      void refreshServers($)
      void refreshConnectors($)
    })

    return next(e)
  })

  on('command.run', { command: 'rail' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Session rail closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })
    void refreshAll($)
    return { text: 'Session rail opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await Promise.allSettled([
      refreshContext($).then(() => refreshConnectors($)),
      refreshEnvironment($),
    ])
    return result
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const tool = String(e.tool)
    if (!WRITERS.has(tool)) return result
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const path =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : null
    const ok = path !== null && 'result' in result && !result.isError
    if (ok) {
      await update($, outputs, list =>
        list.includes(path) ? list : [...list, path].slice(-200),
      )
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    framed($, e, await drawPane($, inset(e))),
  )
}
