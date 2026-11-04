// Entry point: `node main.mjs <config folder>` starts the server if it is not running and opens the window;
// `--tray` only starts it (on Windows, with its tray icon); `--serve` runs the server itself;
// `--migrate` moves the old `disabled` folders into disabled.json and exits.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTEXT_KEEP, DIRS, DISABLED, DISABLED_KINDS, FILES, REMINDER_NOTES, SAVED_REMINDERS, fileName, frontmatter, join, parseDisabled } from './shared.mjs'

const self = fileURLToPath(import.meta.url)
const [root = join(homedir(), '.claude'), mode] = process.argv.slice(2)
const at = (...parts) => join(root, ...parts)
const serverFile = at(DIRS.data, FILES.server)
const lockFile = at(DIRS.data, 'server.lock')
const isWindows = process.platform === 'win32'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Like `at`, for paths that come from the window: throws if the path leaves the config folder. */
function inside(...parts) {
  const full = at(...parts)
  const rel = nodePath.relative(nodePath.resolve(root), nodePath.resolve(full))
  if (!rel || rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) throw new Error(`${parts.join('/')} is outside the config folder.`)
  return full
}

const readText = path => fs.readFile(path, 'utf8').catch(() => undefined)
const readJson = async (path, fallback) => {
  try {
    return JSON.parse((await fs.readFile(path, 'utf8')).replace(/^﻿/, ''))
  } catch {
    return fallback
  }
}
/** Writes JSON. `mode` 0o600 keeps a file that holds secrets, such as the undo history, to its owner on macOS and Linux. */
const writeJson = async (path, value, mode) => {
  await fs.mkdir(path.replace(/\/[^/]*$/, ''), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined)
}
const list = async (dir, isDir) =>
  (await fs.readdir(at(dir), { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() === isDir && entry.name !== DISABLED)
    .map(entry => entry.name)
const firstLine = text => (text ?? '').split('\n').find(line => line.trim() && !/^(---|#|<)/.test(line.trim()))?.trim().slice(0, 300) ?? ''
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)

/** Puts items into titled groups, in the order of `order`, then by first appearance. */
function grouped(items, order = []) {
  const groups = new Map(order.map(title => [title, []]))
  for (const item of items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title))) {
    if (!groups.has(item.group)) groups.set(item.group, [])
    groups.get(item.group).push(item)
  }
  return [...groups].filter(([, rows]) => rows.length).map(([title, rows]) => ({ title, items: rows }))
}

const SKILL_GROUPS = {
  userSettings: 'Your skills',
  projectSettings: 'Project skills',
  syncedSkills: 'Synced skills',
  plugin: 'Plugin skills',
  'built-in': 'Built-in skills',
}

/** The switch of an item that `disabled.json` lists by name. */
const switchFor = (disabled, kind, name) => ({ value: !disabled[kind].includes(name), act: { type: 'disable', kind, name } })
const switchForName = switchFor

/** Your skill folders, then every other skill that a session saw. */
async function skills(catalog, disabled, settings) {
  // Claude Code's own `skillOverrides: { name: "off" }` also turns a skill off, so such a skill shows as off.
  const overrides = isObject(settings.skillOverrides) ? settings.skillOverrides : {}
  const switchFor = (disabled, kind, name) => {
    const row = switchForName(disabled, kind, name)
    return overrides[name] === 'off' ? { ...row, value: false, isDisabled: true, badge: 'off in skillOverrides' } : row
  }
  const items = []
  const yours = new Set()
  for (const folder of await list(DIRS.skills, true)) {
    const md = await readText(at(DIRS.skills, folder, 'SKILL.md'))
    if (!md) continue
    const meta = frontmatter(md)
    const name = meta.name ?? folder
    yours.add(name)
    items.push({
      title: name,
      description: meta.description || catalog.skills?.[name]?.description || '',
      group: SKILL_GROUPS.userSettings,
      ...switchFor(disabled, 'skills', name),
      edit: { path: join(DIRS.skills, folder, 'SKILL.md'), text: md.replace(/\r\n/g, '\n') },
    })
  }
  for (const [name, entry] of Object.entries(catalog.skills ?? {})) {
    if (yours.has(name)) continue
    // Older versions called a skill yours when it had a skill.json folder, so a "yours" without a folder is worked out
    // again the way the mod does it; the next session that lists the skill notes its real source.
    const source = entry.source !== 'userSettings' ? entry.source : name.startsWith('anthropic-skills:') ? 'syncedSkills' : name.includes(':') ? 'plugin' : 'built-in'
    items.push({ title: name, description: entry.description ?? '', group: SKILL_GROUPS[source] ?? 'Other skills', ...switchFor(disabled, 'skills', name) })
  }
  return grouped(items, Object.values(SKILL_GROUPS))
}

/** Rows for the Markdown files of a folder. */
async function files(dir, group, describe) {
  const items = []
  for (const name of (await list(dir, false)).filter(name => name.endsWith('.md'))) {
    const text = ((await readText(at(dir, name))) ?? '').replace(/\r\n/g, '\n')
    items.push({ group, ...describe(name.slice(0, -3), text) })
  }
  return items
}

/** Edit info for a prompt file. Only an edit made in the window counts, as `prompt-edits.json` records it. */
function editable(edits, key, path, text) {
  const isEdited = Object.hasOwn(edits, key)
  return { isEdited, edit: { path, text, key, isEdited } }
}

/** The id that a file name stands for: the catalog's id whose file name it is, else the name itself. */
const idOf = (entries, base) => Object.keys(entries ?? {}).find(id => fileName(id) === base) ?? base

async function prompts(catalog, edits, disabled, summaries) {
  const sections = await files(DIRS.prompts, 'Sections', (base, text) => {
    const id = idOf(catalog.sections, base)
    const { isEdited, edit } = editable(edits, base, join(DIRS.prompts, `${base}.md`), text)
    const summary = summaries[`sections/${id}`]?.text
    return { title: id, description: firstLine(text), summary, badge: catalog.sections?.[id]?.scope, isEdited, order: catalog.sections?.[id]?.order ?? 999, edit, ...switchFor(disabled, 'sections', id) }
  })
  const reminders = (
    await files(DIRS.reminders, 'Reminders', (base, text) => {
      const type = idOf(catalog.reminders, base)
      if (!SAVED_REMINDERS.has(type)) return undefined
      return {
        title: type,
        description: firstLine(text),
        summary: summaries[`reminders/${type}`]?.text,
        ...editable(edits, `${DIRS.reminders}/${base}`, join(DIRS.reminders, `${base}.md`), text),
        ...switchFor(disabled, 'reminders', type),
      }
    })
  ).filter(item => item.title)
  // Reminders whose text can hold private data are never saved, so they come from the catalog, with no text to edit.
  const shown = new Set(reminders.map(item => item.title))
  for (const type of Object.keys(catalog.reminders ?? {})) {
    if (shown.has(type) || SAVED_REMINDERS.has(type)) continue
    reminders.push({ title: type, description: REMINDER_NOTES[type] ?? 'Its text can hold details of your session, so the mod does not save it.', group: 'Reminders', ...switchFor(disabled, 'reminders', type) })
  }
  return grouped([...sections, ...reminders], ['Sections', 'Reminders'])
}

/** The mods built into Claude Code, from the mods overview, and whether each is on when settings do not say. */
const BUILT_IN_MODS = {
  'cc-plugin-agents-md@builtin': { description: 'Loads AGENTS.md as project instructions.', on: true },
  'cc-plugin-diff@builtin': { description: 'Draws the /diff pane.', on: true },
  'cc-plugin-plugin-authoring@builtin': { description: 'Gives Claude the skill for writing mods.', on: true },
  'cc-plugin-telemetry@builtin': { description: 'Sends the usage records that Claude Code logs.', on: true },
  'cc-plugin-you-should-know@builtin': { description: 'Shows tips about Claude Code features.', on: false },
}

/** Group names for plugins that come from no marketplace. */
const PLUGIN_SOURCES = { inline: 'Session plugins (--plugin-dir)', 'skills-dir': 'Skill-folder plugins', synced: 'Synced from Claude.ai' }

async function plugins(settings) {
  const installed = (await readJson(at('plugins', 'installed_plugins.json'), {})).plugins ?? {}
  const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}
  // Plugins in skill folders load as `<name>@skills-dir` and are on unless turned off.
  const skillDirPlugins = (await list(DIRS.skills, true)).filter(folder => existsSync(at(DIRS.skills, folder, '.claude-plugin', 'plugin.json')))
  const skillDirKeys = Object.fromEntries(skillDirPlugins.map(folder => [`${folder}@skills-dir`, at(DIRS.skills, folder)]))
  const keys = new Set([...Object.keys(installed), ...Object.keys(enabled), ...Object.keys(BUILT_IN_MODS), ...Object.keys(skillDirKeys)])
  const items = await Promise.all(
    [...keys].map(async key => {
      const [name, marketplace = ''] = key.split('@')
      const records = Array.isArray(installed[key]) ? installed[key] : []
      // A user install is the one that settings.json turns on; a project install belongs to its project.
      const install = records.find(record => record.scope === 'user') ?? records[0]
      const folder = install?.installPath ?? skillDirKeys[key]
      const manifest = folder ? await readJson(join(folder, '.claude-plugin', 'plugin.json'), {}) : {}
      const builtIn = BUILT_IN_MODS[key]
      const isLocalSource = marketplace in PLUGIN_SOURCES
      const isProjectOnly = !!install && !records.some(record => record.scope === 'user')
      const isMissing = !install && !builtIn && !isLocalSource
      const isSelf = name === 'settings-manager'
      // A plugin is on when settings do not say otherwise, unless its manifest sets defaultEnabled to false.
      const isOnByDefault = builtIn ? builtIn.on : manifest.defaultEnabled !== false
      const notes = [
        isSelf && 'Turn this mod off with /plugin. Everything in disabled.json then turns back on.',
        isProjectOnly && `Installed only for ${install.projectPath ?? 'a project'}; turn it on or off there.`,
        isMissing && 'Not installed. Turning it on would make Claude Code download it.',
      ].filter(Boolean)
      return {
        title: manifest.displayName ?? name,
        description: [builtIn?.description ?? manifest.description ?? key, ...notes].join(' '),
        badge: isMissing ? 'not installed' : install && install.scope !== 'user' ? `${install.version} · ${install.scope}` : install?.version,
        group: builtIn ? 'Built-in mods' : (PLUGIN_SOURCES[marketplace] ?? `From ${marketplace}`),
        value: typeof enabled[key] === 'boolean' ? enabled[key] : isOnByDefault,
        isDisabled: isSelf || isProjectOnly || isMissing,
        act: { type: 'setting', key: ['enabledPlugins', key], def: isOnByDefault },
      }
    }),
  )
  return grouped(items)
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The id of each hook group of one event: a hash of the event and the group, with `.2`, `.3` and so on for a group
 * that repeats an earlier one, so that two identical groups can each be turned off. Entries that are not hook
 * groups get no id; Claude Code warns about them and skips them.
 */
function hookIds(event, groups) {
  const seen = new Map()
  return (Array.isArray(groups) ? groups : []).map(group => {
    if (!isObject(group)) return undefined
    const base = hash([event, group])
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n > 1 ? `${base}.${n}` : base
  })
}

/** A key for `disabled.hooks` that no saved hook has yet. */
const freeHookKey = (saved, id) => {
  let key = id
  while (Object.hasOwn(saved, key)) key = `${id}.${randomBytes(3).toString('hex')}`
  return key
}

/** One handler as a line: its command and arguments, URL, prompt or MCP tool, after its `if` filter. */
function describeHook(hook) {
  if (!isObject(hook)) return ''
  const what =
    hook.type === 'mcp_tool' ? `${hook.server} ${hook.tool}` : [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])].filter(Boolean).join(' ') || hook.url || hook.prompt || hook.type
  return (hook.if ? `[${hook.if}] ` : '') + what
}

