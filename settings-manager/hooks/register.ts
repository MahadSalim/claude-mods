import type { EngineInterface as $, Register } from 'claude-code'
import { DIRS, DISABLED_KINDS, FILES, SAVED_REMINDERS, fileName, frontmatter, join, parseDisabled } from '../app/shared.mjs'

type Entry = { description?: string; source?: string; scope?: string; order?: number; mcp?: boolean; plugin?: string; seenAt?: string }
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

/** Commands that can never be turned off, so the person can always manage plugins and this mod. */
const PROTECTED = new Set(['plugin', 'reload-plugins', 'exit', 'help', 'login', COMMAND])

/**
 * One spelling for a command name: an MCP prompt listed as `server:prompt (MCP)` is typed as
 * `/mcp__server__prompt`, and a leading slash is dropped.
 */
const commandKey = (name: string) => name.replace(/^\//, '').replace(/^(.+?):(.+) \(MCP\)$/, (_, server: string, prompt: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${prompt}`)

/** True for a skill or command that is turned off, by any of its names. */
function isOff(name: string) {
  const key = commandKey(name)
  if (PROTECTED.has(key)) return false
  for (const set of [off.commands, off.skills]) for (const item of set) if (commandKey(item) === key) return true
  return false
}

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

/** Your own skills: each folder in `skills` that holds a SKILL.md, with its frontmatter `name` or the folder name. */
async function yourSkills($: $) {
  const folders = (await entries($, DIRS.skills)).filter(item => item.kind === 'dir')
  const found = await Promise.all(
    folders.map(async ({ name: folder }) => {
      const text = await $.fs.read(at(DIRS.skills, folder, 'SKILL.md')).catch(() => undefined)
      return text === undefined ? undefined : { name: frontmatter(text).name ?? folder, folder }
    }),
  )
  return found.filter(skill => skill !== undefined)
}

/** What was turned off at the last refresh, to see when the `/` menu must be drawn again. */
let lastOff = ''

/** Reads what is turned off from `disabled.json`, the edit records and your skill names. */
async function refresh($: $) {
  const [skills, disabledText, editsRead] = await Promise.all([
    yourSkills($),
    $.fs.read(at(DIRS.data, FILES.disabled)).catch(() => undefined),
    readJson($, at(DIRS.data, FILES.edits), {}),
  ])
  const disabled = parseDisabled(disabledText)
  edits = editsRead
  known.skills = new Set(skills.map(skill => skill.name))
  for (const kind of DISABLED_KINDS) off[kind] = new Set(disabled[kind])
  // The folder name of a skill also invokes it, so a turned-off skill is off by that name too.
  for (const skill of skills) if (off.skills.has(skill.name)) off.skills.add(skill.folder)
  const now = [...off.skills, '|', ...off.commands].join('\n')
  if (now !== lastOff) {
    // Claude Code keeps each command's menu entry for the session, so a change has it ask again.
    if (lastOff) $.ui.invalidate('command.describe')
    lastOff = now
  }
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
  // The day each tool was last seen, so the window can leave out tools that Claude Code no longer has.
  const seenAt = new Date().toISOString().slice(0, 10)
  for (const t of tools) {
    note($, 'tools', t.name, { description: brief(t.description), mcp: t.mcp, seenAt })
    if (t.mcp) wantSummary($, `tools/${t.name}`, t.description)
  }
}

type Summary = { hash: string; text: string }
let summaries: Record<string, Summary> = {}
/** Items that need a new summary, by key, with the text to summarize. */
const toSummarize = new Map<string, { text: string; hash: string }>()
let isSummaryPending = false
/** How many items one model call summarizes. */
const SUMMARY_BATCH = 40

/** A short hash (FNV-1a) of a text, so a summary is written again only when its text changes. */
function hashOf(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/**
 * Asks for a one-sentence summary of an item, which the window shows under its name. Only system prompt
 * sections, Claude Code's own reminders and MCP tools are summarized; never the person's words or file contents.
 *
 * Each item is summarized once: many sections and reminders carry details that change each turn, such as the
 * date. Text that the person edited in the window (`isEdited`) is summarized again when it changes.
 */
function wantSummary($: $, key: string, text: string, isEdited = false) {
  const hash = hashOf(text)
  const saved = summaries[key]
  if (!text.trim() || (saved && (!isEdited || saved.hash === hash)) || toSummarize.has(key)) return
  toSummarize.set(key, { text: text.slice(0, 2000), hash })
  if (isSummaryPending) return
  isSummaryPending = true
  $.clock.after(10000, () => void summarize($))
}

const SUMMARY_PROMPT = [
  'Each item below is a part of the system prompt, a system reminder, or a tool description that Claude Code gives to Claude.',
  'For each item, write one plain sentence of at most 15 words that says what the item is for, so a person can skim a settings list.',
  'Describe the kind of item, not one-off details such as file names, dates or numbers. Use simple words.',
  'Reply with only a JSON object that maps each item id to its sentence.',
].join(' ')

/** Writes the summaries that are due, one model call per batch, and merges them into the summaries file. */
async function summarize($: $) {
  const path = at(DIRS.data, FILES.summaries)
  try {
    // Another session may have written some of them already.
    summaries = { ...summaries, ...(await readJson<Record<string, Summary>>($, path, {})) }
    for (const [key, item] of toSummarize) if (summaries[key]?.hash === item.hash) toSummarize.delete(key)
    const batch = [...toSummarize].slice(0, SUMMARY_BATCH)
    if (!batch.length) return
    const items = batch.map(([key, item]) => `<item id="${key}">\n${item.text}\n</item>`).join('\n')
    const reply = await $.model.complete({ model: 'haiku', prompt: `${SUMMARY_PROMPT}\n\n${items}`, maxTokens: 4000, effort: 'low', timeoutMs: 120000 })
    // A failed call leaves the items for the next session.
    if (!reply.isAnswered) return toSummarize.clear()
    const json = /\{[\s\S]*\}/.exec(reply.text)?.[0] ?? '{}'
    const answers = JSON.parse(json) as Record<string, unknown>
    for (const [key, item] of batch) {
      toSummarize.delete(key)
      const text = answers[key]
      if (typeof text === 'string' && text.trim()) summaries[key] = { hash: item.hash, text: text.trim().slice(0, 200) }
    }
    const disk = await readJson<Record<string, Summary>>($, path, {})
    await $.fs.write(path, JSON.stringify({ ...disk, ...summaries }, null, 2))
  } catch {
    toSummarize.clear()
  } finally {
    isSummaryPending = false
    if (toSummarize.size) {
      isSummaryPending = true
      $.clock.after(1000, () => void summarize($))
    }
  }
}

async function skillSource($: $, name: string) {
  if (known.skills.has(name)) return 'userSettings'
  // Older versions called a skill yours when it had a skill.json folder, so that source is worked out again.
  const seen = catalog.skills[name]?.source
  if (seen && seen !== 'userSettings') return seen
  if (name.includes(':')) return name.startsWith('anthropic-skills:') ? 'syncedSkills' : 'plugin'
  return (await $.fs.exists(join('.claude', 'skills', name, 'SKILL.md'))) ? 'projectSettings' : 'built-in'
}

/**
 * Drops the entries of turned-off skills and commands from the skill listing and returns the entries it saw.
 * An entry starts with `- name:`, where a name is lowercase letters, digits, `-`, `_` and `.`, with `plugin:` parts;
 * other lines, such as a bullet inside a description, belong to the entry above them.
 */
function filterListing(text: string) {
  const kept: string[] = []
  const seen: { name: string; description: string }[] = []
  let isSkipping = false
  for (const line of text.split('\n')) {
    const entry = /^- ([a-z0-9][\w.-]*(?::[\w.-]+)*)(?::\s|:?$)/.exec(line)
    if (entry) {
      isSkipping = isOff(entry[1])
      seen.push({ name: entry[1], description: line.slice(entry[0].length).trim() })
    }
    if (!isSkipping) kept.push(line)
  }
  // With every entry off, the listing's heading alone is left out too.
  const isAllOff = seen.length > 0 && seen.every(entry => isOff(entry.name))
  return { text: isAllOff ? null : kept.join('\n'), seen }
}

/** Notes each skill in the listing in the catalog, where the window finds it. */
async function noteSkills($: $, seen: { name: string; description: string }[]) {
  for (const { name, description } of seen) note($, 'skills', name, { description: brief(description), source: await skillSource($, name) })
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
  if (saved === live) return live
  // The window may have saved an edit since this session last read the records: read them again before
  // writing over the file, so a running session never overwrites a new edit.
  if (saved !== undefined) {
    edits = await readJson($, at(DIRS.data, FILES.edits), {})
    if (Object.hasOwn(edits, key)) return saved
  }
  await $.fs.write(path, live)
  return live
}

/**
 * Attachments that carry the person's own words, or messages delivered into a running turn: the mod passes them
 * on as they are, and never saves, edits or drops them.
 */
const PERSONS_WORDS = new Set(['queued_command', 'poll_events', 'teammate_mailbox', 'agent_mention', 'peer_mention', 'projects_thread_ask'])

/**
 * Whether a context count is waiting or running: `again` when another turn ended meanwhile, so one
 * more count follows. Only one count runs at a time, because each one sends token-count requests.
 */
let measuring: 'idle' | 'busy' | 'again' = 'idle'

/**
 * The length of each system prompt section and each built-in tool's description in the last request, by name.
 * Claude Code counts only each category's total, so the Home tab splits a total by these lengths.
 */
let sectionChars: { name: string; chars: number }[] = []

/** Each system prompt section's state for this session, decided at its first use: off, or its edited text. */
const sectionState = new Map<string, { isOff: boolean; edited?: string }>()
const toolChars = new Map<string, { chars: number; isDeferred: boolean }>()

function scheduleMeasure($: $) {
  if (measuring !== 'idle') {
    measuring = 'again'
    return
  }
  measuring = 'busy'
  $.clock.after(2000, () => void measure($))
}

/**
 * Counts the session's context as /context does, with the token-count API, and writes it to the
 * session's file in `DIRS.context`, where the Home tab reads it. The grid is left out.
 */
async function measure($: $) {
  try {
    const [id, cwd, usage] = await Promise.all([$.session.id(), $.session.cwd(), $.session.usage({ breakdown: 'full' })])
    const b = usage.context.breakdown
    if (b) {
      const file = {
        id,
        cwd,
        savedAt: new Date().toISOString(),
        startedAt: new Date(usage.startedAt).toISOString(),
        model: b.model,
        totalTokens: b.totalTokens,
        maxTokens: b.rawMaxTokens,
        autoCompactThreshold: b.autoCompactThreshold,
        categories: b.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
        mcpTools: b.mcpTools.map(({ name, serverName, tokens, isLoaded }) => ({ name, serverName, tokens, isLoaded })),
        skills: (b.skills?.skillFrontmatter ?? []).map(({ name, source, pluginName, tokens }) => ({ name, source, pluginName, tokens })),
        agents: b.agents.map(({ agentType, source, tokens }) => ({ name: agentType, source, tokens })),
        memoryFiles: b.memoryFiles.map(({ path, type, tokens }) => ({ path, type, tokens })),
        commands: b.slashCommands && { count: b.slashCommands.includedCommands, tokens: b.slashCommands.tokens },
        sections: sectionChars,
        tools: [...toolChars].map(([name, tool]) => ({ name, ...tool })),
      }
      // Claude Code's own word for where each listed skill comes from beats the mod's guess.
      for (const skill of b.skills?.skillFrontmatter ?? []) note($, 'skills', skill.name, { source: skill.source, plugin: skill.pluginName })
      await $.fs.write(at(DIRS.context, `${fileName(id)}.json`), JSON.stringify(file))
    }
  } catch {
    // A count that fails leaves the last file as it was.
  }
  const isAgain = measuring === 'again'
  measuring = 'idle'
  if (isAgain) scheduleMeasure($)
}

/**
 * Saves the names of the Claude.ai connectors, whose tool names carry an id in place of a name. Only the desktop
 * app has the `ccd_connectors` server that lists them; elsewhere the call fails and nothing changes.
 */
async function noteConnectors($: $) {
  try {
    const result = await $.mcp.call('ccd_connectors', 'session_connectors_status')
    const text = result.content.map(block => ('text' in block ? block.text : '')).join('')
    const servers = (JSON.parse(text) as { servers?: { id?: string; name?: string; kind?: string }[] }).servers ?? []
    const found = Object.fromEntries(servers.filter(s => s.kind === 'connector' && s.id && s.name).map(s => [s.id, s.name]))
    if (!Object.keys(found).length) return
    const path = at(DIRS.data, FILES.connectors)
    const saved = await readJson<Record<string, string>>($, path, {})
    if (Object.entries(found).every(([id, name]) => saved[id] === name)) return
    await $.fs.write(path, JSON.stringify({ ...saved, ...found }, null, 2))
  } catch {
    // Not the desktop app, or its server is not connected yet.
  }
}

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
    summaries = await readJson($, at(DIRS.data, FILES.summaries), {})
    sectionState.clear()
    await refresh($)
    await scan($)
    await $.command.register({ name: COMMAND, description: 'Open the Settings Manager window', immediate: true })
    const started = await next(e)
    // Starts the tray icon if it is not running yet; the session does not wait for it.
    void $.process.run(['node', appScript($), root, '--tray'], { timeoutMs: 20000 }).catch(() => {})
    scheduleMeasure($)
    return started
  })

  // After each turn, the Home tab's numbers for this session are counted again.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      scheduleMeasure($)
      void noteConnectors($)
    }
    return next(e)
  })

  // MCP servers connect and plugins reload after the session starts, so each turn looks at the tools and commands again.
  on('turn.start', async ($, e, next) => {
    await refresh($)
    await scan($)
    return next(e)
  })

  // Each section's state is decided once per session: whether it is off, and its edited text. A change in the window
  // then reaches new sessions, and a running session's prompt stays the same, so Claude Code's prompt cache holds.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const sections = []
    let isAfterEdit = false
    for (const [order, section] of result.sections.entries()) {
      note($, 'sections', section.id, { scope: section.scope, order })
      const file = fileName(section.id)
      const live = unixLines(section.text)
      let state = sectionState.get(section.id)
      if (!state) {
        const isOff = off.sections.has(section.id)
        const text = isOff ? live : await promptText($, file, DIRS.prompts, live)
        state = { isOff, edited: !isOff && Object.hasOwn(edits, file) ? text : undefined }
        sectionState.set(section.id, state)
      }
      if (state.isOff) continue
      const text = state.edited ?? live
      wantSummary($, `sections/${section.id}`, text, state.edited !== undefined)
      // Shared text must read the same for every session, so an edited section and every one after it are sent as
      // this session's own, which keeps shared sections ahead of session ones.
      if (state.edited !== undefined) isAfterEdit = true
      sections.push({ ...section, text, scope: isAfterEdit ? ('session' as const) : section.scope })
    }
    // Side requests, such as the mod's own Haiku summaries, offer no tools and send one short section. The desktop
    // app's own prompt is also `lean`, so the traits do not tell them apart.
    if (e.tools.length) sectionChars = sections.map(section => ({ name: section.id, chars: section.text.length }))
    return { sections }
  })

  // Notes each built-in tool's description length for the Home tab, and changes nothing.
  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    if (!e.tool.startsWith('mcp__')) toolChars.set(e.tool, { chars: e.tool.length + result.description.length, isDeferred: Boolean(result.isDeferred ?? e.isDeferred) })
    return result
  })

  on('prompt.attachment', async ($, e, next) => {
    if (e.type === 'skill_listing') {
      const result = await next(e)
      if (result.text === null) return result
      const { text, seen } = filterListing(result.text)
      await noteSkills($, seen)
      return { text: text ?? null }
    }
    // The person's words always pass as they are. Other text can be turned off, but only Claude Code's own fixed
    // prose (SAVED_REMINDERS) is saved and can be edited. Every other reminder can hold private data, so its text is
    // never written anywhere: the catalog notes only its type.
    if (PERSONS_WORDS.has(e.type)) return next(e)
    if (off.reminders.has(e.type)) return { text: null }
    const result = await next(e)
    if (result.text === null || e.origin?.kind !== 'engine') return result
    if (!SAVED_REMINDERS.has(e.type)) {
      note($, 'reminders', e.type, {})
      return result
    }
    note($, 'reminders', e.type, { description: brief(result.text) })
    const file = fileName(e.type)
    const text = await promptText($, `${DIRS.reminders}/${file}`, DIRS.reminders, unixLines(result.text))
    wantSummary($, `reminders/${e.type}`, text, Object.hasOwn(edits, `${DIRS.reminders}/${file}`))
    return { text }
  })

  // This event also fires for skills that a subagent loads up front, which no tool call or command shows, so a
  // turned-off skill's text is replaced there. Commands from `.md` files fire it too, so only known skills are noted.
  on('skill.prompt', async ($, e, next) => {
    if (catalog.skills[e.skill] || known.skills.has(e.skill)) note($, 'skills', e.skill, { source: e.source, plugin: e.pluginName })
    if (isOff(e.skill)) return { text: `The skill "${e.skill}" is turned off in Settings Manager. Do not act on it; tell the user that it is turned off.` }
    return next(e)
  })

  // The Skill tool runs skills and also slash commands, so both are checked. A guard that fails refuses the call.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const skill = String((e as { skill?: string }).skill ?? '').replace(/^\//, '')
    return isOff(skill) ? { deny: `"${skill}" is turned off in Settings Manager.` } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'Settings Manager could not check this skill.' }))

  // A turned-off subagent leaves the listing and is refused when called. A guard that fails refuses it.
  on('agent.offer', async ($, e, next) => {
    const isOn = !off.agents.has(e.agent)
    note($, 'agents', e.agent, { description: brief(e.description), source: e.source })
    return isOn ? next(e) : { isOffered: false }
  }).catch(($, e, next) => (next.called ? next(e) : { isOffered: !off.agents.has(e.agent) }))

  // A workflow script or a resumed subagent may start a subagent without offering it, so that is refused too.
  on('agent.spawn', async ($, e, next) =>
    off.agents.has(e.subagentType) ? { deny: `The subagent "${e.subagentType}" is turned off in Settings Manager.` } : next(e),
  )

  on('command.describe', async ($, e, next) => {
    note($, 'commands', e.command, { description: brief(e.description) })
    return isOff(e.command) ? { ...(await next(e)), isHidden: true } : next(e)
  })

  on('command.run', { command: COMMAND }, async $ => open($))

  // The window may have turned a command off since the last turn started, so the list is read again first.
  on('command.run', async ($, e, next) => {
    await refresh($)
    return isOff(e.command) ? { text: `/${e.command} is turned off in Settings Manager.` } : next(e)
  })
}
