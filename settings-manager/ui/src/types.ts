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

type Tokens = { tokens: number }

/** One session's context use as the mod saved it: the /context breakdown, without the grid. */
export type Context = {
  id: string
  cwd: string
  savedAt: string
  model: string
  totalTokens: number
  maxTokens: number
  autoCompactThreshold?: number
  /** `used` rows fill the window, `free` is what is left, `buffer` is kept for compaction, `deferred` loads on demand. */
  categories: ({ name: string; kind: 'used' | 'free' | 'buffer' | 'deferred' } & Tokens)[]
  mcpTools: ({ name: string; serverName: string; isLoaded: boolean } & Tokens)[]
  skills: ({ name: string; source: string; pluginName?: string } & Tokens)[]
  agents: ({ name: string; source: string } & Tokens)[]
  memoryFiles: ({ path: string; type: string } & Tokens)[]
  commands?: { count: number } & Tokens
}

/** What the window server sends: the sections, each session's context use, and a label for the change that Undo would undo. */
export type State = { sections: Section[]; contexts?: Context[]; undo?: string }

declare global {
  interface Window {
    chrome?: { webview?: { postMessage(message: string): void } }
  }
}