async function hooks(settings, disabled) {
  const allOff = settings.disableAllHooks === true
  const row = (event, group, isOn, id) => ({
    title: group.matcher ? `${event} · ${group.matcher}` : event,
    description: (Array.isArray(group.hooks) ? group.hooks : []).map(describeHook).join('  ·  '),
    view: JSON.stringify(group, null, 2),
    group: 'Settings hooks',
    value: isOn,
    isDisabled: allOff,
    act: { type: 'hook', event, id },
  })
  const items = Object.entries(isObject(settings.hooks) ? settings.hooks : {}).flatMap(([event, groups]) => {
    const ids = hookIds(event, groups)
    return ids.flatMap((id, i) => (id ? [row(event, groups[i], true, id)] : []))
  })
  for (const [id, saved] of Object.entries(disabled.hooks)) {
    if (isObject(saved?.group) && typeof saved.event === 'string') items.push(row(saved.event, saved.group, false, id))
  }
  const all = {
    title: 'Run hooks',
    description: 'Off sets disableAllHooks in your user settings. A project’s settings can turn hooks back on, and managed hooks still run.',
    group: 'All hooks',
    value: !allOff,
    act: { type: 'setting', key: ['disableAllHooks'], invert: true, def: false },
  }
  return grouped([all, ...items], ['All hooks', 'Settings hooks'])
}

const AGENT_GROUPS = {
  userSettings: 'Your subagents',
  projectSettings: 'Project subagents',
  policySettings: 'Managed subagents',
  flagSettings: 'Session subagents (--agents)',
  'built-in': 'Built-in subagents',
  plugin: 'Plugin subagents',
}

/**
 * Your subagent files, in `agents` and its subfolders, which Claude Code also reads, then every other subagent
 * that a session offered. A file without a `name` is not loaded by Claude Code, so it gets no row.
 */
async function agents(catalog, disabled) {
  const paths = (await fs.readdir(at(DIRS.agents), { recursive: true }).catch(() => []))
    .map(path => path.replace(/\\/g, '/'))
    .filter(path => path.endsWith('.md') && !path.startsWith(`${DISABLED}/`))
  const items = []
  for (const path of paths) {
    const text = ((await readText(at(DIRS.agents, path))) ?? '').replace(/\r\n/g, '\n')
    const name = frontmatter(text).name
    if (!name) continue
    items.push({
      title: name,
      // The catalog holds the description as Claude Code parsed it, which a multi-line YAML value needs.
      description: catalog.agents?.[name]?.description || frontmatter(text).description || '',
      group: AGENT_GROUPS.userSettings,
      edit: { path: join(DIRS.agents, path), text },
      ...(catalog.agents?.[name]?.source === 'built-in' || ['Explore', 'Plan', 'general-purpose'].includes(name) ? { badge: 'replaces the built-in' } : {}),
      ...switchFor(disabled, 'agents', name),
    })
  }
  const fileNames = new Set(items.map(item => item.title))
  for (const [name, entry] of Object.entries(catalog.agents ?? {})) {
    if (fileNames.has(name)) continue
    items.push({ title: name, description: entry.description ?? '', group: AGENT_GROUPS[entry.source] ?? 'Other subagents', ...switchFor(disabled, 'agents', name) })
  }
  return grouped(items, Object.values(AGENT_GROUPS))
}

