import { useRef, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { isFrameless } from '@/api'
import type { Item } from '@/types'
import { SearchResults, SectionView } from './SectionView'
import { Sidebar } from './Sidebar'
import { TextDialog } from './TextDialog'
import { TitleBar } from './TitleBar'
import { useSections } from './useSections'

/** The Settings Manager window. */
export function SettingsApp() {
  const { sections, lastChange, act, undo } = useSections()
  const [current, setCurrent] = useState('skills')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Item>()
  const main = useRef<HTMLElement>(null)
  const search = query.trim().toLowerCase()
  const section = sections.find(section => section.id === current) ?? sections[0]
  const toTop = () => main.current?.scrollTo({ top: 0 })
  const rowProps = { onAct: act, onOpen: setOpen }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {isFrameless && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          sections={sections}
          current={current}
          query={query}
          onQuery={value => (setQuery(value), toTop())}
          onPick={id => (setQuery(''), setCurrent(id), toTop())}
        />
        <main ref={main} className="flex-1 overflow-y-auto px-8 pt-5.5 pb-15">
          <div key={search ? 'search' : section?.id} className="mx-auto max-w-[880px] animate-in duration-150 fade-in">
            {search ? <SearchResults sections={sections} query={search} {...rowProps} /> : section && <SectionView section={section} lastChange={lastChange} onUndo={undo} {...rowProps} />}
          </div>
        </main>
      </div>
      <TextDialog item={open} onAct={act} onClose={() => setOpen(undefined)} />
      <Toaster position="bottom-right" duration={6000} />
    </div>
  )
}
