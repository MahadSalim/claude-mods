// Entry point: `node main.mjs <config folder>` starts the server if it is not running and opens the window;
// `--tray` only starts it (on Windows, with its tray icon); `--serve` runs the server itself.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIRS, DISABLED, FILES, fileName, frontmatter, join } from './shared.mjs'

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
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = async (path, value) => {
  await fs.mkdir(path.replace(/\/[^/]*$/, ''), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n')
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

async function skills(catalog) {
  const items = []
  for (const isOn of [true, false]) {
    const dir = isOn ? DIRS.skills : join(DIRS.skills, DISABLED)
    for (const folder of await list(dir, true)) {
      const md = await readText(at(dir, folder, 'SKILL.md'))
      const meta = md ? frontmatter(md) : await readJson(at(dir, folder, 'skill.json'), {})
      const name = meta.name ?? folder
      const source = md ? 'userSettings' : (catalog.skills?.[name]?.source ?? meta.source)
      items.push({
        title: name,
        description: meta.description || catalog.skills?.[name]?.description || '',
        group: SKILL_GROUPS[source] ?? 'Other skills',
        value: isOn,
        act: { type: 'move', dir: DIRS.skills, name: folder },
        ...(md && { edit: { path: join(dir, folder, 'SKILL.md'), text: md.replace(/\r\n/g, '\n') } }),
      })
    }
  }
  return grouped(items, Object.values(SKILL_GROUPS))
}

/** Rows for the Markdown files of a folder and its `disabled` subfolder. */
async function files(dir, group, describe) {
  const items = []
  for (const isOn of [true, false]) {
    const from = isOn ? dir : join(dir, DISABLED)
    for (const name of (await list(from, false)).filter(name => name.endsWith('.md'))) {
      const text = ((await readText(at(from, name))) ?? '').replace(/\r\n/g, '\n')
      items.push({ group, value: isOn, act: { type: 'move', dir, name }, ...describe(name.slice(0, -3), text, from) })
    }
  }
  return items
}

/** Edit info for a prompt file; `key` names its original text in the prompt defaults. */
function editable(defaults, key, path, text) {
  const isEdited = defaults[key] !== undefined && text !== defaults[key]
  return { isEdited, edit: { path, text, key, isEdited } }
}

async function prompts(catalog, defaults) {
  const idOf = base => Object.keys(catalog.sections ?? {}).find(id => fileName(id) === base) ?? base
  const sections = await files(DIRS.prompts, 'Sections', (base, text, from) => {
    const id = idOf(base)
    const { isEdited, edit } = editable(defaults, base, join(from, `${base}.md`), text)
    return { title: id, description: firstLine(text), badge: catalog.sections?.[id]?.scope, isEdited, order: catalog.sections?.[id]?.order ?? 999, edit }
  })
  const reminders = await files(DIRS.reminders, 'Reminders', (base, text, from) => ({
    title: base,
    description: firstLine(text),
    ...editable(defaults, `${DIRS.reminders}/${base}`, join(from, `${base}.md`), text),
  }))
  return grouped([...sections, ...reminders], ['Sections', 'Reminders'])
}

const BUILT_IN_MODS = {
  'cc-plugin-agents-md@builtin': 'Loads AGENTS.md as project instructions.',
  'cc-plugin-diff@builtin': 'Draws the /diff pane.',
  'cc-plugin-plugin-authoring@builtin': 'Gives Claude the skill for writing mods.',
  'cc-plugin-telemetry@builtin': 'Sends the usage records that Claude Code logs.',
}

async function plugins(settings) {
  const installed = (await readJson(at('plugins', 'installed_plugins.json'), {})).plugins ?? {}
  const enabled = settings.enabledPlugins ?? {}
  const keys = new Set([...Object.keys(installed), ...Object.keys(enabled), ...Object.keys(BUILT_IN_MODS)])
  const items = []
  for (const key of keys) {
    const [name, marketplace = ''] = key.split('@')
    const install = installed[key]?.[0]
    const manifest = install ? await readJson(join(install.installPath, '.claude-plugin', 'plugin.json'), {}) : {}
    const isBuiltIn = key in BUILT_IN_MODS
    items.push({
      title: name,
      description: BUILT_IN_MODS[key] ?? manifest.description ?? key,
      badge: install?.version,
      group: isBuiltIn ? 'Built-in mods' : `From ${marketplace}`,
      value: isBuiltIn ? enabled[key] !== false : enabled[key] === true,
      act: { type: 'setting', key: ['enabledPlugins', key] },
    })
  }
  return grouped(items)
}

async function hooks(settings) {
  const describe = group => (group.hooks ?? []).map(hook => hook.command ?? hook.url ?? hook.prompt ?? hook.type).join('  ·  ')
  const row = (event, group, isOn) => ({
    title: group.matcher ? `${event} · ${group.matcher}` : event,
    description: describe(group),
    group: 'Settings hooks',
    value: isOn,
    act: { type: 'hook', event, id: hash([event, group]) },
  })
  const items = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) => groups.map(group => row(event, group, true)))
  for (const name of await list(join(DIRS.hooks, DISABLED), false)) {
    const saved = await readJson(at(DIRS.hooks, DISABLED, name), undefined)
    if (saved) items.push(row(saved.event, saved.group, false))
  }
  const all = {
    title: 'Run hooks',
    description: 'Run the hooks from settings files and plugins. Off sets disableAllHooks.',
    group: 'All hooks',
    value: settings.disableAllHooks !== true,
    act: { type: 'setting', key: ['disableAllHooks'], invert: true },
  }
  return grouped([all, ...items], ['All hooks', 'Settings hooks'])
}