const COMMAND_GROUPS = { builtin: 'Built-in commands', user: 'Your commands', plugin: 'Plugin commands', mcp: 'MCP prompts' }

/** Commands that the window never turns off, so you can always manage plugins and this mod. The mod refuses them too. */
const PROTECTED_COMMANDS = new Set(['plugin', 'reload-plugins', 'exit', 'help', 'login', 'settings-manager'])

async function commands(catalog, disabled) {
  // Skills also show as commands; they belong to the Skills section, your own skill folders too.
  const skillNames = new Set(Object.keys(catalog.skills ?? {}))
  for (const folder of await list(DIRS.skills, true)) {
    const md = await readText(at(DIRS.skills, folder, 'SKILL.md'))
    if (md) skillNames.add(frontmatter(md).name ?? folder).add(folder)
  }
  const items = Object.entries(catalog.commands ?? {})
    .filter(([name]) => !skillNames.has(name) && name !== 'settings-manager' && !name.startsWith('__'))
    .map(([name, entry]) => {
      const isProtected = PROTECTED_COMMANDS.has(name)
      return {
        title: `/${name}`,
        description: [entry.description, isProtected && 'Always on, so you can manage plugins and this mod.'].filter(Boolean).join(' '),
        group: COMMAND_GROUPS[entry.source] ?? 'Other commands',
        ...switchFor(disabled, 'commands', name),
        ...(isProtected && { value: true, isDisabled: true }),
      }
    })
  return grouped(items, Object.values(COMMAND_GROUPS))
}

/** Tools that a deny rule cannot remove, as the permissions docs say. */
const UNREMOVABLE = new Set(['EndConversation'])

/** What else a deny rule on these tools does, from the docs. */
const TOOL_NOTES = {
  ToolSearch: 'Off makes MCP tools load up front instead of on demand, which can use much more context.',
  Edit: 'A deny on Edit also covers Write and NotebookEdit.',
  Read: 'A deny on Read also blocks Edit and Write.',
}

/** A glob in a deny rule, where `*` matches any run of characters. */
const globTest = (pattern, name) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name)

/** True when a deny rule removes the whole tool: its bare name, `Name(*)`, or a glob such as `*` or `B*`. */
const removesTool = (rule, name) => rule === name || rule === `${name}(*)` || (!rule.includes('(') && rule.includes('*') && globTest(rule, name))

/** Days after which a tool that no session has seen leaves the list, unless a deny rule names it. */
const STALE_DAYS = 30

