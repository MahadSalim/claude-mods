/** What the diff is taken against. */
export type ChangesBase = 'working' | 'staged' | 'unstaged' | 'last'

/** File list layout. */
export type ChangesView = 'list' | 'tree'

/** One changed file. */
export type ChangesFile = {
  path: string
  oldPath?: string
  /** Status letter shown in the list: M, A, D, R, C, T, U or ?. */
  status: string
  /** Index column of `git status --porcelain`, ' ' when unchanged. */
  x: string
  /** Worktree column of `git status --porcelain`, ' ' when unchanged. */
  y: string
  added: number | null
  deleted: number | null
}

/** The repository state the pane draws. */
export type ChangesSnapshot = {
  status: 'idle' | 'ok' | 'not-repo' | 'error'
  root: string
  branch: string
  files: ChangesFile[]
  added: number
  deleted: number
  error?: string
}

/** The diff of the selected file. */
export type ChangesDiff = {
  path: string
  base: ChangesBase
  source: string
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'changes-pane': {
      base: ChangesBase
      view: ChangesView
      selected: string | null
      confirm: string | null
      showDiff: boolean
      busy: boolean
      snapshot: Shaped<ChangesSnapshot>
      diff: Shaped<ChangesDiff | null>
    }
  }
}
