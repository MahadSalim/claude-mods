export type Toggle = 'rewrite' | 'append' | 'ask' | 'tasks' | 'context'

/** Who does the work: the main agent's choice, subagents only, or no new subagents. */
export type Mode = 'default' | 'orchestrator' | 'noSubagents'

export type ModelChoice = 'inherit' | 'haiku' | 'sonnet' | 'opus'

export type Snippet = { text: string; isOn: boolean }

/** The toggles and settings of all four mods, for one session. */
export type Config = {
  on: Record<Toggle, boolean>
  mode: Mode
  /** Tools the main agent may call in orchestrator mode. */
  open: string[]
  /** Most subagents one session may create; 0 is no cap. */
  cap: number
  reader: ModelChoice
  editor: ModelChoice
  other: ModelChoice
  apply: 'dialog' | 'direct'
  style: 'fix wording' | 'expand'
  hint: boolean
  /** Read cap, in thousands of tokens. */
  ctx: number
  slices: boolean
  snippets: Snippet[]
}

/** Values the UI draws in place of the session's, while a test runs. */
export type Preview = { config?: Partial<Omit<Config, 'on'>> & { on?: Partial<Config['on']> }; expanded?: string[] }

declare module 'claude-code' {
  interface PluginState {
    'agent-rules': { config: Config; expanded: string[]; preview: Preview | null }
  }
  interface McpToolInputs {
    'mcp__agent-rules__ui_test': { preview?: Preview | null; pane?: 'open' | 'close'; toast?: string }
  }
}
