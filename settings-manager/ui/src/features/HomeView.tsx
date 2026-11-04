import { ChevronRight, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { Context, Section } from '@/types'

/** Colors for the rows that fill the window, in the order that /context lists them. */
const PALETTE = ['#5b8def', '#e8853d', '#2bb39b', '#a77bf3', '#e5c14a', '#e86ba0', '#6cc56c', '#4cc3d9', '#d9714c', '#8f9bb3']
const BUFFER = '#5c5c5c'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 297, 22.6k or 1.2M, as /context writes token counts. */
export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const percent = (n: number, of: number) => `${of ? ((n / of) * 100).toFixed(1) : '0.0'}%`

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

const folder = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
const sum = (rows: { tokens: number }[]) => rows.reduce((n, row) => n + row.tokens, 0)
const byTokens = <T extends { tokens: number }>(rows: T[]) => [...rows].sort((a, b) => b.tokens - a.tokens)

/** A part of a row: its name and tokens, and its own parts. `isEstimate` marks a share of a total, not a count. */
type Part = { name: string; tokens: number; isEstimate?: boolean; isMuted?: boolean; parts?: Part[] }

/** Splits `total` among `items` by their length: Claude Code counts only the total of these. */
function split(total: number, items: { name: string; chars: number }[]): Part[] {
  const chars = items.reduce((n, item) => n + item.chars, 0)
  return byTokens(items.map(item => ({ name: item.name, tokens: chars ? (total * item.chars) / chars : 0, isEstimate: true })))
}

/** About how many characters of English text make one token. */
const CHARS_PER_TOKEN = 3.5

/**
 * Splits the system prompt's total among its sections. The desktop app adds its own text to the system prompt,
 * which the mod never sees. So when the sections are much shorter than the total, each section gets its estimate
 * by length, and the rest is one row of its own.
 */
function splitPrompt(total: number, sections: { name: string; chars: number }[]): Part[] {
  const guessed = sections.reduce((n, section) => n + section.chars, 0) / CHARS_PER_TOKEN
  if (guessed >= total * 0.85) return split(total, sections)
  const parts = byTokens(sections.map(section => ({ name: section.name, tokens: section.chars / CHARS_PER_TOKEN, isEstimate: true })))
  return [{ name: 'Added by the app (the mod cannot see or change it)', tokens: total - guessed, isEstimate: true, isMuted: true }, ...parts]
}

/** The MCP tools grouped by server, the biggest server first, each server with its tools. */
function byServer(tools: Context['mcpTools'], connectors: Record<string, string>): Part[] {
  const servers = new Map<string, Context['mcpTools']>()
  for (const tool of tools) servers.set(tool.serverName, [...(servers.get(tool.serverName) ?? []), tool])
  return byTokens(
    [...servers].map(([server, list]) => ({
      name: UUID.test(server) ? (connectors[server] ?? `Claude.ai connector ${server.slice(0, 8)}`) : server,
      tokens: sum(list),
      parts: byTokens(list).map(tool => ({ name: tool.name.split('__').slice(2).join('__') || tool.name, tokens: tool.tokens })),
    })),
  )
}

/**
 * The parts of one /context row, where the mod has them. A row is matched by its name, as /context prints it.
 * System prompt sections and built-in tools are shares of the row's total, by text length.
 */
function partsOf(category: Context['categories'][number], context: Context, connectors: Record<string, string>): Part[] | undefined {
  const name = category.name.toLowerCase()
  const builtIn = context.tools ?? []
  if (name === 'system prompt' && context.sections?.length) return splitPrompt(category.tokens, context.sections)
  if (name === 'system tools' && builtIn.length) return split(category.tokens, builtIn.filter(tool => !tool.isDeferred))
  if (name === 'system tools (deferred)' && builtIn.length) return split(category.tokens, builtIn.filter(tool => tool.isDeferred))
  if (name === 'mcp tools') return byServer(context.mcpTools.filter(tool => tool.isLoaded), connectors)
  if (name === 'mcp tools (deferred)') return byServer(context.mcpTools.filter(tool => !tool.isLoaded), connectors)
  if (name === 'custom agents') return byTokens(context.agents)
  if (name === 'skills') return byTokens(context.skills)
  if (name === 'memory files') return byTokens(context.memoryFiles.map(file => ({ name: file.path, tokens: file.tokens })))
  return undefined
}

/** One row with a color square, the name, the tokens and the share of the window. A row with parts opens to show them. */
function Row({ part, max, color, depth = 0, isDeferred }: { part: Part; max: number; color?: string; depth?: number; isDeferred?: boolean }) {
  const [isOpen, setOpen] = useState(false)
  const canOpen = !!part.parts?.length
  const mark = part.isEstimate ? '~' : ''
  return (
    <>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen(!isOpen)}
        aria-expanded={canOpen ? isOpen : undefined}
        className={cn('flex w-full items-center gap-2.5 rounded-md py-1.5 pr-1 text-left text-[14px]', canOpen && 'hover:bg-accent/50')}
        style={{ paddingLeft: depth * 22 + 4 }}
      >
        <ChevronRight className={cn('size-3.5 flex-none text-muted-foreground transition-transform', isOpen && 'rotate-90', !canOpen && 'invisible')} />
        {depth === 0 && <span className="size-3 flex-none rounded-[3px]" style={{ background: color ?? 'transparent', border: color ? undefined : '1px solid var(--border)' }} />}
        <span className={cn('min-w-0 flex-1 truncate', (part.isMuted || depth > 0) && 'text-muted-foreground', depth > 0 && 'text-[13.5px]')} title={part.name}>
          {part.name}
          {canOpen && <span className="ml-2 text-[12px] text-muted-foreground">{part.parts!.length}</span>}
        </span>
        <span className="w-20 flex-none text-right tabular-nums text-muted-foreground">
          {mark}
          {tokens(part.tokens)}
        </span>
        <span className="w-16 flex-none text-right tabular-nums text-muted-foreground">{isDeferred ? '—' : `${mark}${percent(part.tokens, max)}`}</span>
      </button>
      {isOpen && part.parts!.map(child => <Row key={child.name} part={child} max={max} depth={depth + 1} isDeferred={isDeferred} />)}
      {isOpen && part.parts!.some(child => child.isMuted) && (
        <div className="py-1 text-[12px] text-muted-foreground" style={{ paddingLeft: (depth + 1) * 22 + 28 }}>
          Turned-off sections are not sent, so they are not listed.
        </div>
      )}
    </>
  )
}