function tools(catalog, settings) {
  const deny = settings.permissions?.deny ?? []
  const entries = Object.entries(catalog.tools ?? {}).filter(([, entry]) => !entry.mcp)
  // A denied tool leaves Claude Code's tool list, so a session never sees it: a bare rule still gets its row.
  for (const rule of deny) if (/^[A-Z]\w*$/.test(rule) && !catalog.tools?.[rule]) entries.push([rule, {}])
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString().slice(0, 10)
  const items = entries
    .filter(([name, entry]) => !entry.seenAt || entry.seenAt >= cutoff || deny.some(rule => removesTool(rule, name)))
    .map(([name, entry]) => {
      const scoped = deny.filter(rule => rule.startsWith(`${name}(`) && rule !== `${name}(*)`)
      const byOtherRule = deny.some(rule => rule !== name && rule !== `${name}(*)` && removesTool(rule, name))
      const notes = [
        UNREMOVABLE.has(name) && 'Claude Code does not let a deny rule remove this tool.',
        byOtherRule && 'A wider deny rule, such as *, removes this tool.',
        scoped.length > 0 && `Denied only for: ${scoped.join(', ')}`,
        TOOL_NOTES[name],
      ].filter(Boolean)
      return {
        title: name,
        description: [entry.description, ...notes].filter(Boolean).join(' '),
        badge: scoped.length ? `${scoped.length} scoped deny` : undefined,
        group: 'Built-in tools',
        value: UNREMOVABLE.has(name) || !deny.some(rule => removesTool(rule, name)),
        isDisabled: UNREMOVABLE.has(name) || byOtherRule,
        act: { type: 'deny', rule: name },
      }
    })
  return grouped(items, ['Built-in tools'])
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A server's name for people: a Claude.ai connector by the name that the desktop app gave the mod
 * (`connectors.json`), `claude_ai_X` as "claude.ai X", and a plugin's server with its plugin.
 */
function serverTitle(server, connectors = {}) {
  if (UUID.test(server)) return connectors[server] ?? `Claude.ai connector ${server.slice(0, 8)}`
  if (server.startsWith('claude_ai_')) return `claude.ai ${server.slice(10).replace(/_/g, ' ')}`
  const plugin = /^plugin_([^_]+)_(.+)$/.exec(server)
  return plugin ? `${plugin[2]} (plugin ${plugin[1]})` : server
}

/** A server's name as it appears in its tools' names, `mcp__<server>__<tool>`. */
const toolServerName = server => server.replace(/[^a-zA-Z0-9_-]/g, '_')

/** Where Claude Code keeps .claude.json: in the config folder when CLAUDE_CONFIG_DIR sets one, else in the home folder. */
const claudeJson = () => (existsSync(at('.claude.json')) ? at('.claude.json') : join(homedir(), '.claude.json'))

/**
 * The servers set up only in a project: in a project's entry of .claude.json, or in the .mcp.json of a project
 * that .claude.json lists. A server that is also set up at user level is not one of them.
 */
async function projectOnlyServers(config, userServers) {
  const projects = Object.entries(config.projects ?? {})
  const files = await Promise.all(projects.map(([path]) => readJson(join(path, '.mcp.json'), {})))
  const names = new Set(projects.flatMap(([, project], i) => [...Object.keys(project?.mcpServers ?? {}), ...Object.keys(files[i].mcpServers ?? {})]))
  for (const server of userServers) names.delete(server)
  return new Set([...names].map(toolServerName))
}

/** The rules that turn a whole server off. The docs lead with `mcp__<server>__*`; `mcp__<server>` does the same. */
const serverRules = server => [`mcp__${server}__*`, `mcp__${server}`]

/**
 * One group per user-level MCP server: the servers in .claude.json, the servers whose tools a session saw, such as
 * the desktop app's own servers and Claude.ai connectors, and the servers and tools that a deny rule names, which
 * Claude Code no longer lists. Servers set up only in a project are left out. The group's own switch, beside its
 * name, turns the whole server off. Each row turns off one tool; while the server is off, the rows keep their own
 * state but cannot be changed.
 */
async function mcp(catalog, settings, summaries, connectors) {
  const deny = settings.permissions?.deny ?? []
  const config = await readJson(claudeJson(), {})
  const userServers = Object.keys(config.mcpServers ?? {})
  const projectOnly = await projectOnlyServers(config, userServers)
  const servers = new Map(userServers.map(server => [toolServerName(server), []]))
  // The longest known server name that a tool name starts with, so a server whose name holds `__` stays whole.
  const known = [...new Set([...servers.keys(), ...Object.keys(connectors)])].sort((a, b) => b.length - a.length)
  const split = name => {
    const server = known.find(s => name.startsWith(`mcp__${s}__`)) ?? name.split('__')[1] ?? 'other'
    return [server, name.slice(`mcp__${server}__`.length) || name]
  }
  const add = (name, description) => {
    const [server, tool] = split(name)
    if (projectOnly.has(server)) return
    if (!servers.has(server)) servers.set(server, [])
    if (tool !== '*' && !servers.get(server).some(t => t.name === name)) servers.get(server).push({ name, tool, description })
  }
  for (const [name, entry] of Object.entries(catalog.tools ?? {})) if (entry.mcp) add(name, entry.description ?? '')
  for (const rule of deny) if (/^mcp__[^(]+$/.test(rule)) add(rule.split('__').length > 2 ? rule : `${rule}__*`, '')
  const groups = [...servers].map(([server, serverTools]) => {
    const isServerOn = !serverRules(server).some(rule => deny.includes(rule))
    const title = serverTitle(server, connectors)
    const items = serverTools
      .map(({ name, tool, description }) => ({ title: tool, description, summary: summaries[`tools/${name}`]?.text, value: !deny.includes(name), isDisabled: !isServerOn, act: { type: 'deny', rule: name } }))
      .sort((a, b) => a.title.localeCompare(b.title))
    const count = serverTools.length ? `${serverTools.length} ${serverTools.length === 1 ? 'tool' : 'tools'}` : 'No session has seen its tools yet'
    const note = server.startsWith('ccd_') ? ' · Part of the desktop app; turning it off can break the app.' : ''
    const [rule, ...also] = serverRules(server)
    return { title, items, toggle: { title, description: count + note, value: isServerOn, act: { type: 'deny', rule, also } } }
  })
  return groups.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
}

async function general(settings) {
  const styles = await Promise.all(
    (await list('output-styles', false)).filter(name => name.endsWith('.md')).map(async name => frontmatter((await readText(at('output-styles', name))) ?? '').name ?? name.slice(0, -3)),
  )
  const get = keys => keys.reduce((value, key) => value?.[key], settings)
  let order = 0
  /**
   * One settings row. `def` is Claude Code's default: an unset key shows it, and choosing it removes the key.
   * `min` and `max` bound a whole number.
   */
  const row = (group, title, description, keys, control, { def, min, max, ...extra } = {}) => ({
    group,
    title,
    description,
    order: order++,
    value: get(keys) ?? def,
    control,
    ...extra,
    act: { type: 'setting', key: keys, def, ...(min !== undefined && { number: true, min, max }) },
  })
  const options = (...values) => values.map(value => (Array.isArray(value) ? { value: value[0], label: value[1] } : { value, label: value }))
  const EFFORT = options(['', 'Default'], 'low', 'medium', 'high', 'xhigh')
  // Opus 5.5 and later models read effort from `modelSettings`, which /effort writes, so each model there gets a row.
  const perModel = Object.keys(settings.modelSettings ?? {}).flatMap(id => [
    row('Model', `Effort for ${id}`, `How hard ${id} thinks before it answers.`, ['modelSettings', id, 'effortLevel'], 'segmented', { options: EFFORT }),
  ])
  return grouped([
    row('Model', 'Model', 'The model that new sessions use.', ['model'], 'select', {
      options: options(['', 'Default'], 'best', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'opusplan'),
    }),
    ...perModel,
    row('Model', 'Effort (older models)', 'How hard Claude thinks before it answers. Opus 5.5 and later models use the rows for each model.', ['effortLevel'], 'segmented', { options: EFFORT }),
    row('Model', 'Thinking', 'Off turns extended thinking off for every session.', ['alwaysThinkingEnabled'], 'switch', { def: true }),
    row('Model', 'Fast mode', 'Use faster output where the model offers it.', ['fastMode'], 'switch', { def: false }),
    row('Model', 'Output style', 'How Claude structures its answers.', ['outputStyle'], 'select', {
      options: options(['', 'Default'], 'Proactive', 'Concise', 'Explanatory', 'Learning', ...styles),
    }),
    row('Model', 'Language', 'The language that Claude answers in.', ['language'], 'text'),
    row('Permissions', 'Default permission mode', 'How Claude asks before it acts.', ['permissions', 'defaultMode'], 'select', {
      options: options(['', 'Default'], 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'),
    }),
    row('Interface', 'Theme', 'The colors of the terminal interface.', ['theme'], 'select', {
      options: options(['', 'Default'], 'auto', 'dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'),
    }),
    row('Interface', 'Editor mode', 'How the prompt input handles keys.', ['editorMode'], 'segmented', { options: options(['', 'Default'], 'normal', 'vim') }),
    row('Interface', 'View mode', 'How much of Claude’s work the transcript shows.', ['viewMode'], 'segmented', { options: options(['', 'Default'], 'default', 'verbose', 'focus') }),
    row('Interface', 'Terminal UI', 'Draw in the normal terminal or in a full-screen view.', ['tui'], 'segmented', { options: options(['', 'Default'], 'default', 'fullscreen') }),
    row('Interface', 'Thinking summaries', 'Show a summary of Claude’s thinking in the transcript.', ['showThinkingSummaries'], 'switch', { def: false }),
    row('Interface', 'Spinner tips', 'Show tips beside the spinner while Claude works.', ['spinnerTipsEnabled'], 'switch', { def: true }),
    row('Behavior', 'Respect .gitignore', 'Leave ignored files out of file pickers and searches.', ['respectGitignore'], 'switch', { def: true }),
    row('Behavior', 'Git instructions', 'Add the built-in commit and pull request instructions to the system prompt.', ['includeGitInstructions'], 'switch', { def: true }),
    row('Behavior', 'Prompt suggestions', 'Suggest a next prompt after Claude replies.', ['promptSuggestionEnabled'], 'switch', { def: true }),
    row('Behavior', 'Auto-compact', 'Compact the conversation when the context window gets full.', ['autoCompactEnabled'], 'switch', { def: true }),
    row('Behavior', 'Auto memory', 'Let Claude save notes that later sessions read.', ['autoMemoryEnabled'], 'switch', { def: true }),
    row('Behavior', 'Auto-compact window', 'Tokens of context before Claude compacts the conversation: 100000 to 1000000.', ['autoCompactWindow'], 'text', { min: 100000, max: 1000000 }),
    row('Behavior', 'Keep transcripts for', 'Days before old sessions are deleted: 1 or more.', ['cleanupPeriodDays'], 'text', { min: 1 }),
    row('Updates', 'Update channel', 'Which releases Claude Code updates to.', ['autoUpdatesChannel'], 'segmented', { options: options(['', 'Default'], 'latest', 'stable') }),
    row('Sync', 'Sync skills from Claude.ai', 'Load the skills that your Claude.ai account has.', ['syncClaudeAiSkills'], 'switch', { def: true }),
    row('Sync', 'Sync plugins from Claude.ai', 'Load the plugins that your Claude.ai account has.', ['syncClaudeAiPlugins'], 'switch', { def: true }),
  ], ['Model', 'Permissions', 'Interface', 'Behavior', 'Updates', 'Sync'])
}

/** Parts of a variable name, between underscores, that mark its value as secret. The window hides it until you click the eye button. */
const SECRET_PARTS = new Set([
  'KEY', 'KEYS', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PASSPHRASE', 'PWD', 'AUTH', 'CREDENTIAL', 'CREDENTIALS',
  'PAT', 'PRIVATE', 'COOKIE', 'HEADERS', 'DSN', 'WEBHOOK', 'BEARER', 'SESSION',
])
/** Values that hold a credential whatever the name: known key prefixes, a URL with a password, or an auth header. */
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA)|:\/\/[^/\s:@]+:[^/\s@]+@|\bBearer\s|Authorization[:=]/i
const isSecret = (name, value = '') =>
  name.toUpperCase().split('_').some(part => SECRET_PARTS.has(part)) || /(API_?KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) || SECRET_VALUE.test(value)

function env(settings) {
  const items = Object.entries(settings.env ?? {}).map(([name, raw]) => {
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw)
    return { title: name, group: 'Variables', value, control: 'env', isSecret: isSecret(name, value), act: { type: 'env', name } }
  })
  return grouped(items)
}

/**
 * The context use that the mod saved for each session, newest first. The window keeps the newest
 * CONTEXT_KEEP files and deletes the rest.
 */
async function contexts() {
  const dir = at(DIRS.context)
  const names = (await fs.readdir(dir).catch(() => [])).filter(name => name.endsWith('.json'))
  const read = await Promise.all(names.map(async name => ({ name, value: await readJson(join(dir, name), undefined) })))
  const sorted = read.filter(file => file.value?.categories).sort((a, b) => String(b.value.savedAt).localeCompare(String(a.value.savedAt)))
  await Promise.all(sorted.slice(CONTEXT_KEEP).map(file => fs.rm(join(dir, file.name), { force: true })))
  return sorted.slice(0, CONTEXT_KEEP).map(file => file.value)
}

async function model() {
  const [settings, catalog, edits, disabled, summaries, connectors] = await Promise.all([
    readJson(at('settings.json'), {}),
    readJson(at(DIRS.data, FILES.catalog), {}),
    readJson(at(DIRS.data, FILES.edits), {}),
    readDisabled(),
    readJson(at(DIRS.data, FILES.summaries), {}),
    readJson(at(DIRS.data, FILES.connectors), {}),
  ])
  const section = async (id, title, folder, note, groups, empty) => ({ id, title, folder, note, empty, groups: await groups })
  return Promise.all([
    section('home', 'Home', '', 'What takes up the context window of your recent sessions. Counted after each turn, the same way as /context.', []),
    section('skills', 'Skills', DIRS.skills, 'Turned-off skills are listed in settings-manager/disabled.json. Changes reach Claude in new sessions.', skills(catalog, disabled, settings)),
    section('prompts', 'System prompt', DIRS.prompts, 'Each section is a file in prompts. Edit a section to change what Claude reads.', prompts(catalog, edits, disabled, summaries)),
    section('agents', 'Subagents', DIRS.agents, 'Subagent types that Claude can start.', agents(catalog, disabled)),
    section('commands', 'Commands', DIRS.commands, 'Turned-off commands are hidden and refused.', commands(catalog, disabled)),
    section('tools', 'Tools', '', 'Turning a tool off adds it to permissions.deny in settings.json.', tools(catalog, settings)),
    section('mcp', 'MCP', '', 'User-level and desktop app servers. Turning a server or tool off adds it to permissions.deny in settings.json.', mcp(catalog, settings, summaries, connectors), 'No session has seen an MCP server yet.'),
    section('plugins', 'Plugins', 'plugins', 'Plugins and mods load in new sessions, or after /reload-plugins.', plugins(settings)),
    section('hooks', 'Hooks', '', 'Hooks from your user settings.json. A turned-off hook moves to settings-manager/disabled.json. Project, managed and plugin hooks are not listed.', hooks(settings, disabled)),
    section('general', 'General', '', 'Settings from settings.json.', general(settings)),
    section('env', 'Environment', '', 'Variables from env in settings.json. Running sessions pick up new and changed values; a removed variable stays until Claude Code restarts.', env(settings), 'No variables are set.'),
  ])
}

/** The undo history: the last changes, newest last. Each holds the files and moves that it made. */
const HISTORY_SIZE = 50
const historyFile = at(DIRS.data, FILES.history)
let history = await readJson(historyFile, [])
if (!Array.isArray(history)) history = []

/** Collects what one action changes: the text of each file before and after, and each move. */
function newChange() {
  const files = new Map()
  return {
    files,
    moves: [],
    /** Saves the text of a file before the action writes or deletes it. Call it before every write. */
    async track(path) {
      if (!files.has(path)) files.set(path, (await readText(path)) ?? null)
    },
  }
}

/** Saves a finished change in the history, unless it changed nothing. */
async function remember(change, label) {
  const files = []
  for (const [path, before] of change.files) {
    const after = (await readText(path)) ?? null
    if (after !== before) files.push({ path, before, after })
  }
  if (!files.length && !change.moves.length) return
  history = [...history, { label, files, moves: change.moves }].slice(-HISTORY_SIZE)
  await writeJson(historyFile, history, 0o600)
}

/** Undoes the last change. Throws, and drops the change, if a file changed after it. */
async function undo() {
  const last = history.at(-1)
  if (!last) throw new Error('Nothing to undo.')
  const changed = []
  for (const file of last.files) if (((await readText(file.path)) ?? null) !== file.after) changed.push(file.path)
  for (const { from, to } of last.moves) if (!existsSync(to) || existsSync(from)) changed.push(to)
  if (changed.length) {
    // The change can never be undone now, so it leaves the history and Undo moves on to the change before it.
    history = history.slice(0, -1)
    await writeJson(historyFile, history, 0o600)
    throw new Error(`Settings Manager can't undo "${last.label}", because this changed after it:\n${changed.join('\n')}\nIt is removed from the undo list.`)
  }
  for (const { from, to } of [...last.moves].reverse()) await move(to, from)
  for (const file of last.files) {
    if (file.before === null) await fs.rm(file.path, { force: true })
    else {
      await fs.mkdir(file.path.replace(/\/[^/]*$/, ''), { recursive: true })
      await fs.writeFile(file.path, file.before)
    }
  }
  history = history.slice(0, -1)
  await writeJson(historyFile, history, 0o600)
}

const move = async (from, to) => {
  if (existsSync(to)) throw new Error(`${to} already exists`)
  await fs.mkdir(to.replace(/\/[^/]*$/, ''), { recursive: true })
  await fs.rename(from, to)
}

/**
 * Writes a whole file at once: to a temporary file, then renamed over it, so Claude Code, which watches
 * settings.json, never reads half a file. Windows can refuse the rename while another program has the file open,
 * so it is tried a few times.
 */
async function writeWhole(path, text) {
  await fs.mkdir(path.replace(/\/[^/]*$/, ''), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await fs.writeFile(temp, text)
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(temp, path)
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await fs.rm(temp, { force: true })
        throw error
      }
      await sleep(50 * (attempt + 1))
    }
  }
}

