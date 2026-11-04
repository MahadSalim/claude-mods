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