const markerPath = (dir, name) => at(dir, DISABLED, `${fileName(name)}.json`)

async function agents(catalog) {
  const items = await files(DIRS.agents, 'Your subagents', (base, text) => {
    const meta = frontmatter(text)
    return { title: meta.name ?? base, description: meta.description ?? '' }
  })
  const fileNames = new Set(items.map(item => item.title))
  for (const [name, entry] of Object.entries(catalog.agents ?? {})) {
    if (fileNames.has(name)) continue
    items.push({
      title: name,
      description: entry.description ?? '',
      group: entry.source === 'built-in' ? 'Built-in subagents' : entry.source === 'plugin' ? 'Plugin subagents' : 'Other subagents',
      value: !existsSync(markerPath(DIRS.agents, name)),
      act: { type: 'marker', dir: DIRS.agents, name },
    })
  }
  return grouped(items, ['Your subagents', 'Built-in subagents', 'Plugin subagents'])
}

const COMMAND_GROUPS = { builtin: 'Built-in commands', user: 'Your commands', plugin: 'Plugin commands', mcp: 'MCP prompts' }

function commands(catalog) {
  const skillNames = new Set(Object.keys(catalog.skills ?? {}))
  const items = Object.entries(catalog.commands ?? {})
    .filter(([name]) => !skillNames.has(name) && name !== 'settings-manager')
    .map(([name, entry]) => ({
      title: `/${name}`,
      description: entry.description ?? '',
      group: COMMAND_GROUPS[entry.source] ?? 'Other commands',
      value: !existsSync(markerPath(DIRS.commands, name)),
      act: { type: 'marker', dir: DIRS.commands, name },
    }))
  return grouped(items, Object.values(COMMAND_GROUPS))
}

function tools(catalog, settings) {
  const deny = settings.permissions?.deny ?? []
  const items = Object.entries(catalog.tools ?? {})
    .filter(([, entry]) => !entry.mcp)
    .map(([name, entry]) => ({
      title: name,
      description: entry.description ?? '',
      group: 'Built-in tools',
      value: !deny.includes(name),
      act: { type: 'deny', rule: name },
    }))
  return grouped(items, ['Built-in tools'])
}

/** A server name that is an id, as claude.ai connectors have, is shown as a short connector name. */
const serverTitle = server => (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(server) ? `Claude.ai connector ${server.slice(0, 8)}` : server)

/**
 * One group per MCP server: the servers whose tools a session saw, and the servers in .claude.json that none did.
 * The first row turns the whole server off with the deny rule `mcp__<server>`; the others turn off one tool.
 */