/** Writes a file and saves its old text in `change` first. */
async function write(change, path, text) {
  await change.track(path)
  await writeWhole(path, text)
}

/**
 * Records in `prompt-edits.json` that the person edited a prompt file in the window, or removes the record.
 * The mod gives Claude a file's text in place of Claude Code's own only while this record exists.
 */
async function markEdited(change, key, isEdited) {
  const path = at(DIRS.data, FILES.edits)
  const edits = await readJson(path, {})
  if (isEdited) edits[key] = { editedAt: new Date().toISOString() }
  else delete edits[key]
  await write(change, path, JSON.stringify(edits, null, 2) + '\n')
}

const disabledFile = at(DIRS.data, FILES.disabled)
const readDisabled = async () => parseDisabled(await readText(disabledFile))

/**
 * Reads `disabled.json` to change it. A file with a JSON error is refused, not read as empty: it holds the only
 * copy of each turned-off settings hook, which writing it back empty would lose.
 */
async function readDisabledToEdit() {
  const text = await readText(disabledFile)
  if (text?.trim()) {
    try {
      JSON.parse(text.replace(/^﻿/, ''))
    } catch (error) {
      throw new Error(`disabled.json has a JSON error, so Settings Manager did not change it. Fix the file first.\n${error.message}`)
    }
  }
  return parseDisabled(text?.replace(/^﻿/, ''))
}

