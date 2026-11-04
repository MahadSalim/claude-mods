/** The window model that app/main.mjs sends from /api/state and /api/act. */
export type Value = string | number | boolean | undefined

export type Option = { value: string; label: string }

export type Act = { type: string; [key: string]: unknown }

export type Edit = { path: string; text: string; key?: string; isEdited?: boolean }

export type Item = {
  title: string
  description?: string
  badge?: string
  isEdited?: boolean
  value?: Value
  control?: 'switch' | 'segmented' | 'select' | 'text'
  options?: Option[]
  act: Act
  edit?: Edit
  view?: string
}

export type Group = { title: string; items: Item[] }

export type Section = { id: string; title: string; note: string; folder: string; groups: Group[] }

declare global {
  interface Window {
    chrome?: { webview?: { postMessage(message: string): void } }
  }
}
