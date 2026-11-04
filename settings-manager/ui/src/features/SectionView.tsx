import { FolderOpen, Plus, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Group, Item, Section } from '@/types'
import { ItemRow } from './ItemRow'
import { matches } from './text'
import type { OnAct } from './useSections'

type RowProps = { onAct: OnAct; onOpen: (item: Item) => void }

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

/** The form that adds an environment variable. It clears after the variable is saved. */
function AddVariable({ onAct }: { onAct: OnAct }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed && (await onAct({ type: 'env', name: trimmed, isNew: true }, value, `Add ${trimmed}`))) (setName(''), setValue(''))
  }
  return (
    <form onSubmit={add} className="mt-8">
      <h2 className="mb-2 text-[13px] font-semibold text-muted-foreground">Add a variable</h2>
      <div className="flex items-center gap-2">
        <Input aria-label="New variable name" placeholder="NAME" value={name} onChange={e => setName(e.target.value)} className="w-64 font-mono text-[13px] md:text-[13px]" />
        <Input aria-label="New variable value" placeholder="Value" value={value} onChange={e => setValue(e.target.value)} className="flex-1 font-mono text-[13px] md:text-[13px]" />
        <Button type="submit" variant="outline" disabled={!name.trim()}>
          <Plus />
          Add
        </Button>
      </div>
    </form>
  )
}

type SectionProps = { section: Section; lastChange?: string; onUndo: () => void } & RowProps

/** One section with its heading, note, Undo button and folder button. */
export function SectionView({ section, lastChange, onUndo, ...rest }: SectionProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <div className="mr-1 flex-1">
          <h1 className="mb-1 text-[17px] font-semibold">{section.title}</h1>
          <div className="text-[13px] text-muted-foreground">{section.note}</div>
        </div>
        <span title={lastChange ? `Undo: ${lastChange}` : 'Nothing to undo'}>
          <Button variant="outline" size="icon" aria-label={lastChange ? `Undo: ${lastChange}` : 'Undo'} disabled={!lastChange} onClick={onUndo}>
            <Undo2 />
          </Button>
        </span>
        {section.folder !== '' && (
          <Button variant="outline" size="icon" title="Open folder" aria-label="Open folder" onClick={() => rest.onAct({ type: 'reveal', folder: section.folder }, null)}>
            <FolderOpen />
          </Button>
        )}
      </div>
      {section.groups.length ? (
        <Groups groups={section.groups} {...rest} />
      ) : (
        <Empty>{section.empty ?? 'Nothing here yet. Start a Claude Code session with the mod loaded, then reopen this window.'}</Empty>
      )}
      {section.id === 'env' && <AddVariable onAct={rest.onAct} />}
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
