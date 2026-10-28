/** A file open in the viewer: its path relative to the project, and the first line shown. */
export type FilesPaneTab = { path: string; start: number; hit?: number }

/** One filename match: a path relative to the project. */
export type FilesPaneNameHit = { path: string }

/** One content match: the file, the 1-based line, and the line's text. */
export type FilesPaneGrepHit = { path: string; line: number; text: string }

/** What the filter field last produced. */
export type FilesPaneResults =
  | { kind: 'none' }
  | { kind: 'name'; query: string; hits: FilesPaneNameHit[]; total: number }
  | {
      kind: 'content'
      query: string
      hits: FilesPaneGrepHit[]
      isBusy: boolean
      note?: string
    }

/** Which half the narrow layout shows. */
export type FilesPaneView = 'tree' | 'viewer'

declare module 'claude-code' {
  interface PluginState {
    'files-pane': {
      expanded: string[]
      filter: string
      results: FilesPaneResults
      tabs: FilesPaneTab[]
      active: string | null
      modified: string[]
      view: FilesPaneView
    }
  }
}
