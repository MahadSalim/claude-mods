import type { EngineInterface as $, Register } from 'claude-code'
import { DIRS, DISABLED, FILES, fileName, frontmatter, join } from '../app/shared.mjs'

type Entry = { description?: string; source?: string; scope?: string; order?: number; mcp?: boolean; plugin?: string }
const KINDS = ['skills', 'sections', 'reminders', 'agents', 'commands', 'tools'] as const
type Catalog = Record<(typeof KINDS)[number], Record<string, Entry>>

/** The slash command that opens the window. */
const COMMAND = 'settings-manager'

let root = ''
let catalog = blankCatalog()
let defaults: Record<string, string> = {}
/** The prompt files that the person edited in the window, by key; read from disk at each refresh. */
let edits: Record<string, { editedAt?: string }> = {}
let isFlushPending = false
const known = { skills: new Set<string>() }
const off = {
  skills: new Set<string>(),
  sections: new Set<string>(),
  reminders: new Set<string>(),
  agents: new Set<string>(),
  commands: new Set<string>(),
}

function blankCatalog(): Catalog {
  return { skills: {}, sections: {}, reminders: {}, agents: {}, commands: {}, tools: {} }
}

const at = (...parts: string[]) => join(root, ...parts)
const unixLines = (text: string) => text.replace(/\r\n/g, '\n')
const brief = (text = '') => text.split('\n')[0].slice(0, 300)
const isOff = (name: string) => name !== COMMAND && (off.commands.has(name) || off.skills.has(name))

async function readJson<T>($: $, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return fallback
  }
}

async function entries($: $, dir: string) {
  return $.fs.list(at(dir)).catch(() => [])
}

/** Reads the `name` of each item in a folder: Markdown frontmatter, a JSON `name`, or the file name. */
async function names($: $, dir: string, kind: 'dir' | 'file') {
  const items = (await entries($, dir)).filter(item => item.kind === kind && item.name !== DISABLED)
  return Promise.all(
    items.map(async ({ name }) => {
      const base = name.replace(/\.(md|json)$/, '')
      const folder = kind === 'dir' ? join(dir, name) : dir
      const md = kind === 'dir' ? 'SKILL.md' : name.endsWith('.md') ? name : undefined
      const json = kind === 'dir' ? 'skill.json' : name.endsWith('.json') ? name : undefined
      const text = md && (await $.fs.read(at(folder, md)).catch(() => undefined))
      if (text) return frontmatter(text).name ?? base
      return (json && (await readJson<{ name?: string }>($, at(folder, json), {})).name) || base
    }),
  )
}

async function refresh($: $) {
  const fileBases = async (dir: string) =>
    (await entries($, dir)).filter(item => item.kind === 'file' && item.name.endsWith('.md')).map(item => item.name.slice(0, -3))
  edits = await readJson($, at(DIRS.data, FILES.edits), {})
  const [onSkills, offSkills, offSections, offReminders, offAgents, offCommands] = await Promise.all([
    names($, DIRS.skills, 'dir'),
    names($, join(DIRS.skills, DISABLED), 'dir'),
    fileBases(join(DIRS.prompts, DISABLED)),
    fileBases(join(DIRS.reminders, DISABLED)),
    names($, join(DIRS.agents, DISABLED), 'file'),
    names($, join(DIRS.commands, DISABLED), 'file'),
  ])
  known.skills = new Set([...onSkills, ...offSkills])
  off.skills = new Set(offSkills)
  off.sections = new Set(offSections)
  off.reminders = new Set(offReminders)
  off.agents = new Set(offAgents)
  off.commands = new Set(offCommands)
}

function note($: $, kind: keyof Catalog, name: string, entry: Entry) {
  const prev = catalog[kind][name]
  const fields = Object.entries(entry).filter(([, value]) => value !== undefined)
  if (prev && fields.every(([key, value]) => prev[key as keyof Entry] === value)) return
  catalog[kind][name] = { ...prev, ...Object.fromEntries(fields) }
  scheduleFlush($)
}

function scheduleFlush($: $) {
  if (isFlushPending) return
  isFlushPending = true
  $.clock.after(1500, () => flush($))
}

/** Merges the catalog and the prompt defaults into the files that other sessions also write. */
async function flush($: $) {
  isFlushPending = false
  const [disk, diskDefaults] = await Promise.all([
    readJson<Partial<Catalog>>($, at(DIRS.data, FILES.catalog), {}),
    readJson<Record<string, string>>($, at(DIRS.data, FILES.defaults), {}),
  ])
  for (const kind of KINDS) catalog[kind] = { ...disk[kind], ...catalog[kind] }
  defaults = { ...diskDefaults, ...defaults }
  await $.fs.write(at(DIRS.data, FILES.catalog), JSON.stringify(catalog, null, 2))
  await $.fs.write(at(DIRS.data, FILES.defaults), JSON.stringify(defaults, null, 2))
}

async function scan($: $) {
  const [commands, tools] = await Promise.all([$.command.list(), $.tool.list()])
  for (const c of commands) note($, 'commands', c.name, { description: brief(c.description), source: c.source, plugin: c.plugin })
  for (const t of tools) note($, 'tools', t.name, { description: brief(t.description), mcp: t.mcp })
}

async function skillSource($: $, name: string) {
  if (known.skills.has(name)) return 'userSettings'
  const seen = catalog.skills[name]?.source
  if (seen) return seen
  if (name.includes(':')) return name.startsWith('anthropic-skills:') ? 'syncedSkills' : 'plugin'
  return (await $.fs.exists(join('.claude', 'skills', name, 'SKILL.md'))) ? 'projectSettings' : 'built-in'
}

