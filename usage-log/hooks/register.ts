import type { EngineInterface, PromptComposeSection, Register } from 'claude-code'

// Characters one log file holds before the next file starts.
const FILE_CHARS = 64_000
// The mod's folder, from the Claude config folder.
const HOME = 'usage-log'
// The dashboard's address.
const DASHBOARD = 'http://127.0.0.1:5198'
// The slash command that turns the dashboard on and off.
const COMMAND = 'usage-dashboard'
// A node script that starts the script named after it as a process of its own.
const DETACH = "require('child_process').spawn(process.execPath,[process.argv[1]],{detached:true,stdio:'ignore',windowsHide:true}).unref()"
// Characters of one item's text the catalog holds.
const TEXT_CHARS = 60_000
// Milliseconds the catalog keeps a session, and an item no session loaded again.
const SESSION_MS = 7 * 86_400_000
const ITEM_MS = 30 * 86_400_000
const BYTES_PER_TOKEN = 4
// Files the Read tool does not return as text.
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/i
// The catalog id of the skill listing.
const LISTING = 'k:listing'
// Events whose answers the engine caches.
const CACHED = ['tool.describe', 'prompt.section', 'prompt.attachment'] as const
const NO_RULES: Rules = { rules: {}, order: null, cap: { on: false, k: 10, part: true } }

type Log = { id: string; path: string; text: string; written: number }
type Rule = { a: 'defer' | 'drop' | 'rewrite'; text?: string }
type Rules = { rules: Record<string, Rule>; order: string[] | null; cap: { on: boolean; k: number; part: boolean } }
type Item = { kind: 'tools' | 'skills' | 'blocks' | 'sections'; name: string; text: string; chars: number; deferred?: boolean; scope?: string; pos?: number; tok?: number }
type Catalog = { sessions?: Record<string, { at: number }>; items?: Record<string, Item & { at: number }> }
type ReadCall = { readonly file_path: string; readonly offset?: number; readonly limit?: number; readonly agentId?: string }

/** The plan windows, context fill and engine cost at this moment. */
const usage = ($: EngineInterface) => $.session.usage().catch(() => undefined)

