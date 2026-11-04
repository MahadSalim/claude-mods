/** Folders that Settings Manager keeps under the Claude config folder. */
export const DIRS = {
  skills: 'skills',
  prompts: 'prompts',
  reminders: 'prompts/reminders',
  agents: 'agents',
  commands: 'commands',
  hooks: 'hooks',
  data: 'settings-manager',
  /** One file per session with its context use, by session id; the Home tab shows them. */
  context: 'settings-manager/context',
}

/** How many sessions' context files the window keeps; it deletes older ones. */
export const CONTEXT_KEEP = 20

/** Name of the subfolder that held turned-off items before `disabled.json`; the window moves what is left into the file. */
export const DISABLED = 'disabled'

/** Files that the mod and the window both read, under `DIRS.data`. */
export const FILES = {
  catalog: 'catalog.json',
  defaults: 'prompt-defaults.json',
  edits: 'prompt-edits.json',
  disabled: 'disabled.json',
  server: 'server.json',
  history: 'history.json',
  /** A one-sentence summary of each item, by `<kind>/<name>`, with a hash of the text that it summarizes. */
  summaries: 'summaries.json',
  /** The names of Claude.ai connectors by their id, which their tool names carry in place of a name. */
  connectors: 'connectors.json',
}

/** The kinds that `disabled.json` lists by name: skill names, section ids, reminder types, subagent and command names. */
export const DISABLED_KINDS = ['skills', 'sections', 'reminders', 'agents', 'commands']

/**
 * Reads `disabled.json` text into a complete value: a list of names for each kind, and the turned-off
 * settings hooks by id. Text that is missing or not valid JSON gives empty lists.
 */
export function parseDisabled(text) {
  let raw = {}
  try {
    raw = JSON.parse(text ?? '{}') ?? {}
  } catch {}
  const out = {}
  for (const kind of DISABLED_KINDS) out[kind] = Array.isArray(raw[kind]) ? raw[kind].filter(name => typeof name === 'string') : []
  out.hooks = raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? raw.hooks : {}
  return out
}

/**
 * The reminders whose text is fixed prose from Claude Code, the same in every session: the only ones the mod saves
 * and lets you edit. Others can carry private data, such as your email, folder paths, file contents or instructions
 * files, so they can be turned off, but their text is never written to disk.
 */
export const SAVED_REMINDERS = new Set([
  'auto_mode', 'auto_mode_exit', 'plan_mode', 'plan_mode_exit', 'plan_mode_reentry', 'task_reminder', 'todo_reminder',
  'silent_turn_reminder', 'tool_search_usage_reminder', 'output_style', 'output_style_instructions', 'language', 'model',
  'remote_session_change', 'critical_system_reminder',
])

/** What the reminders whose text is not saved are for, shown in the window in place of their text. */
export const REMINDER_NOTES = {
  session_context: 'Details of your account, such as your email.',
  environment: 'The working folder and other details of the session.',
  instructions: 'Your CLAUDE.md and AGENTS.md instructions.',
  invoked_skills: 'Skills used earlier in the session, kept across compaction.',
  diagnostics: 'New errors and warnings from your editor.',
  compact_file_reference: 'Files that Claude read before the conversation was compacted.',
  inlined_image_paths: 'Where attached images are saved.',
  date: 'Today’s date.',
  total_tokens_reminder: 'How many tokens are left in the session’s budget.',
  deferred_tools_delta: 'Tools that load on demand through ToolSearch.',
  mcp_instructions_delta: 'Instructions from connected MCP servers.',
  agent_listing_delta: 'The subagents that Claude can start.',
  hook_additional_context: 'Text that your hooks add.',
  edited_text_file: 'Files that changed since Claude read them.',
  file: 'The contents of a file that you mentioned.',
  nested_memory: 'CLAUDE.md files from folders that Claude works in.',
}

/** Turns an id into a file or folder name that every file system accepts. */
export const fileName = id => id.replace(/:/g, '__').replace(/[<>"/\\|?*\x00-\x1f]/g, '_')

/** Reads `name` and `description` from the frontmatter of a Markdown file. */
export function frontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out = {}
  for (const line of block ? block[1].split(/\r?\n/) : []) {
    const pair = /^(name|description):\s*(.*)$/.exec(line)
    if (pair) out[pair[1]] = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

/** Joins path parts with forward slashes. */
export const join = (...parts) => parts.join('/').replace(/[\\/]+/g, '/')