/** Reads `disabled.json`, applies `edit` and writes it back. */
async function editDisabled(change, edit) {
  const disabled = await readDisabledToEdit()
  edit(disabled)
  for (const kind of DISABLED_KINDS) disabled[kind].sort((a, b) => a.localeCompare(b))
  await write(change, disabledFile, JSON.stringify(disabled, null, 2) + '\n')
}

/**
 * Moves the on/off state of the old layout into `disabled.json`: the `disabled` subfolders, the marker files
 * in them, and the folders that held only `skill.json` for skills that were not yours. Your own skill, subagent
 * and command files go back to their folders, unless a file of that name is already there; then they stay put.
 * Runs when the server starts, and does nothing once the old layout is gone.
 */
async function migrate() {
  const entries = async dir => (await fs.readdir(at(dir), { withFileTypes: true }).catch(() => [])).map(entry => ({ name: entry.name, isDir: entry.isDirectory() }))
  const onlySkillJson = async folder => {
    const names = (await entries(folder)).map(entry => entry.name)
    return names.length === 1 && names[0] === 'skill.json'
  }
  const fakeSkills = []
  for (const { name, isDir } of await entries(DIRS.skills)) if (isDir && name !== DISABLED && (await onlySkillJson(join(DIRS.skills, name)))) fakeSkills.push(name)
  const legacy = [DIRS.skills, DIRS.prompts, DIRS.reminders, DIRS.agents, DIRS.commands, DIRS.hooks].map(dir => join(dir, DISABLED))
  if (!fakeSkills.length && !legacy.some(dir => existsSync(at(dir)))) return

  const catalog = await readJson(at(DIRS.data, FILES.catalog), {})
  const disabled = await readDisabledToEdit()
  const add = (kind, name) => void (disabled[kind].includes(name) || disabled[kind].push(name))
  /** Puts a file or folder of yours back, or leaves it where it is when the name is taken. */
  const putBack = async (from, to) => {
    if (!existsSync(at(to))) await fs.rename(at(from), at(to))
  }
  const remove = path => fs.rm(at(path), { recursive: true, force: true })

  for (const folder of fakeSkills) await remove(join(DIRS.skills, folder))
  const skillsOff = join(DIRS.skills, DISABLED)
  for (const { name: folder, isDir } of await entries(skillsOff)) {
    if (!isDir) continue
    const md = await readText(at(skillsOff, folder, 'SKILL.md'))
    if (md) {
      add('skills', frontmatter(md).name ?? folder)
      await putBack(join(skillsOff, folder), join(DIRS.skills, folder))
    } else if (await onlySkillJson(join(skillsOff, folder))) {
      add('skills', (await readJson(at(skillsOff, folder, 'skill.json'), {})).name ?? folder)
      await remove(join(skillsOff, folder))
    }
  }
  // A prompt file holds Claude Code's text, which the mod writes again, so a copy that is in the way is deleted.
  for (const [dir, kind] of [[DIRS.prompts, 'sections'], [DIRS.reminders, 'reminders']]) {
    for (const { name, isDir } of await entries(join(dir, DISABLED))) {
      if (isDir || !name.endsWith('.md')) continue
      add(kind, idOf(catalog[kind], name.slice(0, -3)))
      const [from, to] = [join(dir, DISABLED, name), join(dir, name)]
      if (existsSync(at(to))) await remove(from)
      else await fs.rename(at(from), at(to))
    }
  }
  for (const [dir, kind] of [[DIRS.agents, 'agents'], [DIRS.commands, 'commands']]) {
    for (const { name, isDir } of await entries(join(dir, DISABLED))) {
      if (isDir) continue
      const path = join(dir, DISABLED, name)
      if (name.endsWith('.md')) {
        add(kind, kind === 'agents' ? (frontmatter((await readText(at(path))) ?? '').name ?? name.slice(0, -3)) : name.slice(0, -3))
        await putBack(path, join(dir, name))
      } else if (name.endsWith('.json')) {
        add(kind, (await readJson(at(path), {})).name ?? name.slice(0, -5))
        await remove(path)
      }
    }
  }
  // Old hook files are deleted only after disabled.json holds their hooks.
  const hookFiles = []
  for (const { name, isDir } of await entries(join(DIRS.hooks, DISABLED))) {
    const saved = !isDir && name.endsWith('.json') && (await readJson(at(DIRS.hooks, DISABLED, name), undefined))
    if (!saved?.group || typeof saved.group !== 'object' || typeof saved.event !== 'string') continue
    disabled.hooks[freeHookKey(disabled.hooks, hash([saved.event, saved.group]))] = { event: saved.event, group: saved.group }
    hookFiles.push(join(DIRS.hooks, DISABLED, name))
  }
  for (const kind of DISABLED_KINDS) disabled[kind].sort((a, b) => a.localeCompare(b))
  await writeJson(disabledFile, disabled)
  for (const path of hookFiles) await remove(path)
  // A folder that is empty now goes; one that still holds a file of yours stays.
  for (const dir of legacy) await fs.rmdir(at(dir)).catch(() => {})
}

/**
 * Deletes what older versions saved of reminders that can hold private data, such as your email, folder paths or
 * file contents: their files, their edit records, their stored originals and summaries, and their text in the
 * catalog. Only SAVED_REMINDERS keep their text. Runs when the server starts.
 */
async function forgetPrivateReminders() {
  const isPrivate = base => !SAVED_REMINDERS.has(base)
  for (const name of await list(DIRS.reminders, false)) if (name.endsWith('.md') && isPrivate(name.slice(0, -3))) await fs.rm(at(DIRS.reminders, name), { force: true })
  const prefix = `${DIRS.reminders}/`
  const prune = async (file, keep) => {
    const path = at(DIRS.data, file)
    const value = await readJson(path, undefined)
    if (!isObject(value)) return
    const kept = Object.fromEntries(Object.entries(value).filter(([key]) => keep(key)))
    if (Object.keys(kept).length !== Object.keys(value).length) await writeWhole(path, JSON.stringify(kept, null, 2) + '\n')
  }
  await prune(FILES.edits, key => !key.startsWith(prefix) || !isPrivate(key.slice(prefix.length)))
  await prune(FILES.defaults, key => !key.startsWith(prefix) || !isPrivate(key.slice(prefix.length)))
  await prune(FILES.summaries, key => !key.startsWith('reminders/') || !isPrivate(key.slice('reminders/'.length)))
  const catalogPath = at(DIRS.data, FILES.catalog)
  const catalog = await readJson(catalogPath, undefined)
  if (isObject(catalog?.reminders)) {
    let isChanged = false
    for (const [type, entry] of Object.entries(catalog.reminders)) {
      if (isPrivate(type) && isObject(entry) && Object.keys(entry).length) (catalog.reminders[type] = {}), (isChanged = true)
    }
    if (isChanged) await writeWhole(catalogPath, JSON.stringify(catalog, null, 2))
  }
}

