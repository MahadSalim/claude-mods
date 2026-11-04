/** Folders that Settings Manager keeps under the Claude config folder. */
export const DIRS = {
  skills: 'skills',
  prompts: 'prompts',
  reminders: 'prompts/reminders',
  agents: 'agents',
  commands: 'commands',
  hooks: 'hooks',
  data: 'settings-manager',
}

/** Name of the subfolder that holds turned-off items. */
export const DISABLED = 'disabled'

/** Files that the mod and the window both read, under `DIRS.data`. */
export const FILES = { catalog: 'catalog.json', defaults: 'prompt-defaults.json', server: 'server.json', history: 'history.json' }

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