/** Drops the entries of turned-off skills from the skill listing and returns the entries it saw. */
function filterListing(text: string) {
  const kept: string[] = []
  const seen: { name: string; description: string }[] = []
  let isSkipping = false
  for (const line of text.split('\n')) {
    const entry = /^- (\S+?)(?::\s|:?$)/.exec(line)
    if (entry) {
      isSkipping = off.skills.has(entry[1])
      seen.push({ name: entry[1], description: line.slice(entry[0].length).trim() })
    }
    if (!isSkipping) kept.push(line)
  }
  return { text: kept.join('\n'), seen }
}

/** Gives each skill without a folder of its own a folder that holds `skill.json`. */
async function noteSkills($: $, seen: { name: string; description: string }[]) {
  for (const { name, description } of seen) {
    const source = await skillSource($, name)
    note($, 'skills', name, { description: brief(description), source })
    if (known.skills.has(name)) continue
    known.skills.add(name)
    await $.fs.write(at(DIRS.skills, fileName(name), 'skill.json'), JSON.stringify({ name, description, source }, null, 2))
  }
}

/**
 * The text Claude reads for a prompt file: the file's text when the person edited it in the window,
 * as `prompt-edits.json` records, else the live text, which the file then shows.
 *
 * A file that only differs from the live text is not an edit: another session may have written it
 * with its own text. The live text is always stored as the original under `key` in the prompt defaults.
 */
async function promptText($: $, key: string, dir: string, live: string) {
  const path = at(dir, `${key.split('/').at(-1)}.md`)
  if (defaults[key] !== live) {
    defaults[key] = live
    scheduleFlush($)
  }
  const saved = await $.fs.read(path).then(unixLines, () => undefined)
  if (saved !== undefined && Object.hasOwn(edits, key)) return saved
  if (saved !== live) await $.fs.write(path, live)
  return live
}

/** Attachments that carry the person's own words: the mod passes them on as they are, and never saves, edits or drops them. */
const PERSONS_WORDS = new Set(['queued_command'])

/** Attachments that carry the contents of files: they can be turned off, but the mod never saves or edits their text. */
const FILE_CONTENTS = new Set(['file', 'edited_text_file', 'nested_memory'])

const appScript = ($: $) => join($.plugin.root, 'app', 'main.mjs')

async function open($: $) {
  await scan($)
  await flush($)
  const result = await $.process
    .run(['node', appScript($), root], { timeoutMs: 20000 })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  if (result.exitCode === 0) return {}
  return { text: `Settings Manager could not open its window. It needs Node.js on PATH.\n${(result.stderr || result.stdout).trim()}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    root = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? join(home, '.claude')).replace(/\\/g, '/')
    const disk = await readJson<Partial<Catalog>>($, at(DIRS.data, FILES.catalog), {})
    catalog = { ...blankCatalog(), ...disk }
    defaults = await readJson($, at(DIRS.data, FILES.defaults), {})
    await refresh($)
    await scan($)
    await $.command.register({ name: COMMAND, description: 'Open the Settings Manager window', immediate: true })
    const started = await next(e)
    // Starts the tray icon if it is not running yet; the session does not wait for it.
    void $.process.run(['node', appScript($), root, '--tray'], { timeoutMs: 20000 }).catch(() => {})
    return started
  })

  on('turn.start', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const sections = []
    for (const [order, section] of result.sections.entries()) {
      note($, 'sections', section.id, { scope: section.scope, order })
      const file = fileName(section.id)
      if (off.sections.has(file)) continue
      sections.push({ ...section, text: await promptText($, file, DIRS.prompts, unixLines(section.text)) })
    }
    return { sections }
  })

  on('prompt.attachment', async ($, e, next) => {
    if (e.type === 'skill_listing') {
      const result = await next(e)
      if (result.text === null) return result
      const { text, seen } = filterListing(result.text)
      await noteSkills($, seen)
      return { text }
    }
    // Only Claude Code's own text can be edited or turned off; the person's words and other authors' text pass as they are.
    if (PERSONS_WORDS.has(e.type) || e.origin?.kind !== 'engine') return next(e)
    const file = fileName(e.type)
    if (off.reminders.has(file)) return { text: null }
    const result = await next(e)
    if (result.text === null || FILE_CONTENTS.has(e.type)) return result
    note($, 'reminders', e.type, { description: brief(result.text) })
    return { text: await promptText($, `${DIRS.reminders}/${file}`, DIRS.reminders, unixLines(result.text)) }
  })

  on('skill.prompt', async ($, e, next) => {
    note($, 'skills', e.skill, { source: e.source })
    return next(e)
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const skill = String((e as { skill?: string }).skill ?? '').replace(/^\//, '')
    return off.skills.has(skill) ? { deny: `The skill "${skill}" is turned off in Settings Manager.` } : next(e)
  })

  on('agent.offer', async ($, e, next) => {
    note($, 'agents', e.agent, { description: brief(e.description), source: e.source })
    return off.agents.has(e.agent) ? { isOffered: false } : next(e)
  })

  on('command.describe', async ($, e, next) => (isOff(e.command) ? { ...(await next(e)), isHidden: true } : next(e)))

  on('command.run', { command: COMMAND }, async $ => open($))

  on('command.run', async ($, e, next) =>
    isOff(e.command) ? { text: `/${e.command} is turned off in Settings Manager.` } : next(e),
  )
}
