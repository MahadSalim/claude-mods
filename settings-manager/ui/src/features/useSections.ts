import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/api'
import type { Act, State, Value } from '@/types'

const showError = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error), { id: 'error', className: 'whitespace-pre-wrap' })

/** Runs an action. `label` names the change for the Undo button. Resolves to true when the action worked. */
export type OnAct = (action: Act, value: Value | null, label?: string) => Promise<boolean>

/** The sections from the window server, reloaded when the window gets focus, and functions that run an action or undo one. */
export function useSections() {
  const [state, setState] = useState<State>({ sections: [] })
  const run = useCallback(
    (request: Promise<State>) =>
      request.then(
        state => (setState(state), true),
        error => (showError(error), false),
      ),
    [],
  )
  /** After a failed action or undo, the window reloads, so it shows what is on disk. */
  const orReload = useCallback((ok: boolean) => ok || run(api.load()).then(() => false), [run])
  const act: OnAct = useCallback((action, value, label) => run(api.act(action, value, label)).then(orReload), [run, orReload])
  const undo = useCallback(() => run(api.undo()).then(orReload), [run, orReload])

  useEffect(() => {
    const reload = () => run(api.load())
    reload()
    addEventListener('focus', reload)
    const timer = setInterval(api.ping, 15000)
    return () => (removeEventListener('focus', reload), clearInterval(timer))
  }, [run])

  return { sections: state.sections, lastChange: state.undo, act, undo }
}