/** The context use of one session, drawn like /context: the total, a bar, and one row per category that opens to its parts. */
function ContextCard({ context, connectors }: { context: Context; connectors: Record<string, string> }) {
  const { maxTokens: max, totalTokens: used } = context
  const usedRows = context.categories.filter(c => c.kind === 'used')
  const colors = new Map(usedRows.map((c, i) => [c.name, PALETTE[i % PALETTE.length]]))
  const buffer = context.categories.filter(c => c.kind === 'buffer')
  const color = (c: Context['categories'][number]) => (c.kind === 'used' ? colors.get(c.name) : c.kind === 'buffer' ? BUFFER : undefined)
  const part = (c: Context['categories'][number]): Part => ({ name: c.name, tokens: c.tokens, isMuted: c.kind === 'free', parts: partsOf(c, context, connectors) })
  // The conversation itself is left out: the mod changes nothing in it. The total above still counts it.
  const rows = context.categories.filter(c => c.kind !== 'deferred' && c.name !== 'Messages')
  const deferred = context.categories.filter(c => c.kind === 'deferred')
  const hasEstimates = !!(context.sections?.length || context.tools?.length)

  return (
    <div className="mt-4 rounded-xl border bg-card px-5 py-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[22px] font-semibold tabular-nums">{percent(used, max).replace(/\.0%$/, '%')} used</div>
        <div className="tabular-nums text-muted-foreground">
          {tokens(used)} / {tokens(max)}
        </div>
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${tokens(used)} of ${tokens(max)} tokens used`}>
        {usedRows.map(c => (
          <div key={c.name} title={`${c.name}: ${tokens(c.tokens)}`} style={{ width: `${(c.tokens / max) * 100}%`, background: colors.get(c.name) }} />
        ))}
        <div className="flex-1" />
        {buffer.map(c => (
          <div key={c.name} title={`${c.name}: ${tokens(c.tokens)}`} style={{ width: `${(c.tokens / max) * 100}%`, background: BUFFER }} />
        ))}
      </div>

      <div className="mt-4">
        {rows.map(c => (
          <Row key={c.name} part={part(c)} max={max} color={color(c)} />
        ))}
      </div>
      {deferred.length > 0 && (
        <div className="mt-2 border-t pt-2">
          {deferred.map(c => (
            <Row key={c.name} part={{ ...part(c), isMuted: true }} max={max} isDeferred />
          ))}
          <div className="px-1 pt-1 text-[12px] text-muted-foreground">Deferred tools load only when Claude searches for them, so they are not in the window.</div>
        </div>
      )}
      {hasEstimates && (
        <div className="px-1 pt-2 text-[12px] text-muted-foreground">
          ~ marks an estimate. Claude Code counts only the total of the system prompt and of the built-in tools, so the mod splits each total by the length of each part.
        </div>
      )}
    </div>
  )
}

type HomeProps = { section: Section; context?: Context; connectors: Record<string, string>; changedAt?: string }

/**
 * The Home tab: the context use of the session that started last. When settings changed after that session started, a
 * note says that the numbers do not show the change, since only a new session loads it.
 */
export function HomeView({ section, context, connectors, changedAt }: HomeProps) {
  const isOld = !!context && !!changedAt && Date.parse(changedAt) > Date.parse(context.startedAt ?? context.savedAt)
  return (
    <>
      <h1 className="mb-1 text-[17px] font-semibold">{section.title}</h1>
      <div className="text-[13px] text-muted-foreground">{section.note}</div>
      {context ? (
        <>
          <div className="mt-4 text-[13px] text-muted-foreground">
            {folder(context.cwd)} · {context.model} · counted {ago(context.savedAt)}
          </div>
          {isOld && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-[13px] text-amber-200">
              <TriangleAlert className="mt-0.5 size-4 flex-none" />
              You changed settings {ago(changedAt!)}, after this session started. Start a new session to see the new numbers.
            </div>
          )}
          <ContextCard context={context} connectors={connectors} />
        </>
      ) : (
        <div className="py-4 text-muted-foreground">No session has been counted yet. Start a Claude Code session with the mod loaded, then reopen this window.</div>
      )}
    </>
  )
}
