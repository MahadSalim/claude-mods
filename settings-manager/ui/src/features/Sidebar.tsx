import { createLucideIcon, FileText, PlugZap, Puzzle, Search, SlidersHorizontal, Sparkles, SquareTerminal, Variable, WandSparkles, Wrench, type LucideIcon } from 'lucide-react'
import { Fragment } from 'react'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { Section } from '@/types'

/** Two bots, one behind the other: the subagents that Claude can start. Drawn on Lucide's 24px grid. */
const Bots = createLucideIcon('bots', [
  ['path', { d: 'M16 5V2.5', key: 'back-antenna' }],
  ['path', { d: 'M11 9V7a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2', key: 'back-head' }],
  ['path', { d: 'M8 10V7.5', key: 'antenna' }],
  ['rect', { x: '2', y: '10', width: '13', height: '10', rx: '2', key: 'head' }],
  ['path', { d: 'M6 14v2', key: 'left-eye' }],
  ['path', { d: 'M11 14v2', key: 'right-eye' }],
])

export const SECTION_ICONS: Record<string, LucideIcon> = {
  skills: WandSparkles,
  prompts: FileText,
  agents: Bots,
  commands: SquareTerminal,
  tools: Wrench,
  plugins: Puzzle,
  hooks: PlugZap,
  general: SlidersHorizontal,
  env: Variable,
}

/** Sections that have a divider after them. */
const LINE_AFTER = new Set(['tools', 'hooks'])

type Props = { sections: Section[]; current: string; query: string; onQuery: (query: string) => void; onPick: (id: string) => void }

/** The search field and the list of sections. */
export function Sidebar({ sections, current, query, onQuery, onPick }: Props) {
  return (
    <aside className="w-[250px] flex-none overflow-y-auto border-r bg-sidebar px-3 py-3.5">
      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus placeholder="Search" value={query} onChange={e => onQuery(e.target.value)} className="pl-8" />
      </label>
      <nav className="flex flex-col gap-0.5">
        {sections.map(section => {
          const Icon = SECTION_ICONS[section.id] ?? Sparkles
          return (
            <Fragment key={section.id}>
              <button
                onClick={() => onPick(section.id)}
                className={cn('flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[15px] hover:bg-accent/60', !query.trim() && section.id === current && 'bg-accent')}
              >
                <Icon className="size-5 flex-none" strokeWidth={1.7} />
                {section.title}
              </button>
              {LINE_AFTER.has(section.id) && <Separator className="my-2.5" />}
            </Fragment>
          )
        })}
      </nav>
    </aside>
  )
}
