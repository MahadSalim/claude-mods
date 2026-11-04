import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Act, Group, Item, Section, Value } from '@/types'
import { ItemRow } from './ItemRow'
import { matches } from './text'

type RowProps = { onAct: (action: Act, value: Value | null) => void; onOpen: (item: Item) => void }

function Groups({ groups, ...rest }: { groups: Group[] } & RowProps) {
  return groups.map(group => (
    <div key={group.title}>
      <h2 className="mt-8 mb-1 text-[13px] font-semibold text-muted-foreground">{group.title}</h2>
      {group.items.map((item, index) => (
        <ItemRow key={`${index}|${item.title}`} item={item} {...rest} />
      ))}
    </div>
  ))
}

const Empty = ({ children }: { children: string }) => <div className="py-4 text-muted-foreground">{children}</div>

/** One section with its heading, note and folder button. */
export function SectionView({ section, ...rest }: { section: Section } & RowProps) {
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="mb-1 text-[17px] font-semibold">{section.title}</h1>
          <div className="text-[13px] text-muted-foreground">{section.note}</div>
        </div>
        {section.folder !== '' && (
          <Button variant="outline" size="icon" title="Open folder" aria-label="Open folder" onClick={() => rest.onAct({ type: 'reveal', folder: section.folder }, null)}>
            <FolderOpen />
          </Button>
        )}
      </div>
      {section.groups.length ? <Groups groups={section.groups} {...rest} /> : <Empty>Nothing here yet. Start a Claude Code session with the mod loaded, then reopen this window.</Empty>}
    </>
  )
}

/** The items of every section that match the search query. */
export function SearchResults({ sections, query, ...rest }: { sections: Section[]; query: string } & RowProps) {
  const found = sections
    .map(section => ({ ...section, groups: section.groups.map(group => ({ ...group, items: group.items.filter(item => matches(item, query)) })).filter(group => group.items.length) }))
    .filter(section => section.groups.length)
  if (!found.length) return <Empty>Nothing matches your search.</Empty>
  return found.map(section => (
    <div key={section.id}>
      <h1 className="mt-7 text-[17px] font-semibold">{section.title}</h1>
      <Groups groups={section.groups} {...rest} />
    </div>
  ))
}
