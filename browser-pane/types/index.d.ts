/** One browser tab: its history of URLs, an empty string being the new tab page. */
export type Tab = { id: string; history: string[]; index: number }

/** A link found on a fetched page. */
export type PageLink = { text: string; href: string }

/** What a tab shows for the URL it last loaded. */
export type Page = {
  url: string
  status: 'loading' | 'done' | 'error'
  title?: string
  code?: number
  contentType?: string
  bytes?: number
  kind?: 'markdown' | 'json' | 'text'
  language?: string
  body?: string
  links?: PageLink[]
  error?: string
}

/** A dev server's run state. */
export type ServerState = {
  status: 'stopped' | 'running' | 'exited' | 'failed' | 'external'
  code?: number | null
  isListening?: boolean
  logs: string[]
}

/** One entry of `.claude/launch.json`'s `configurations`. */
export type LaunchConfiguration = {
  name: string
  runtimeExecutable: string
  runtimeArgs?: string[]
  port?: number
  cwd?: string
  env?: Record<string, string>
}

/** Which panels of the pane are expanded. */
export type PaneView = {
  logsFor: string | null
  isConfigShown: boolean
  isLinksShown: boolean
}

/** Which view of a loaded page the pane shows. */
export type PageMode = 'snapshot' | 'text'

/** A tab's rendered snapshot: Raster cells for one URL at one width. */
export type Snapshot = {
  url: string
  columns: number
  rows: number
  status: 'rendering' | 'done' | 'error'
  cells?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'browser-pane': {
      tabs: Shaped<Tab[]>
      active: Shaped<string>
      pages: Shaped<Record<string, Page>>
      servers: Shaped<Record<string, ServerState>>
      view: Shaped<PaneView>
      mode: Shaped<PageMode>
      snapshots: Shaped<Record<string, Snapshot>>
    }
  }
}