/** Reads settings.json, applies `edit` and writes it back. A file with a JSON error is left as it is. */
async function editSettings(change, edit) {
  const file = at('settings.json')
  const text = await readText(file)
  let settings = {}
  if (text !== undefined && text.trim()) {
    try {
      settings = JSON.parse(text.replace(/^﻿/, ''))
    } catch (error) {
      throw new Error(`settings.json has a JSON error, so Settings Manager did not change it. Fix the file first.\n${error.message}`)
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json does not hold a JSON object, so Settings Manager did not change it.')
  edit(settings)
  await write(change, file, JSON.stringify(settings, null, 2) + '\n')
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Key names that would reach JavaScript's object prototype, which the window never writes. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Each action changes files on disk. `change` collects what it changes, so the change can be undone. */
const ACTIONS = {
  /** Turns a skill, section, reminder, subagent or command on or off by name in `disabled.json`. */
  async disable({ kind, name }, isOn, change) {
    if (!DISABLED_KINDS.includes(kind) || typeof name !== 'string' || !name) throw new Error('Settings Manager does not know this item. Reload the window.')
    if (kind === 'commands' && !isOn && PROTECTED_COMMANDS.has(name)) throw new Error(`/${name} always stays on, so you can manage plugins and this mod.`)
    await editDisabled(change, disabled => {
      disabled[kind] = disabled[kind].filter(item => item !== name)
      if (!isOn) disabled[kind].push(name)
    })
  },
  /**
   * Sets a key of settings.json. An empty value, or Claude Code's default `def`, removes the key, and parent
   * objects left empty go too. A `number` must be a whole number from `min` to `max`.
   */
  async setting({ key, invert, number, min, max, def }, value, change) {
    if (!Array.isArray(key) || !key.length || key.some(part => typeof part !== 'string' || UNSAFE_KEYS.has(part))) throw new Error('Settings Manager does not know this setting. Reload the window.')
    let next = invert ? !value : value
    if (number && typeof next === 'string' && next.trim()) {
      next = Number(next.trim())
      if (!Number.isInteger(next) || next < (min ?? -Infinity) || next > (max ?? Infinity)) {
        throw new Error(`${key.at(-1)} takes a whole number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}.`)
      }
    }
    await editSettings(change, settings => {
      const parents = [settings]
      for (const part of key.slice(0, -1)) parents.push((parents.at(-1)[part] ??= {}))
      const parent = parents.at(-1)
      if (next === '' || next === null || (typeof next === 'string' && !next.trim()) || (def !== undefined && next === def)) delete parent[key.at(-1)]
      else parent[key.at(-1)] = next
      for (let i = parents.length - 1; i > 0; i--) if (!Object.keys(parents[i]).length) delete parents[i - 1][key[i - 1]]
    })
  },
  /**
   * Adds `rule` to `permissions.deny`, or removes it. Turning on also removes the other spellings of the same rule:
   * `also`, and `<rule>(*)`, which the docs make the same as the bare name.
   */
  async deny({ rule, also = [] }, isOn, change) {
    if (typeof rule !== 'string' || !rule || !Array.isArray(also)) throw new Error('Settings Manager does not know this rule. Reload the window.')
    const drop = new Set([rule, `${rule}(*)`, ...also])
    await editSettings(change, settings => {
      const deny = ((settings.permissions ??= {}).deny ??= []).filter(item => !drop.has(item))
      settings.permissions.deny = isOn ? deny : [...deny, rule]
    })
  },
  /** Sets a variable in `env`. A null value deletes it. `isNew` refuses a name that is already there. */
  async env({ name, isNew }, value, change) {
    if (typeof name !== 'string' || !ENV_NAME.test(name) || UNSAFE_KEYS.has(name)) throw new Error('A variable name uses only letters, digits and _, and it does not start with a digit.')
    await editSettings(change, settings => {
      const vars = (settings.env ??= {})
      // Windows reads variable names without regard to case, so FOO and foo are the same variable there.
      const taken = Object.keys(vars).find(other => (isWindows ? other.toUpperCase() === name.toUpperCase() : other === name))
      if (isNew && taken) throw new Error(`${taken} is already set.`)
      if (value === null) delete vars[name]
      else vars[name] = String(value)
      if (!Object.keys(vars).length) delete settings.env
    })
  },
  /** Moves a settings hook between settings.json and the `hooks` of `disabled.json`, which keeps it to turn back on. */
  async hook({ event, id }, isOn, change) {
    if (typeof id !== 'string' || UNSAFE_KEYS.has(id)) throw new Error('Settings Manager does not know this hook. Reload the window.')
    if (isOn) {
      // A turned-on hook goes back where it was in its event, under the event it was saved with.
      const saved = (await readDisabledToEdit()).hooks[id]
      if (!isObject(saved?.group) || typeof saved.event !== 'string') throw new Error('This hook is no longer saved in disabled.json. Reload the window.')
      await editSettings(change, settings => {
        if (!isObject(settings.hooks)) settings.hooks = {}
        const groups = Array.isArray(settings.hooks[saved.event]) ? settings.hooks[saved.event] : (settings.hooks[saved.event] = [])
        groups.splice(Math.min(Number.isInteger(saved.index) ? saved.index : groups.length, groups.length), 0, saved.group)
      })
      return editDisabled(change, disabled => void delete disabled.hooks[id])
    }
    if (typeof event !== 'string' || UNSAFE_KEYS.has(event)) throw new Error('Settings Manager does not know this hook. Reload the window.')
    // The hook is saved in disabled.json first, and leaves settings.json only after that worked.
    const settingsText = (await readText(at('settings.json')))?.replace(/^﻿/, '')
    const groups = (() => {
      try {
        return JSON.parse(settingsText ?? '{}')?.hooks?.[event]
      } catch {
        return undefined
      }
    })()
    const index = hookIds(event, groups).indexOf(id)
    if (index < 0) throw new Error('This hook is no longer in settings.json. Reload the window.')
    let key
    await editDisabled(change, disabled => void (disabled.hooks[(key = freeHookKey(disabled.hooks, id))] = { event, index, group: groups[index] }))
    try {
      await editSettings(change, settings => {
        const now = settings.hooks?.[event]
        if (hookIds(event, now)[index] !== id) throw new Error('settings.json changed. Reload the window.')
        now.splice(index, 1)
        if (!now.length) delete settings.hooks[event]
        if (!Object.keys(settings.hooks).length) delete settings.hooks
      })
    } catch (error) {
      await editDisabled(change, disabled => void delete disabled.hooks[key])
      throw error
    }
  },
  /**
   * Saves a file's text. For a prompt file (`key`), the edit record comes first, so a running session that reads
   * the file never takes the new text for Claude Code's own; text that equals the original is no edit.
   */
  async edit({ path, text, key }, _value, change) {
    if (typeof key === 'string') {
      const defaults = await readJson(at(DIRS.data, FILES.defaults), {})
      await markEdited(change, key, defaults[key] !== text)
    }
    await write(change, inside(path), text)
  },
  async reset({ path, key }, _value, change) {
    const target = inside(path)
    const defaults = await readJson(at(DIRS.data, FILES.defaults), {})
    if (defaults[key] === undefined) throw new Error(`No original text is saved for ${key} yet.`)
    await write(change, target, defaults[key])
    await markEdited(change, key, false)
  },
  async reveal({ folder }) {
    const target = (folder ? inside(folder) : at()).replace(/\//g, process.platform === 'win32' ? '\\' : '/')
    await fs.mkdir(target, { recursive: true })
    openExternal(target)
  },
}

/** Runs an action and saves what it changed in the history, even when it fails part way. */
async function run(act, value, label) {
  if (!Object.hasOwn(ACTIONS, act?.type)) throw new Error(`Unknown action: ${act?.type}`)
  const change = newChange()
  try {
    await ACTIONS[act.type](act, value, change)
  } finally {
    await remember(change, typeof label === 'string' && label ? label : 'the last change')
  }
}

function detached(command, args) {
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref()
}

function openExternal(target) {
  if (process.platform === 'win32') detached('explorer.exe', [target])
  else detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [target])
}

/** Where there is no tray process, opens the page in a browser's app mode, which shows it as a window of its own. */
function openWindow(url) {
  const env = process.env
  const candidates =
    process.platform === 'win32'
      ? [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].flatMap(base =>
          base ? [`${base}\\Microsoft\\Edge\\Application\\msedge.exe`, `${base}\\Google\\Chrome\\Application\\chrome.exe`] : [],
        )
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  const browser = candidates.find(path => existsSync(path))
  if (browser) detached(browser, [`--app=${url}`, '--window-size=1120,780'])
  else if (process.platform === 'win32') detached('cmd', ['/c', 'start', '', url])
  else openExternal(url)
}

const isAlive = async info => {
  try {
    return (await fetch(`http://127.0.0.1:${info.port}/api/ping`, { headers: { 'x-token': info.token }, signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

/** The running server's info, or undefined. A server from another copy of this script is stopped, so an update takes over. */
async function running() {
  const info = await readJson(serverFile, undefined)
  if (!info || !(await isAlive(info))) return undefined
  if (info.script === self) return info
  try {
    process.kill(info.pid)
  } catch {}
  await sleep(300)
  return undefined
}

/** Starts the server once: a lock file keeps two sessions that start together from starting two. */
async function start() {
  await fs.mkdir(at(DIRS.data), { recursive: true })
  for (let tries = 0; tries < 150; tries++) {
    const lock = await fs.open(lockFile, 'wx').catch(error => (error.code === 'EEXIST' ? undefined : Promise.reject(error)))
    if (lock) {
      await lock.close()
      try {
        const info = await running()
        if (info) return info
        const child = spawn(process.execPath, [self, root, '--serve'], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        for (let wait = 0; wait < 100; wait++) {
          await sleep(100)
          const info = await readJson(serverFile, undefined)
          if (info?.pid === child.pid) return info
        }
        throw new Error('The window server did not start.')
      } finally {
        await fs.rm(lockFile, { force: true })
      }
    }
    const stat = await fs.stat(lockFile).catch(() => undefined)
    if (stat && Date.now() - stat.mtimeMs > 15000) await fs.rm(lockFile, { force: true })
    await sleep(100)
    const info = await running()
    if (info) return info
  }
  throw new Error('The window server did not start.')
}

async function launch(isOpen) {
  if (!isOpen && !isWindows) return
  const info = (await running()) ?? (await start())
  if (!isOpen) return
  const res = await fetch(`http://127.0.0.1:${info.port}/api/open`, { headers: { 'x-token': info.token } })
  if (!res.ok) throw new Error(`The window server could not open the window: ${await res.text()}`)
}

/** On Windows, the tray process that owns the window. The server ends when it ends. */
function startTray(url) {
  const [script, icon] = ['./window.ps1', './icon.ico'].map(file => fileURLToPath(new URL(file, import.meta.url)))
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, url, icon], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  child.stdin.on('error', () => {})
  const stop = async () => {
    if ((await readJson(serverFile, undefined))?.pid === process.pid) await fs.rm(serverFile, { force: true })
    process.exit(0)
  }
  child.on('error', stop).on('exit', stop)
  return child
}

/** Content types of the built UI files in `dist`, by extension. */
const TYPES = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' }
const DIST = new URL('./dist/', import.meta.url)
const isAsset = path => /^\/(assets\/)?[\w.-]+\.(js|css|svg|png|woff2)$/.test(path)

async function serve() {
  // A failed move is kept in a file to read, and the server starts anyway.
  await migrate().catch(error => writeJson(at(DIRS.data, 'migration-error.json'), { message: String(error?.stack ?? error) }))
  await forgetPrivateReminders().catch(error => writeJson(at(DIRS.data, 'migration-error.json'), { message: String(error?.stack ?? error) }))
  const token = randomBytes(16).toString('hex')
  const page = await fs.readFile(new URL('index.html', DIST), 'utf8')
  let lastSeen = Date.now()
  let tray
  // The state holds settings and environment values, so no response is cached or sent on as a referrer.
  const send = (res, status, body, type = 'text/plain; charset=utf-8') =>
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }).end(body)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    // Only pages of this server may call it: another site that points its name at 127.0.0.1 sends its own Host.
    const port = server.address().port
    const host = String(req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'Forbidden')
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, 'Forbidden')
    if (isAsset(url.pathname)) {
      const body = await fs.readFile(new URL(`.${url.pathname}`, DIST)).catch(() => undefined)
      return body ? send(res, 200, body, TYPES[url.pathname.split('.').pop()]) : send(res, 404, 'Not found')
    }
    // The page holds no data, so it loads without the token; the page keeps the token after it leaves the address.
    if (url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8')
    if (url.searchParams.get('t') !== token && req.headers['x-token'] !== token) return send(res, 403, 'Forbidden')
    lastSeen = Date.now()
    try {
      if (url.pathname === '/api/ping') return send(res, 200, 'ok')
      if (url.pathname === '/api/open') {
        if (tray) tray.stdin.write('open\n')
        else openWindow(`http://127.0.0.1:${server.address().port}/?t=${token}`)
        return send(res, 200, 'ok')
      }
      if (req.method === 'POST' && url.pathname === '/api/act') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { act, value, label } = JSON.parse(body)
        await run(act, value, label)
      }
      if (req.method === 'POST' && url.pathname === '/api/undo') await undo()
      if (url.pathname.startsWith('/api/')) return send(res, 200, JSON.stringify({ root, sections: await model(), contexts: await contexts(), connectors: await readJson(at(DIRS.data, FILES.connectors), {}), undo: history.at(-1)?.label }), 'application/json')
      send(res, 404, 'Not found')
    } catch (error) {
      send(res, 500, String(error?.message ?? error))
    }
  })
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port
    if (isWindows) tray = startTray(`http://127.0.0.1:${port}/?t=${token}`)
    await writeJson(serverFile, { port, token, pid: process.pid, script: self })
  })
  // Without a tray icon nothing can stop the server, so it stops when the window has been gone a minute.
  if (!isWindows) setInterval(() => Date.now() - lastSeen > 60000 && process.exit(0), 5000)
}

await (mode === '--serve' ? serve() : mode === '--migrate' ? migrate() : launch(mode !== '--tray'))
