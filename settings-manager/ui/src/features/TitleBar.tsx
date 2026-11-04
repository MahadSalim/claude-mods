import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { win } from '@/api'
import { cn } from '@/lib/utils'

const isMaximized = () => innerWidth >= screen.availWidth && innerHeight >= screen.availHeight

/** Top resize handles, as WMSZ edge numbers. The host window resizes the other edges itself. */
const EDGES = [
  { side: 3, className: 'inset-x-0 top-0 h-1 cursor-ns-resize' },
  { side: 4, className: 'top-0 left-0 size-2.5 cursor-nwse-resize' },
  { side: 5, className: 'top-0 right-0 size-2.5 cursor-nesw-resize' },
]

const WindowButton = ({ command, label, className, children }: { command: string; label: string; className?: string; children: React.ReactNode }) => (
  <button title={label} aria-label={label} onClick={() => win(command)} className={cn('grid h-full w-[46px] place-items-center text-neutral-300 [app-region:no-drag] hover:bg-neutral-800', className)}>
    {children}
  </button>
)

/** The window's own title bar, used in the WebView2 window. */
export function TitleBar() {
  const [isMax, setIsMax] = useState(isMaximized)
  useEffect(() => {
    const update = () => setIsMax(isMaximized())
    addEventListener('resize', update)
    return () => removeEventListener('resize', update)
  }, [])

  return (
    <>
      <div data-titlebar className="pointer-events-auto flex h-9 flex-none items-center border-b bg-neutral-950 select-none [app-region:drag]">
        <img src="/icon.svg" alt="" className="mr-2.5 ml-3 size-4" />
        <span className="flex-1 text-[12.5px] text-neutral-300">Settings Manager</span>
        <WindowButton command="min" label="Minimize">
          <Minus className="size-4" strokeWidth={1.25} />
        </WindowButton>
        <WindowButton command="max" label={isMax ? 'Restore' : 'Maximize'}>
          {isMax ? <Copy className="size-3.5 -scale-x-100" strokeWidth={1.25} /> : <Square className="size-3.5" strokeWidth={1.25} />}
        </WindowButton>
        <WindowButton command="close" label="Close" className="hover:bg-[#c42b1c] hover:text-white">
          <X className="size-4" strokeWidth={1.25} />
        </WindowButton>
      </div>
      {EDGES.map(edge => (
        <div key={edge.side} data-titlebar className={cn('pointer-events-auto fixed z-50 [app-region:no-drag]', edge.className)} onMouseDown={e => e.button === 0 && win(`size ${edge.side}`)} />
      ))}
    </>
  )
}
