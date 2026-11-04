// Entry point: `node main.mjs <config folder>` opens the window; `--serve` runs the window's server.
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
  const items = Object.entries(catalog.tools ?? {}).map(([name, entry]) => ({
    title: entry.mcp ? name.split('__').slice(2).join('__') || name : name,
    description: entry.description ?? '',
    group: entry.mcp ? `MCP: ${name.split('__')[1] ?? 'other'}` : 'Built-in tools',
    value: !deny.includes(name),
    act: { type: 'deny', rule: name },
  }))
  return grouped(items, ['Built-in tools'])
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

async function model() {
  const [settings, catalog, defaults] = await Promise.all([
    readJson(at('settings.json'), {}),
    readJson(at(DIRS.data, FILES.catalog), {}),
    readJson(at(DIRS.data, FILES.defaults), {}),
  ])
  const section = async (id, title, folder, note, groups) => ({ id, title, folder, note, groups: await groups })
  return Promise.all([
    section('skills', 'Skills', DIRS.skills, 'Turned-off skills move to skills/disabled. Changes reach Claude in new sessions.', skills(catalog)),
    section('prompts', 'System prompt', DIRS.prompts, 'Each section is a file in prompts. Edit a section to change what Claude reads.', prompts(catalog, defaults)),
    section('agents', 'Subagents', DIRS.agents, 'Subagent types that Claude can start.', agents(catalog)),
    section('commands', 'Commands', DIRS.commands, 'Turned-off commands are hidden and refused.', commands(catalog)),
    section('tools', 'Tools', '', 'Turning a tool off adds it to permissions.deny in settings.json.', tools(catalog, settings)),
    section('plugins', 'Plugins', 'plugins', 'Plugins and mods load in new sessions, or after /reload-plugins.', plugins(settings)),
    section('hooks', 'Hooks', DIRS.hooks, 'Turned-off settings hooks move to hooks/disabled.', hooks(settings)),
    section('general', 'General', '', 'Settings from settings.json.', general(settings)),
  ])
}

const move = async (from, to) => {
  if (existsSync(to)) throw new Error(`${to} already exists`)
  await fs.mkdir(to.replace(/\/[^/]*$/, ''), { recursive: true })
  await fs.rename(from, to)
}

/** Reads settings.json, applies `change` and writes it back. A file with a JSON error is left as it is. */
async function editSettings(change) {
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
  change(settings)
  await writeJson(file, settings)
}

const ACTIONS = {
  async move({ dir, name }, isOn) {
    const [on, off] = [inside(dir, name), inside(dir, DISABLED, name)]
    await (isOn ? move(off, on) : move(on, off))
  },
  async marker({ dir, name }, isOn) {
    inside(dir, DISABLED, `${fileName(name)}.json`)
    await (isOn ? fs.rm(markerPath(dir, name), { force: true }) : writeJson(markerPath(dir, name), { name }))
  },
  async setting({ key, invert, number }, value) {
    const next = invert ? !value : number && value !== '' ? Number(value) : value
    await editSettings(settings => {
      const parent = key.slice(0, -1).reduce((node, part) => (node[part] ??= {}), settings)
      if (next === '' || next === null || Number.isNaN(next)) delete parent[key.at(-1)]
      else parent[key.at(-1)] = next
    })
  },
  async deny({ rule }, isOn) {
    await editSettings(settings => {
      const deny = ((settings.permissions ??= {}).deny ??= []).filter(item => item !== rule)
      settings.permissions.deny = isOn ? deny : [...deny, rule]
    })
  },
  async hook({ event, id }, isOn) {
    const saved = inside(DIRS.hooks, DISABLED, `${id}.json`)
    if (isOn) {
      const { group } = (await readJson(saved, undefined)) ?? {}
      if (!group || typeof group !== 'object') throw new Error('This hook is no longer saved in hooks/disabled. Reload the window.')
      await editSettings(settings => ((settings.hooks ??= {})[event] ??= []).push(group))
      return fs.rm(saved)
    }
    let group
    await editSettings(settings => {
      const groups = settings.hooks?.[event] ?? []
      group = groups.find(item => hash([event, item]) === id)
      if (!group) throw new Error('This hook is no longer in settings.json. Reload the window.')
      settings.hooks[event] = groups.filter(item => item !== group)
      if (!settings.hooks[event].length) delete settings.hooks[event]
    })
    await writeJson(saved, { event, group })
  },
  async edit({ path, text }) {
    await fs.writeFile(inside(path), text)
  },
  async reset({ path, key }) {
    const target = inside(path)
    const defaults = await readJson(at(DIRS.data, FILES.defaults), {})
    if (defaults[key] === undefined) throw new Error(`No original text is saved for ${key} yet.`)
    await fs.writeFile(target, defaults[key])
  },
  async reveal({ folder }) {
    const target = (folder ? inside(folder) : at()).replace(/\//g, process.platform === 'win32' ? '\\' : '/')
    await fs.mkdir(target, { recursive: true })
    openExternal(target)
  },
}

function detached(command, args) {
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref()
}

function openExternal(target) {
  if (process.platform === 'win32') detached('explorer.exe', [target])
  else detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [target])
}

/** Opens the page in a WebView2 window on Windows, else in a browser's app mode, which shows it as a window of its own. */
function openWindow(url) {
  if (process.platform === 'win32') {
    const [script, icon] = ['./window.ps1', './icon.ico'].map(file => fileURLToPath(new URL(file, import.meta.url)))
    return void spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, url, icon], { stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
  }
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

async function launch() {
  let info = await readJson(serverFile, undefined)
  if (!info || !(await isAlive(info))) {
    const child = spawn(process.execPath, [self, root, '--serve'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    for (let tries = 0; tries < 50 && info?.pid !== child.pid; tries++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      info = await readJson(serverFile, undefined)
    }
    if (info?.pid !== child.pid) throw new Error('The window server did not start.')
  }
  const res = await fetch(`http://127.0.0.1:${info.port}/api/open`, { headers: { 'x-token': info.token } })
  if (!res.ok) throw new Error(`The window server could not open the window: ${await res.text()}`)
}

/** Content types of the built UI files in `dist`, by extension. */
const TYPES = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' }
const DIST = new URL('./dist/', import.meta.url)
const isAsset = path => /^\/(assets\/)?[\w.-]+\.(js|css|svg|png|woff2)$/.test(path)

async function serve() {
  const token = randomBytes(16).toString('hex')
  const page = await fs.readFile(new URL('index.html', DIST), 'utf8')
  let lastSeen = Date.now()
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
      if (url.pathname === '/api/open') return openWindow(`http://127.0.0.1:${server.address().port}/?t=${token}`), send(res, 200, 'ok')
      if (req.method === 'POST' && url.pathname === '/api/act') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { act, value } = JSON.parse(body)
        await ACTIONS[act.type](act, value)
      }
      if (url.pathname.startsWith('/api/')) return send(res, 200, JSON.stringify({ root, sections: await model() }), 'application/json')
      send(res, 404, 'Not found')
    } catch (error) {
      send(res, 500, String(error?.message ?? error))
    }
  })
  server.listen(0, '127.0.0.1', () => writeJson(serverFile, { port: server.address().port, token, pid: process.pid }))
  setInterval(() => Date.now() - lastSeen > 60000 && process.exit(0), 5000)
}

await (mode === '--serve' ? serve() : launch())
