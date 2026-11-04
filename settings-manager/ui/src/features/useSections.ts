import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/api'
import type { Act, Section, Value } from '@/types'

const showError = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error), { id: 'error', className: 'whitespace-pre-wrap' })

/** The sections from the window server, reloaded when the window gets focus, and a function that runs an action. */
export function useSections() {
  const [sections, setSections] = useState<Section[]>([])
  const run = useCallback(
    (request: Promise<Section[]>) =>
      request.then(
        sections => (setSections(sections), true),
        error => (showError(error), false),
      ),
    [],
  )
  /** Runs an action. After a failed action it reloads, so the window shows what is on disk. */
  const act = useCallback(
    (action: Act, value: Value | null) => run(api.act(action, value)).then(ok => ok || run(api.load())),
    [run],
  )

  useEffect(() => {
    const reload = () => run(api.load())
    reload()
    addEventListener('focus', reload)
    const timer = setInterval(api.ping, 15000)
    return () => (removeEventListener('focus', reload), clearInterval(timer))
  }, [run])

  return { sections, act }
}
