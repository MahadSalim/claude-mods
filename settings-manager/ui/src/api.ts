import type { Act, Section, Value } from './types'

const token = new URLSearchParams(location.search).get('t') ?? ''
const headers = { 'x-token': token, 'content-type': 'application/json' }

/** Calls the window server and returns its sections. */
export async function call(path: string, body?: unknown): Promise<Section[]> {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()).sections
}

export const load = () => call('/api/state')

export const act = (action: Act, value: Value | null) => call('/api/act', { act: action, value })

export const ping = () => fetch('/api/ping', { headers }).catch(() => {})

/** True inside the WebView2 window, which has no native title bar. */
export const isFrameless = !!window.chrome?.webview

/** Sends a window command to the WebView2 host: min | max | close | size <1-8>. */
export const win = (command: string) => window.chrome?.webview?.postMessage(command)
