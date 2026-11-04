import { RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { Item } from '@/types'
import { Badges } from './ItemRow'
import { fullText } from './text'
import type { OnAct } from './useSections'

type Question = 'discard' | 'reset'

/** The text classes that the viewer and the editor share, so the text stays in place when you click Edit. */
const TEXT = 'm-0 min-h-0 flex-1 overflow-auto px-4 py-3.5 font-mono text-[13px] leading-relaxed'

/** The prompt, the keep label, and the confirm label of each question the viewer asks before it drops text. */
const QUESTIONS: Record<Question, [string, string, string]> = {
  discard: ['Discard your unsaved changes?', 'Keep editing', 'Discard'],
  reset: ["Reset to Claude's original text? Your edits will be lost.", 'Cancel', 'Reset'],
}

type Props = { item: Item | undefined; onAct: OnAct; onClose: () => void }

/** The text viewer, which has an Edit button for editable text. */
export function TextDialog({ item: openItem, onAct, onClose }: Props) {
  const last = useRef(openItem)
  if (openItem) last.current = openItem
  const item = openItem ?? last.current
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState<Question>()

  useEffect(() => {
    if (!openItem) return
    setIsEditing(false)
    setDraft(openItem.edit?.text ?? '')
    setAsking(undefined)
  }, [openItem])

  const close = (force = false) => {
    if (!force && isEditing && draft !== item?.edit?.text) return setAsking('discard')
    onClose()
  }
  const save = () => {
    if (item?.edit) onAct({ type: 'edit', path: item.edit.path, text: draft }, null, `Edit ${item.title}`)
    close(true)
  }
  const confirm = () => {
    if (asking === 'reset' && item?.edit) onAct({ type: 'reset', ...item.edit }, null, `Reset ${item.title}`)
    close(true)
  }

  const [question, keep, confirmLabel] = asking ? QUESTIONS[asking] : []
  return (
    <Dialog open={!!openItem} onOpenChange={open => !open && close()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(640px,calc(100vh-84px))] w-[min(900px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onEscapeKeyDown={e => asking && (e.preventDefault(), setAsking(undefined))}
        onPointerDownOutside={e => e.target instanceof Element && e.target.closest('[data-titlebar]') && e.preventDefault()}
        onKeyDown={e => e.key === 's' && (e.ctrlKey || e.metaKey) && isEditing && (e.preventDefault(), save())}
      >
        {item && (
          <>
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <DialogTitle className="flex flex-1 items-center gap-2 text-base">
                {item.title}
                <Badges item={item} />
              </DialogTitle>
              <DialogDescription className="sr-only">Full text of {item.title}</DialogDescription>
              {item.edit && !isEditing && (
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  Edit
                </Button>
              )}
              <DialogClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close">
                  <X />
                </Button>
              </DialogClose>
            </header>
            {isEditing ? (
              <Textarea
                autoFocus
                spellCheck={false}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                className={`${TEXT} resize-none rounded-none border-0 shadow-none focus-visible:ring-0 md:text-[13px] dark:bg-transparent`}
              />
            ) : (
              <pre className={`${TEXT} whitespace-pre-wrap [overflow-wrap:anywhere]`}>{fullText(item)}</pre>
            )}
            {(asking || isEditing) && (
              <footer className="flex items-center justify-end gap-2 border-t px-4 py-3">
                <span className="flex-1 text-muted-foreground">{question}</span>
                {asking ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setAsking(undefined)}>
                      {keep}
                    </Button>
                    <Button size="sm" onClick={confirm}>
                      {confirmLabel}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" size="icon" aria-label="Reset to default" title="Reset to default" disabled={!item.edit?.isEdited} onClick={() => setAsking('reset')}>
                      <RotateCcw />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => close()}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={save}>
                      Save
                    </Button>
                  </>
                )}
              </footer>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
