import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Item } from '@/types'
import { ItemControl } from './ItemControl'
import { changeLabel, fullText } from './text'
import type { OnAct } from './useSections'

/** The scope badge and the "edited" badge of an item. */
export function Badges({ item }: { item: Item }) {
  return (
    <>
      {item.badge && <Badge variant="outline" className="font-normal text-muted-foreground">{item.badge}</Badge>}
      {item.isEdited && <Badge variant="outline" className="border-orange-800 font-normal text-orange-300">edited</Badge>}
    </>
  )
}

type Props = { item: Item; onAct: OnAct; onOpen: (item: Item) => void }

/** One row: the title, description and badges, and the control. Rows with full text open in the viewer. */
export function ItemRow({ item, onAct, onOpen }: Props) {
  const canOpen = !!fullText(item)
  return (
    <div
      tabIndex={canOpen ? 0 : undefined}
      onClick={() => canOpen && onOpen(item)}
      onKeyDown={e => canOpen && e.key === 'Enter' && e.target === e.currentTarget && onOpen(item)}
      className={cn(
        'relative -mx-3 flex items-center gap-6 px-3 py-3',
        // The line under each row lines up with the text, so it stays straight when the row is rounded.
        'after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-border last:after:hidden',
        canOpen && 'cursor-pointer rounded-lg outline-none hover:bg-accent/50 focus-visible:bg-accent/50',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[15px] [overflow-wrap:anywhere]">
          {item.title}
          <Badges item={item} />
        </div>
        {item.description && <div className="mt-0.5 truncate text-[13.5px] text-muted-foreground">{item.description}</div>}
      </div>
      <div className="flex flex-none items-center gap-2" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        <ItemControl item={item} onSet={value => onAct(item.act, value, changeLabel(item, value))} />
      </div>
    </div>
  )
}