/** The Claude config folder: CLAUDE_CONFIG_DIR, or .claude under the home folder. */
const configDir = async ($: EngineInterface) =>
  (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))}/.claude`

/** Whether the dashboard's server answers. */
const isUp = ($: EngineInterface) => $.http.fetch(DASHBOARD).then(response => response.ok, () => false)

/** Starts the dashboard's server; resolves whether it was started. */
const start = ($: EngineInterface) =>
  $.process.run(['node', '-e', DETACH, `${$.plugin.root}/dashboard/server.mjs`]).then(ran => ran.exitCode === 0, () => false)

/** Whether the dashboard starts with a session. */
const isAuto = async ($: EngineInterface) => (await $.store.get('auto')) !== false

/** The rules a rules file's text holds; none when it holds no JSON. */
const parse = (text: string): Rules => {
  try {
    const held = JSON.parse(text)

    return { rules: held.rules ?? {}, order: held.order ?? null, cap: { ...NO_RULES.cap, ...held.cap } }
  } catch {
    return NO_RULES
  }
}

let config: Promise<string> | undefined
let log: Log | undefined
let files = 0
let writing = Promise.resolve()
let rules = NO_RULES
let rulesText = ''
// Items this process loaded, by catalog id.
let catalog: Record<string, Item> = {}
let isDirty = false
let flushed: string | undefined
// Settings hook runs by event, and injected blocks by type, since the last turn end logged.
let hooks: Record<string, { n: number; ms: number; blocked: number }> = {}
let blocks: Record<string, number> = {}

/** Adds one row to the session's log file. */
const record = async ($: EngineInterface, ev: string, fields: object) => {
  const [id, at, root] = await Promise.all([$.session.id(), $.clock.now(), (config ??= configDir($))])

  if (log?.id !== id || log.text.length > FILE_CHARS) {
    log = { id, path: `${root}/${HOME}/events/${id}.${at}-${files++}.jsonl`, text: '', written: 0 }
  }

  const file = log
  file.text += `${JSON.stringify({ at, ev, ...fields })}\n`
  writing = writing
    .then(async () => {
      const { text } = file

      if (file.written < text.length) {
        await $.fs.write(file.path, text)
        file.written = text.length
      }
    })
    .catch(() => {})

  return writing
}

/** The counts gathered since the last call, emptied. */
const drain = () => {
  const counted = { hooks, blocks }
  hooks = {}
  blocks = {}

  return counted
}

/** Reads the rules file; on a change, clears the answers the engine cached. */
const loadRules = async ($: EngineInterface) => {
  const text = await $.fs.read(`${await (config ??= configDir($))}/${HOME}/rules.json`).catch(() => '')

  if (text === rulesText) {
    return
  }

  rulesText = text
  rules = parse(text)
  await Promise.all(CACHED.map(event => $.ui.invalidate(event))).catch(() => {})
}

/** Holds one loaded item in the catalog. */
const note = (id: string, item: Omit<Item, 'chars'>) => {
  const text = item.text.slice(0, TEXT_CHARS)
  isDirty ||= catalog[id]?.text !== text
  catalog[id] = { ...catalog[id], ...item, text, chars: item.text.length }
}

/** Merges this process's items into the catalog file, once per session id and after an item changed. */
const flush = async ($: EngineInterface) => {
  const [id, at, root] = await Promise.all([$.session.id(), $.clock.now(), (config ??= configDir($))])

  if (!isDirty && flushed === id) {
    return
  }

  isDirty = false
  flushed = id
  const measured = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)

  for (const { name, tokens } of measured?.context.breakdown?.mcpTools ?? []) {
    const item = catalog[`t:${name}`]

    if (item) {
      item.tok = tokens
    }
  }

  const path = `${root}/${HOME}/context.json`
  const held: Catalog = await $.fs.read(path).then(JSON.parse).catch(() => ({}))
  const fresh = <T extends { at: number }>(rows: Record<string, T> = {}, ms: number) =>
    Object.fromEntries(Object.entries(rows).filter(([, row]) => at - row.at < ms))
  const mine = Object.fromEntries(Object.entries(catalog).map(([key, item]) => [key, { ...item, at }]))
  const merged: Catalog = { sessions: { ...fresh(held.sessions, SESSION_MS), [id]: { at } }, items: { ...fresh(held.items, ITEM_MS), ...mine } }
  await $.fs.write(path, JSON.stringify(merged)).catch(() => {})
}

/** The system prompt's sections under the rules: dropped, rewritten and reordered, every shared one first. */
const arrange = (sections: readonly PromptComposeSection[]) => {
  const rank = (id: string) => rules.order?.indexOf(id) ?? -1
  const kept = sections
    .filter(section => rules.rules[`s:${section.id}`]?.a !== 'drop')
    .map((section, at) => ({ ...section, text: rules.rules[`s:${section.id}`]?.text ?? section.text, at }))
  const side = (section: PromptComposeSection) => (section.scope === 'shared' ? 0 : 1)
  const placed = (section: PromptComposeSection & { at: number }) => (rank(section.id) < 0 ? kept.length + section.at : rank(section.id))

  return kept.sort((a, b) => side(a) - side(b) || (rules.order ? placed(a) - placed(b) : 0) || a.at - b.at).map(({ at, ...section }) => section)
}

/** The refusal of a Read over the cap, or undefined when the read may run. */
const overCap = async ($: EngineInterface, e: ReadCall) => {
  const { on, k, part } = rules.cap

  if (!on || e.agentId !== undefined || NOT_TEXT.test(e.file_path)) {
    return undefined
  }

  const isSlice = part && e.limit !== undefined
  const from = Math.max(0, (e.offset ?? 1) - 1)
  const bytes = await (isSlice
    ? $.fs.read(e.file_path).then(text => text.split('\n').slice(from, from + (e.limit ?? 0)).join('\n').length)
    : $.fs.stat(e.file_path).then(stat => stat.size)
  ).catch(() => 0)
  const tokens = Math.round(bytes / BYTES_PER_TOKEN / 1000)

  return tokens > k
    ? `${$.plugin.name}: ${e.file_path} is about ${tokens}K tokens${isSlice ? ' in that slice' : ''}. The cap is ${k}K a read.${part ? ' Read a slice under the cap with offset and limit.' : ''}`
    : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadRules($)
    const [model, { version }] = await Promise.all([$.session.model(), $.session.version()])
    await record($, 'session.start', { ...e, model, version, usage: await usage($) })
    await $.command.register({ name: COMMAND, description: 'Turns the usage dashboard on or off.', argumentHint: '[auto]' })

    if ((await isAuto($)) && !(await isUp($))) {
      await start($)
    }

    return next(e)
  })

  on('command.run', async ($, e, next) => {
    await record($, 'command', { command: e.command })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() === 'auto') {
      const auto = !(await isAuto($))
      await $.store.set('auto', auto)

      return { text: `Usage dashboard auto start is ${auto ? 'on' : 'off'}.` }
    }

    if (await isUp($)) {
      await $.http.fetch(`${DASHBOARD}/api/stop`, { method: 'POST' }).catch(() => undefined)

      return { text: 'Usage dashboard is off.' }
    }

    return { text: (await start($)) ? `Usage dashboard is on: ${DASHBOARD}` : 'Usage dashboard did not start. It needs node on the PATH.' }
  })

  on('turn.start', async ($, e, next) => {
    await loadRules($)
    await record($, 'turn.start', { turnId: e.turnId, usage: await usage($) })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    const { turnId, agentId, reason, durationMs, usage: tokens } = e
    await record($, 'turn.end', { turnId, agentId, reason, durationMs, tokens, usage: await usage($), ...drain() })
    await flush($)

    return answered
  })

  on('session.measure', async ($, e, next) => {
    const { changed, ...measured } = e
    await record($, 'measure', { changed, usage: measured })

    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    if (e.tool_use_id !== undefined && verdict.decision === 'ask') {
      await record($, 'ask', { tool: e.tool, id: e.tool_use_id, agentId: e.agentId })
    }

    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const logged = (outcome: string) => record($, 'tool', { tool: e.tool, id: e.tool_use_id, agentId: e.agentId, startedAt, outcome })
    const deny = e.tool === 'Read' ? await overCap($, e) : undefined

    if (deny !== undefined) {
      await logged('denied')

      return { deny }
    }

    const result = await next(e)
    await logged(result.deny !== undefined ? 'denied' : result.isError ? 'error' : 'ok')

    return result
  })

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    const rule = rules.rules[`t:${e.tool}`]
    note(`t:${e.tool}`, { kind: 'tools', name: e.tool, text: described.description, deferred: (described.isDeferred ?? e.isDeferred) === true })

    return {
      ...described,
      ...(rule?.a === 'rewrite' ? { description: rule.text ?? described.description } : {}),
      ...(rule?.a === 'defer' ? { isDeferred: true } : {}),
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    sections.forEach((section, pos) => note(`s:${section.id}`, { kind: 'sections', name: section.id, text: section.text, scope: section.scope, pos }))

    return { sections: arrange(sections) }
  })

  on('prompt.attachment', async ($, e, next) => {
    const attached = await next(e)
    const id = e.type === 'skill_listing' ? LISTING : `b:${e.type}`
    const rule = rules.rules[id]
    blocks[e.type] = (blocks[e.type] ?? 0) + 1

    if (attached.text !== null) {
      note(id, { kind: id === LISTING ? 'skills' : 'blocks', name: e.type, text: attached.text })
    }

    return rule ? { text: rule.a === 'drop' ? null : (rule.text ?? attached.text) } : attached
  })

  on('skill.prompt', async ($, e, next) => {
    const prompted = await next(e)
    note(`k:${e.skill}`, { kind: 'skills', name: e.skill, text: prompted.text })

    return { text: rules.rules[`k:${e.skill}`]?.text ?? prompted.text }
  })

  on('classic.*', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    const event = 'hook_event_name' in e ? e.hook_event_name : 'PreToolUse'
    const count = (hooks[event] ??= { n: 0, ms: 0, blocked: 0 })
    count.n++
    count.ms += (await $.clock.now()) - startedAt
    count.blocked += result && 'block' in result && result.block !== undefined ? 1 : 0

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const { messages, ...counts } = result
    await record($, 'compact', { trigger: e.trigger, agentId: e.agentId, ...counts })

    return result
  })

  on('session.end', async ($, e, next) => {
    await record($, 'session.end', { reason: e.reason, usage: await usage($), ...drain() })

    return next(e)
  })
}