async function mcp(catalog, settings) {
  const deny = settings.permissions?.deny ?? []
  const servers = new Map(Object.keys((await readJson(at('.claude.json'), {})).mcpServers ?? {}).map(server => [server, []]))
  for (const [name, entry] of Object.entries(catalog.tools ?? {})) {
    if (!entry.mcp) continue
    const [, server = 'other', ...rest] = name.split('__')
    if (!servers.has(server)) servers.set(server, [])
    servers.get(server).push({ name, tool: rest.join('__') || name, description: entry.description ?? '' })
  }
  const items = []
  for (const [server, serverTools] of servers) {
    const rule = `mcp__${server}`
    const isServerOn = !deny.includes(rule)
    const group = serverTitle(server)
    items.push({
      title: 'All tools',
      description: serverTools.length ? `Turns off every tool from ${server} (${serverTools.length}).` : `No session has seen tools from ${server} yet.`,
      badge: 'server',
      group,
      order: 0,
      value: isServerOn,
      act: { type: 'deny', rule },
    })
    for (const { name, tool, description } of serverTools) {
      items.push({ title: tool, description, group, order: 1, value: isServerOn && !deny.includes(name), act: { type: 'deny', rule: name } })
    }
  }
  return grouped(items).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
}

async function general(settings) {
  const styles = await Promise.all(
    (await list('output-styles', false)).filter(name => name.endsWith('.md')).map(async name => frontmatter((await readText(at('output-styles', name))) ?? '').name ?? name.slice(0, -3)),
  )
  const get = keys => keys.reduce((value, key) => value?.[key], settings)
  let order = 0
  const row = (group, title, description, keys, control, extra = {}) => ({ group, title, description, order: order++, value: get(keys), control, ...extra, act: { type: 'setting', key: keys, ...extra.act } })
  const options = (...values) => values.map(value => (Array.isArray(value) ? { value: value[0], label: value[1] } : { value, label: value }))
  return grouped([
    row('Model', 'Model', 'The model that new sessions use.', ['model'], 'select', { options: options(['', 'Default'], 'opus', 'sonnet', 'haiku', 'fable', 'opusplan') }),
    row('Model', 'Effort', 'How hard Claude thinks before it answers.', ['effortLevel'], 'segmented', { options: options(['', 'Default'], 'low', 'medium', 'high', 'xhigh', 'max') }),
    row('Model', 'Thinking', 'Turn on extended thinking by default.', ['alwaysThinkingEnabled'], 'switch'),
    row('Model', 'Fast mode', 'Use faster output where the model offers it.', ['fastMode'], 'switch'),
    row('Model', 'Output style', 'How Claude structures its answers.', ['outputStyle'], 'select', { options: options(['', 'Default'], 'Explanatory', 'Learning', ...styles) }),
    row('Model', 'Language', 'The language that Claude answers in.', ['language'], 'text'),
    row('Permissions', 'Default permission mode', 'How Claude asks before it acts.', ['permissions', 'defaultMode'], 'select', {
      options: options(['', 'Default'], 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'),
    }),
    row('Behavior', 'Respect .gitignore', 'Leave ignored files out of file pickers and searches.', ['respectGitignore'], 'switch'),
    row('Behavior', 'Git instructions', 'Add the built-in commit and pull request instructions to the system prompt.', ['includeGitInstructions'], 'switch'),
    row('Behavior', 'Prompt suggestions', 'Suggest a next prompt after Claude replies.', ['promptSuggestionEnabled'], 'switch'),
    row('Behavior', 'Spinner tips', 'Show tips beside the spinner while Claude works.', ['spinnerTipsEnabled'], 'switch'),
    row('Behavior', 'Auto-compact window', 'Tokens of context before Claude compacts the conversation.', ['autoCompactWindow'], 'text', { act: { number: true } }),
    row('Behavior', 'Keep transcripts for', 'Days before old sessions are deleted.', ['cleanupPeriodDays'], 'text', { act: { number: true } }),
    row('Sync', 'Sync skills from Claude.ai', 'Load the skills that your Claude.ai account has.', ['syncClaudeAiSkills'], 'switch'),
    row('Sync', 'Sync plugins from Claude.ai', 'Load the plugins that your Claude.ai account has.', ['syncClaudeAiPlugins'], 'switch'),
  ], ['Model', 'Permissions', 'Behavior', 'Sync'])
}

/** Parts of a variable name, between underscores, that mark its value as secret. The window hides it until you click the eye button. */
const SECRET_PARTS = new Set(['KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PWD', 'AUTH', 'CREDENTIAL', 'CREDENTIALS', 'PAT', 'PRIVATE', 'COOKIE'])
const isSecret = name => name.toUpperCase().split('_').some(part => SECRET_PARTS.has(part)) || /(KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)

function env(settings) {
  const items = Object.entries(settings.env ?? {}).map(([name, value]) => ({
    title: name,
    group: 'Variables',
    value: typeof value === 'string' ? value : JSON.stringify(value),
    control: 'env',
    isSecret: isSecret(name),
    act: { type: 'env', name },
  }))
  return grouped(items)
}

async function model() {
  const [settings, catalog, defaults] = await Promise.all([
    readJson(at('settings.json'), {}),
    readJson(at(DIRS.data, FILES.catalog), {}),
    readJson(at(DIRS.data, FILES.defaults), {}),
  ])
  const section = async (id, title, folder, note, groups, empty) => ({ id, title, folder, note, empty, groups: await groups })
  return Promise.all([
    section('skills', 'Skills', DIRS.skills, 'Turned-off skills move to skills/disabled. Changes reach Claude in new sessions.', skills(catalog)),
    section('prompts', 'System prompt', DIRS.prompts, 'Each section is a file in prompts. Edit a section to change what Claude reads.', prompts(catalog, defaults)),
    section('agents', 'Subagents', DIRS.agents, 'Subagent types that Claude can start.', agents(catalog)),
    section('commands', 'Commands', DIRS.commands, 'Turned-off commands are hidden and refused.', commands(catalog)),
    section('tools', 'Tools', '', 'Turning a tool off adds it to permissions.deny in settings.json.', tools(catalog, settings)),
    section('mcp', 'MCP', '', 'Turning a server or tool off adds it to permissions.deny in settings.json.', mcp(catalog, settings), 'No session has seen an MCP server yet.'),
    section('plugins', 'Plugins', 'plugins', 'Plugins and mods load in new sessions, or after /reload-plugins.', plugins(settings)),
    section('hooks', 'Hooks', DIRS.hooks, 'Turned-off settings hooks move to hooks/disabled.', hooks(settings)),
    section('general', 'General', '', 'Settings from settings.json.', general(settings)),
    section('env', 'Environment', '', 'Variables from env in settings.json. Claude Code sets them in new sessions.', env(settings), 'No variables are set.'),
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
  await writeJson(historyFile, history)
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
    await writeJson(historyFile, history)
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
  await writeJson(historyFile, history)
}

const move = async (from, to) => {
  if (existsSync(to)) throw new Error(`${to} already exists`)
  await fs.mkdir(to.replace(/\/[^/]*$/, ''), { recursive: true })
  await fs.rename(from, to)
}

/** Writes a file and saves its old text in `change` first. */
async function write(change, path, text) {
  await change.track(path)
  await fs.mkdir(path.replace(/\/[^/]*$/, ''), { recursive: true })
  await fs.writeFile(path, text)
}

/** Reads settings.json, applies `edit` and writes it back. A file with a JSON error is left as it is. */
async function editSettings(change, edit) {
  const file = at('settings.json')
  const text = await readText(file)
  let settings = {}
  if (text !== undefined && text.trim()) {
    try {
      settings = JSON.parse(text)
    } catch (error) {
      throw new Error(`settings.json has a JSON error, so Settings Manager did not change it. Fix the file first.\n${error.message}`)
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json does not hold a JSON object, so Settings Manager did not change it.')
  edit(settings)
  await write(change, file, JSON.stringify(settings, null, 2) + '\n')
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Each action changes files on disk. `change` collects what it changes, so the change can be undone. */
const ACTIONS = {
  async move({ dir, name }, isOn, change) {
    const [on, off] = [inside(dir, name), inside(dir, DISABLED, name)]
    const [from, to] = isOn ? [off, on] : [on, off]
    await move(from, to)
    change.moves.push({ from, to })
  },
  async marker({ dir, name }, isOn, change) {
    const path = inside(dir, DISABLED, `${fileName(name)}.json`)
    await change.track(path)
    await (isOn ? fs.rm(path, { force: true }) : writeJson(path, { name }))
  },
  async setting({ key, invert, number }, value, change) {
    const next = invert ? !value : number && value !== '' ? Number(value) : value
    await editSettings(change, settings => {
      const parent = key.slice(0, -1).reduce((node, part) => (node[part] ??= {}), settings)
      if (next === '' || next === null || Number.isNaN(next)) delete parent[key.at(-1)]
      else parent[key.at(-1)] = next
    })
  },
  async deny({ rule }, isOn, change) {
    await editSettings(change, settings => {
      const deny = ((settings.permissions ??= {}).deny ??= []).filter(item => item !== rule)
      settings.permissions.deny = isOn ? deny : [...deny, rule]
    })
  },
  /** Sets a variable in `env`. A null value deletes it. `isNew` refuses a name that is already there. */
  async env({ name, isNew }, value, change) {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) throw new Error('A variable name uses only letters, digits and _, and it does not start with a digit.')
    await editSettings(change, settings => {
      const vars = (settings.env ??= {})
      if (isNew && name in vars) throw new Error(`${name} is already set.`)
      if (value === null) delete vars[name]
      else vars[name] = String(value)
      if (!Object.keys(vars).length) delete settings.env
    })
  },
  async hook({ event, id }, isOn, change) {
    const saved = inside(DIRS.hooks, DISABLED, `${id}.json`)
    await change.track(saved)
    if (isOn) {
      const { group } = (await readJson(saved, undefined)) ?? {}
      if (!group || typeof group !== 'object') throw new Error('This hook is no longer saved in hooks/disabled. Reload the window.')
      await editSettings(change, settings => ((settings.hooks ??= {})[event] ??= []).push(group))
      return fs.rm(saved)
    }
    let group
    await editSettings(change, settings => {
      const groups = settings.hooks?.[event] ?? []
      group = groups.find(item => hash([event, item]) === id)
      if (!group) throw new Error('This hook is no longer in settings.json. Reload the window.')
      settings.hooks[event] = groups.filter(item => item !== group)
      if (!settings.hooks[event].length) delete settings.hooks[event]
    })
    await writeJson(saved, { event, group })
  },
  async edit({ path, text }, _value, change) {
    await write(change, inside(path), text)
  },
  async reset({ path, key }, _value, change) {
    const target = inside(path)
    const defaults = await readJson(at(DIRS.data, FILES.defaults), {})
    if (defaults[key] === undefined) throw new Error(`No original text is saved for ${key} yet.`)
    await write(change, target, defaults[key])
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
  const token = randomBytes(16).toString('hex')
  const page = await fs.readFile(new URL('index.html', DIST), 'utf8')
  let lastSeen = Date.now()
  let tray
  const send = (res, status, body, type = 'text/plain; charset=utf-8') => res.writeHead(status, { 'content-type': type }).end(body)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (isAsset(url.pathname)) {
      const body = await fs.readFile(new URL(`.${url.pathname}`, DIST)).catch(() => undefined)
      return body ? send(res, 200, body, TYPES[url.pathname.split('.').pop()]) : send(res, 404, 'Not found')
    }
    if (url.searchParams.get('t') !== token && req.headers['x-token'] !== token) return send(res, 403, 'Forbidden')
    lastSeen = Date.now()
    try {
      if (url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8')
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
      if (url.pathname.startsWith('/api/')) return send(res, 200, JSON.stringify({ root, sections: await model(), undo: history.at(-1)?.label }), 'application/json')
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

await (mode === '--serve' ? serve() : launch(mode !== '--tray'))
