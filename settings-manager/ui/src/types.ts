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
  control?: 'switch' | 'segmented' | 'select' | 'text' | 'env'
  /** True for a variable whose value the window hides until you click the eye button. */
  isSecret?: boolean
  options?: Option[]
  /** True for a row whose control cannot change now, such as a tool of an MCP server that is off. */
  isDisabled?: boolean
  act: Act
  edit?: Edit
  view?: string
}

/** A titled list of rows. `toggle` is a switch for the whole group, drawn beside its title, such as an MCP server's. */
export type Group = { title: string; items: Item[]; toggle?: Item }

export type Section = { id: string; title: string; note: string; folder: string; empty?: string; groups: Group[] }

/** What the window server sends: the sections, and a label for the change that Undo would undo. */
export type State = { sections: Section[]; undo?: string }

declare global {
  interface Window {
    chrome?: { webview?: { postMessage(message: string): void } }
  }
}
