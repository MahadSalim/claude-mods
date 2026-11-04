import type { Act, State, Value } from './types'

/**
 * The server's token. It arrives in the page's address once; the page keeps it in session storage and takes it
 * out of the address, so it stays out of the browser's history.
 */
const token = (() => {
  let value = new URLSearchParams(location.search).get('t') ?? ''
  try {
    value ||= sessionStorage.getItem('t') ?? ''
    sessionStorage.setItem('t', value)
  } catch {
    // Storage can be off; the token then stays in the address.
    return value
  }
  history.replaceState(null, '', location.pathname)
  return value
})()
const headers = { 'x-token': token, 'content-type': 'application/json' }

/** Calls the window server and returns its state. */
export async function call(path: string, body?: unknown): Promise<State> {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export const load = () => call('/api/state')

/** Runs an action. `label` names the change for the Undo button. */
export const act = (action: Act, value: Value | null, label?: string) => call('/api/act', { act: action, value, label })

/** Undoes the last change. */
export const undo = () => call('/api/undo', {})

export const ping = () => fetch('/api/ping', { headers }).catch(() => {})

/** True inside the WebView2 window, which has no native title bar. */
export const isFrameless = !!window.chrome?.webview

/** Sends a window command to the WebView2 host: min | max | close | size <1-8>. */
export const win = (command: string) => window.chrome?.webview?.postMessage(command)
