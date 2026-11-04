import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { Context, Section } from '@/types'

/** Colors for the rows that fill the window, in the order that /context lists them. */
const PALETTE = ['#5b8def', '#e8853d', '#2bb39b', '#a77bf3', '#e5c14a', '#e86ba0', '#6cc56c', '#4cc3d9', '#d9714c', '#8f9bb3']
const BUFFER = '#5c5c5c'

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

type Row = { name: string; tokens: number; color?: string; isMuted?: boolean }

/** One row: a color square, the name, the tokens and the share of the window. A row without `color` has no square. */
function TokenRow({ row, max, isDeferred }: { row: Row; max: number; isDeferred?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-[14px]">
      <span className="size-3 flex-none rounded-[3px]" style={{ background: row.color ?? 'transparent', border: row.color ? undefined : '1px solid var(--border)' }} />
      <span className={cn('min-w-0 flex-1 truncate', row.isMuted && 'text-muted-foreground')} title={row.name}>
        {row.name}
      </span>
      <span className="w-20 text-right tabular-nums text-muted-foreground">{tokens(row.tokens)}</span>
      <span className="w-16 text-right tabular-nums text-muted-foreground">{isDeferred ? '—' : percent(row.tokens, max)}</span>
    </div>
  )
}

/** A list that opens when you click its title, such as the MCP tools. */
function Details({ title, count, total, children }: { title: string; count: number; total: number; children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  if (!count) return null
  return (
    <div className="border-t">
      <button onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} className="flex w-full items-center gap-2 py-2.5 text-left text-[14px] hover:text-foreground">
        <ChevronRight className={cn('size-4 flex-none text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
        <span className="flex-1">{title}</span>
        <span className="tabular-nums text-muted-foreground">
          {count} · {tokens(total)}
        </span>
      </button>
      {isOpen && <div className="pb-3 pl-6">{children}</div>}
    </div>
  )
}

const sum = (rows: { tokens: number }[]) => rows.reduce((n, row) => n + row.tokens, 0)
const byTokens = <T extends { tokens: number }>(rows: T[]) => [...rows].sort((a, b) => b.tokens - a.tokens)

/** The MCP tools, grouped by server, the biggest server first. Tools that load on demand are dimmed. */
function McpTools({ context }: { context: Context }) {
  const servers = new Map<string, Context['mcpTools']>()
  for (const tool of context.mcpTools) servers.set(tool.serverName, [...(servers.get(tool.serverName) ?? []), tool])
  const sorted = [...servers].sort((a, b) => sum(b[1]) - sum(a[1]))
  return sorted.map(([server, tools]) => (
    <Details key={server} title={server} count={tools.length} total={sum(tools)}>
      {byTokens(tools).map(tool => (
        <TokenRow key={tool.name} row={{ name: tool.name.split('__').slice(2).join('__') || tool.name, tokens: tool.tokens, isMuted: !tool.isLoaded }} max={context.maxTokens} isDeferred={!tool.isLoaded} />
      ))}
    </Details>
  ))
}

/** The context use of one session, drawn like /context: the total, a bar, one row per category and the lists under it. */
function ContextCard({ context }: { context: Context }) {
  const { maxTokens: max } = context
  const used = context.categories.filter(c => c.kind === 'used')
  const colors = new Map(used.map((c, i) => [c.name, PALETTE[i % PALETTE.length]]))
  const buffer = context.categories.filter(c => c.kind === 'buffer')
  const usedTotal = context.totalTokens
  const rows = context.categories.filter(c => c.kind !== 'deferred')
  const deferred = context.categories.filter(c => c.kind === 'deferred')
  const color = (c: Context['categories'][number]) => (c.kind === 'used' ? colors.get(c.name) : c.kind === 'buffer' ? BUFFER : undefined)
  const loadedMcp = context.mcpTools.filter(tool => tool.isLoaded)

  return (
    <div className="mt-6 rounded-xl border bg-card px-5 py-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[22px] font-semibold tabular-nums">{percent(usedTotal, max).replace(/\.0%$/, '%')} used</div>
        <div className="tabular-nums text-muted-foreground">
          {tokens(usedTotal)} / {tokens(max)}
        </div>
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${tokens(usedTotal)} of ${tokens(max)} tokens used`}>
        {used.map(c => (
          <div key={c.name} title={`${c.name}: ${tokens(c.tokens)}`} style={{ width: `${(c.tokens / max) * 100}%`, background: colors.get(c.name) }} />
        ))}
        <div className="flex-1" />
        {buffer.map(c => (
          <div key={c.name} title={`${c.name}: ${tokens(c.tokens)}`} style={{ width: `${(c.tokens / max) * 100}%`, background: BUFFER }} />
        ))}
      </div>

      <div className="mt-4">
        {rows.map(c => (
          <TokenRow key={c.name} row={{ name: c.name, tokens: c.tokens, color: color(c), isMuted: c.kind === 'free' }} max={max} />
        ))}
      </div>
      {deferred.length > 0 && (
        <div className="mt-2 border-t pt-2">
          {deferred.map(c => (
            <TokenRow key={c.name} row={{ name: c.name, tokens: c.tokens, isMuted: true }} max={max} isDeferred />
          ))}
          <div className="pb-1 text-[12px] text-muted-foreground">Deferred tools load only when Claude searches for them, so they are not in the window.</div>
        </div>
      )}

      <div className="mt-3">
        <Details title="MCP tools" count={context.mcpTools.length} total={sum(loadedMcp)}>
          <McpTools context={context} />
        </Details>
        <Details title="Skills" count={context.skills.length} total={sum(context.skills)}>
          {byTokens(context.skills).map(skill => (
            <TokenRow key={skill.name} row={skill} max={max} />
          ))}
        </Details>
        <Details title="Custom agents" count={context.agents.length} total={sum(context.agents)}>
          {byTokens(context.agents).map(agent => (
            <TokenRow key={agent.name} row={agent} max={max} />
          ))}
        </Details>
        <Details title="Memory files" count={context.memoryFiles.length} total={sum(context.memoryFiles)}>
          {byTokens(context.memoryFiles).map(file => (
            <TokenRow key={file.path} row={{ name: file.path, tokens: file.tokens }} max={max} />
          ))}
        </Details>
      </div>
    </div>
  )
}

/** The Home tab: the context use of a recent session, newest first, with a menu to pick another session. */
export function HomeView({ section, contexts }: { section: Section; contexts: Context[] }) {
  const [picked, setPicked] = useState<string>()
  const context = contexts.find(c => c.id === picked) ?? contexts[0]
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="mb-1 text-[17px] font-semibold">{section.title}</h1>
          <div className="text-[13px] text-muted-foreground">{section.note}</div>
        </div>
        {contexts.length > 1 && context && (
          <Select value={context.id} onValueChange={setPicked}>
            <SelectTrigger className="w-64" aria-label="Session">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {contexts.map(c => (
                <SelectItem key={c.id} value={c.id}>
                  {folder(c.cwd)} · {ago(c.savedAt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {context ? (
        <>
          <ContextCard context={context} />
          <div className="mt-3 text-[12px] text-muted-foreground">
            {folder(context.cwd)} · {context.model} · counted {ago(context.savedAt)}
          </div>
        </>
      ) : (
        <div className="py-4 text-muted-foreground">No session has been counted yet. Start a Claude Code session with the mod loaded, then reopen this window.</div>
      )}
    </>
  )
}
