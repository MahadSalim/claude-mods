export declare const DIRS: {
  skills: string
  prompts: string
  reminders: string
  agents: string
  commands: string
  hooks: string
  data: string
  context: string
}
export declare const CONTEXT_KEEP: number
export declare const DISABLED: string
export declare const FILES: { catalog: string; defaults: string; edits: string; disabled: string; server: string; history: string; summaries: string; connectors: string }
export type DisabledKind = 'skills' | 'sections' | 'reminders' | 'agents' | 'commands'
export declare const DISABLED_KINDS: DisabledKind[]
export type Disabled = Record<DisabledKind, string[]> & { hooks: Record<string, { event: string; group: unknown }> }
export declare function parseDisabled(text: string | undefined): Disabled
export declare const SAVED_REMINDERS: Set<string>
export declare const REMINDER_NOTES: Record<string, string>
export declare function fileName(id: string): string
export declare function frontmatter(text: string): { name?: string; description?: string }
export declare function join(...parts: string[]): string
