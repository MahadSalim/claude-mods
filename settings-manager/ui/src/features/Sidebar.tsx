import { Bot, FileText, Puzzle, Search, SlidersHorizontal, Sparkles, SquareTerminal, Webhook, Wrench, type LucideIcon } from 'lucide-react'
import { Fragment } from 'react'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { Section } from '@/types'

export const SECTION_ICONS: Record<string, LucideIcon> = {
  skills: Sparkles,
  prompts: FileText,
  agents: Bot,
  commands: SquareTerminal,
  tools: Wrench,
  plugins: Puzzle,
  hooks: Webhook,
  general: SlidersHorizontal,
}

/** Sections that have a divider after them. */
const LINE_AFTER = new Set(['tools', 'hooks'])

type Props = { sections: Section[]; current: string; query: string; onQuery: (query: string) => void; onPick: (id: string) => void }

/** The search field and the list of sections. */
export function Sidebar({ sections, current, query, onQuery, onPick }: Props) {
  return (
    <aside className="w-[250px] flex-none overflow-y-auto border-r px-3 py-3.5">
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
