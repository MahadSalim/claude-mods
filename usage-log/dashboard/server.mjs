import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// The Claude config folder.
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const PROJECTS = path.join(CONFIG, 'projects')
const HOME = path.join(CONFIG, 'usage-log')
const EVENTS = path.join(HOME, 'events')
const CACHE = path.join(HOME, 'cache.json')
// What sessions loaded into their context, and the rules applied to it.
const CONTEXT = path.join(HOME, 'context.json')
const RULES = path.join(HOME, 'rules.json')
const CACHE_VERSION = 2
const PORT = Number(process.env.PORT) || 5198
// Host headers the server answers.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const PRICES = JSON.parse(fs.readFileSync(path.join(HERE, 'prices.json'), 'utf8'))
// Row types of a transcript the dashboard reads.
const READ_TYPES = new Set(['user', 'assistant', 'system', 'custom-title', 'ai-title'])
// Characters of one chat block sent to the page.
const BLOCK_CHARS = 4000
// Characters of a request body the server reads.
const BODY_CHARS = 2_000_000
const CHARS_PER_TOKEN = 4
const WEEK_MS = 7 * 86_400_000
// Milliseconds since its last activity a session counts as running, and as holding a warm prompt cache.
const LIVE_MS = 300_000
const OPEN_MS = 3_600_000
const WINDOWS = { five_hour: 'p5', seven_day: 'p7' }
const TOKENS = ['input', 'output', 'cacheWrite', 'cacheRead']
// Dollar figures of a request: its cost, the cost by token type, and what cache reads saved.
const DOLLARS = ['cost', 'cIn', 'cOut', 'cRead', 'cWrite', 'saved']
// Tools whose input names one file.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write'])
// Git steps a Bash command runs, by name.
const GIT = { commit: /\bgit\s+commit\b/, pr: /\bgh\s+pr\s+create\b/ }
const ACTIONS = new Set(['defer', 'drop', 'rewrite'])
const NO_CAP = { on: false, k: 10, part: true }

/** The price row of a model id: the longest prefix in the table. */
const rate = model =>
  PRICES.models[Object.keys(PRICES.models).filter(prefix => model.startsWith(prefix)).sort((a, b) => b.length - a.length)[0]]

/** The price row a request is billed at: the model's, or its tier over 100k input tokens. */
const tierOf = r => {
  const price = rate(r.model)

  return price?.over100k && r.input + r.cacheWrite + r.cacheRead > 100_000 ? price.over100k : price
}

/** The price-table cost of one request by token type, in dollars: input, output, cache read, cache write. */
const costs = r => {
  const tier = tierOf(r)

  if (!tier) {
    return [0, 0, 0, 0]
  }

  const writes = (r.cacheWrite - r.cacheWrite1h) * PRICES.write5m + r.cacheWrite1h * PRICES.write1h
  const scale = ((r.fast && rate(r.model).fast) || 1) / 1e6

  return [r.input * tier.input, r.output * tier.output, r.cacheRead * tier.read, writes * tier.input].map(dollars => dollars * scale)
}

/** The price-table cost of one request, in dollars. */
const cost = r => costs(r).reduce((total, dollars) => total + dollars, 0)

/** The tokens of one request, of every type. */
const tokens = r => r.input + r.output + r.cacheWrite + r.cacheRead

/** The local calendar day of a time, as YYYY-MM-DD. */
const day = at => {
  const d = new Date(at)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** An empty total of token counts, cost, plan share and requests. */
const zeros = () => ({ requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, cIn: 0, cOut: 0, cRead: 0, cWrite: 0, saved: 0, p5: 0, p7: 0, wk: 0 })

/** Adds the token counts, cost and plan share of a request to a total. */
const add = (total, r) => {
  for (const key of [...TOKENS, ...DOLLARS, 'p5', 'p7', 'wk']) {
    total[key] += r[key] ?? 0
  }
  total.requests++

  return total
}

/** Runs fn over the items, n at a time. */
const pool = async (items, n, fn) => {
  const queue = [...items]
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) {
      await fn(queue.shift())
    }
  }))
}

/** The parsed lines of a JSONL file, skipping the ones keep refuses. */
async function* lines(file, keep = () => true) {
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (line && keep(line)) {
      try {
        yield JSON.parse(line)
      } catch {}
    }
  }
}

/** Whether a transcript line is of a type the dashboard reads. */
const isRead = line => {
  const lead = /^\{"type":"([^"]+)"/.exec(line)?.[1]

  return lead ? READ_TYPES.has(lead) : !line.includes('"type":"attachment"')
}

/** The text of a message's content: the string, or its text blocks joined. */
const textOf = content =>
  typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')

/** The first line of a text, cut to n characters. */
const firstLine = (text, n) => text.trim().split('\n')[0].slice(0, n)

/** What the dashboard keeps of a tool call's input: the file it names, the skill it loads, the git step it runs. */
const factsOf = ({ name, input = {} }) => ({
  file: FILE_TOOLS.has(name) ? input.file_path : undefined,
  skill: name === 'Skill' ? input.skill : undefined,
  git: name === 'Bash' ? Object.keys(GIT).find(step => GIT[step].test(input.command ?? '')) : undefined,
})

/** The lines a file tool's result added and removed. */
const linesOf = result => {
  const changed = result.structuredPatch.flatMap(hunk => hunk.lines ?? [])
  const count = sign => changed.filter(line => line.startsWith(sign)).length

  return { add: result.type === 'create' ? String(result.content ?? '').split('\n').length : count('+'), del: count('-') }
}

/** Whether a transcript row is a prompt the person typed. */
const isPrompt = r =>
  r.type === 'user' && !r.isMeta && !r.isSidechain && !r.toolUseResult && (r.origin?.kind ?? 'human') === 'human' && /^(?!<(local-command|task-notification))\s*\S/.test(textOf(r.message?.content))

/** The model and token counts of one assistant message. */
const usageOf = ({ model, usage: u }) => ({
  model,
  input: u.input_tokens ?? 0,
  output: u.output_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  fast: u.speed === 'fast',
})

/** One transcript file as the dashboard counts it: requests, tool uses, prompts, compactions and facts. */
const parseTranscript = async file => {
  const out = { requests: {}, uses: {}, prompts: [], compacts: [], start: 0, end: 0 }

  for await (const r of lines(file, isRead)) {
    const at = Date.parse(r.timestamp)

    if (at) {
      out.start = Math.min(out.start || at, at)
      out.end = Math.max(out.end, at)
    }

    if (r.type === 'custom-title') {
      out.title = r.customTitle
    } else if (r.type === 'ai-title') {
      out.aiTitle = r.aiTitle
    } else if (r.type === 'system' && r.subtype === 'compact_boundary') {
      out.compacts.push({ at, trigger: r.compactMetadata?.trigger, tokensBefore: r.compactMetadata?.preTokens, tokensAfter: r.compactMetadata?.postTokens })
    } else if (r.type === 'assistant' && r.message?.usage && r.message.model !== '<synthetic>') {
      out.requests[r.requestId ?? r.message.id] = { at, agent: r.agentId, ...usageOf(r.message) }

      for (const block of r.message.content ?? []) {
        if (block.type === 'tool_use') {
          out.uses[block.id] = { at, agent: r.agentId, name: block.name, ...factsOf(block) }
        }
      }
    } else if (r.type === 'user') {
      out.cwd ??= r.cwd
      out.version = r.version ?? out.version
      out.entrypoint ??= r.entrypoint

      for (const block of Array.isArray(r.message?.content) ? r.message.content : []) {
        const use = block.type === 'tool_result' && out.uses[block.tool_use_id]

        if (use) {
          const text = textOf(block.content)
          Object.assign(use, { chars: text.length }, block.is_error && { isError: true, err: firstLine(text, 160) }, r.toolUseResult?.structuredPatch && linesOf(r.toolUseResult))
        }
      }

      if (isPrompt(r)) {
        out.prompts.push({ at, text: textOf(r.message.content).trim().slice(0, 300) })
      }
    }
  }

  return out
}

/** The rows of one usage-log file. */
const parseEvents = async file => {
  const rows = []

  for await (const row of lines(file)) {
    rows.push(row)
  }

  return rows
}

/** Every file under a directory, recursively. */
const walk = async dir => {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(entry => {
    const full = path.join(dir, entry.name)

    return entry.isDirectory() ? walk(full) : [full]
  }))

  return nested.flat()
}

/** What a path under the projects folder is: a session's transcript, a subagent's, or neither. */
const classify = file => {
  const parts = path.relative(PROJECTS, file).split(path.sep)
  const name = path.basename(file, '.jsonl')
  const sub = parts.indexOf('subagents')

  if (!file.endsWith('.jsonl')) {
    return undefined
  }

  if (parts.length === 2) {
    return { session: name, folder: parts[0] }
  }

  if (sub === 2 && name.startsWith('agent-')) {
    const workflow = parts[sub + 1] === 'workflows' ? parts[sub + 2] : null

    return { session: parts[1], folder: parts[0], agent: name.slice('agent-'.length), workflow }
  }

  return undefined
}

// Parsed files by path, each with the mtime and size it was parsed at.
let cache = {}
let refreshing
let built

try {
  const saved = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
  cache = saved.version === CACHE_VERSION ? saved.files : {}
} catch {}

/** Parses the files that are new or changed, drops the ones gone, and saves the cache. */
const refresh = () =>
  (refreshing ??= (async () => {
    const found = [...(await walk(PROJECTS)).filter(classify), ...(await walk(EVENTS)).filter(file => file.endsWith('.jsonl'))]
    const next = {}
    let changed = Object.keys(cache).length !== found.length

    await pool(found, 8, async file => {
      const stat = await fsp.stat(file).catch(() => undefined)
      const held = cache[file]

      if (!stat) {
        return
      }

      if (held?.mtimeMs === stat.mtimeMs && held.size === stat.size) {
        next[file] = held

        return
      }

      const isEvents = file.startsWith(EVENTS)
      const data = await (isEvents ? parseEvents(file) : parseTranscript(file))
      const meta = isEvents ? undefined : await fsp.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8').then(JSON.parse, () => undefined)
      next[file] = { mtimeMs: stat.mtimeMs, size: stat.size, data, meta }
      changed = true
    })

    cache = next

    built = changed || !built ? build() : built

    if (changed) {
      await fsp.mkdir(path.dirname(CACHE), { recursive: true })
      await fsp.writeFile(CACHE, JSON.stringify({ version: CACHE_VERSION, files: cache }))
    }
  })().finally(() => (refreshing = undefined)))

/** The plan readings of one window, from the rows logged right after an API response; time-ordered, rising within a window. */
const readingsOf = (rows, kind) => {
  const readings = []

  for (const row of rows.filter(row => row.ev === 'measure' || row.ev === 'turn.end')) {
    const limit = row.usage?.rateLimits?.find(one => one.kind === kind)
    const last = readings.at(-1)
    const reading = limit && { at: row.at, percent: limit.percentUsed, resetsAt: Date.parse(limit.resetsAt) || null }

    if (reading && !(last?.resetsAt === reading.resetsAt && reading.percent <= last.percent)) {
      readings.push(reading)
    }
  }

  return readings
}

/** Splits each rise between two readings over the requests made between them, by cost; returns the percent no request explains. */
const attribute = (readings, requests, field) => {
  let from = 0
  let unattributed = 0

  for (let k = 1; k < readings.length; k++) {
    const [a, b] = [readings[k - 1], readings[k]]
    const isReset = b.resetsAt !== a.resetsAt || b.percent < a.percent
    const delta = isReset ? b.percent : b.percent - a.percent
    const since = isReset && a.resetsAt !== null && a.resetsAt <= b.at ? Math.max(a.at, a.resetsAt) : a.at

    while (from < requests.length && requests[from].at <= since) {
      from++
    }

    let to = from
    let total = 0

    while (to < requests.length && requests[to].at <= b.at) {
      total += requests[to++].cost
    }

    for (let n = from; n < to && total > 0; n++) {
      requests[n][field] += (delta * requests[n].cost) / total
    }

    unattributed += total > 0 ? 0 : Math.max(0, delta)
    from = to
  }

  return unattributed
}

/** Every session with its buckets, tools, agents and log, built from the cache. */
const build = () => {
  const sessions = new Map()
  const session = id => sessions.get(id) ?? sessions.set(id, { id, files: [], rows: [], requests: [], uses: [] }).get(id)

  for (const [file, { data, meta }] of Object.entries(cache)) {
    if (file.startsWith(EVENTS)) {
      session(path.basename(file).split('.')[0]).rows.push(...data)
    } else {
      session(classify(file).session).files.push({ file, ...classify(file), ...data, meta })
    }
  }

  const seen = new Set()
  const requests = []

  for (const s of [...sessions.values()].sort((a, b) => (a.files[0]?.start ?? 0) - (b.files[0]?.start ?? 0))) {
    s.files.sort((a, b) => (a.agent ? 1 : 0) - (b.agent ? 1 : 0) || a.start - b.start)
    s.rows.sort((a, b) => a.at - b.at)

    for (const f of s.files) {
      for (const [id, r] of Object.entries(f.requests)) {
        if (!seen.has(id)) {
          seen.add(id)
          const request = { ...r, agent: r.agent ?? f.agent, p5: 0, p7: 0, wk: 0 }
          const [cIn, cOut, cRead, cWrite] = costs(request)
          const tier = tierOf(request)
          Object.assign(request, { cIn, cOut, cRead, cWrite, cost: cIn + cOut + cRead + cWrite, saved: tier ? (r.cacheRead * (tier.input - tier.read)) / 1e6 : 0 })
          s.requests.push(request)
          requests.push(request)
        }
      }

      for (const [id, use] of Object.entries(f.uses)) {
        if (!seen.has(id)) {
          seen.add(id)
          s.uses.push({ id, ...use, agent: use.agent ?? f.agent })
        }
      }
    }
  }

  requests.sort((a, b) => a.at - b.at)
  const rows = [...sessions.values()].flatMap(s => s.rows).sort((a, b) => a.at - b.at)
  const plan = { unattributed: {} }

  for (const [kind, field] of Object.entries(WINDOWS)) {
    const name = kind === 'five_hour' ? 'fiveHour' : 'sevenDay'
    plan[name] = readingsOf(rows, kind)
    plan.unattributed[name] = attribute(plan[name], requests, field)
  }

  const week = plan.sevenDay.at(-1)
  const weekStart = week?.resetsAt > Date.now() ? week.resetsAt - WEEK_MS : Infinity
  const blocks = {}
  const other = {}

  for (const r of requests) {
    r.wk = r.at >= weekStart ? r.p7 : 0
  }

  for (const row of rows) {
    for (const [type, n] of Object.entries(row.blocks ?? {})) {
      blocks[type] = (blocks[type] ?? 0) + n
    }

    for (const limit of row.usage?.rateLimits ?? []) {
      if (!WINDOWS[limit.kind]) {
        other[limit.kind] = { kind: limit.kind, at: row.at, percent: limit.percentUsed, resetsAt: Date.parse(limit.resetsAt) || null }
      }
    }
  }

  plan.other = Object.values(other)

  return { sessions, plan, blocks, loggingSince: rows[0]?.at ?? null }
}

/** The log summary of a session: engine cost, context fill, turn outcomes and how it ended. */
const logOf = s => {
  if (!s.rows.length) {
    return null
  }

  const outcomes = { answer: 0, aborted: 0, refusal: 0, error: 0 }

  for (const row of s.rows) {
    if (row.ev === 'turn.end') {
      outcomes[row.reason]++
    }
  }

  return {
    engineCost: s.rows.findLast(row => row.usage?.cost)?.usage.cost.usd ?? null,
    context: s.rows.findLast(row => row.usage?.context?.tokens !== undefined)?.usage.context ?? null,
    outcomes,
    endReason: s.rows.findLast(row => row.ev === 'session.end')?.reason ?? null,
  }
}

/** One session as /api/data sends it. */
const summarize = s => {
  const main = s.files.filter(f => !f.agent)
  const facts = main[0] ?? s.files[0] ?? {}
  const cwd = s.files.find(f => f.cwd)?.cwd ?? s.rows.find(row => row.cwd)?.cwd ?? ''
  const prompts = main.flatMap(f => f.prompts).sort((a, b) => a.at - b.at)
  const times = [...s.files.flatMap(f => [f.start, f.end]), ...s.rows.map(row => row.at)].filter(Boolean)
  const buckets = {}
  const tools = {}
  const agents = {}
  const spawnedBy = Object.fromEntries(s.uses.map(use => [use.id, use.agent ?? null]))
  const days = {}
  const hours = {}
  const skills = {}
  const commands = {}
  const hooks = {}
  const asked = new Set()
  const tool = name => (tools[name] ??= { calls: 0, errors: 0, timed: 0, ms: 0, maxMs: 0, chars: 0, asked: 0, denied: 0 })
  const on = at => (days[day(at)] ??= { day: day(at), calls: 0, fails: 0, added: 0, removed: 0, files: new Set(), commits: 0, prs: 0 })
  const count = (counts, name, n = 1) => (counts[name] = (counts[name] ?? 0) + n)

  for (const f of s.files.filter(f => f.agent)) {
    agents[f.agent] ??= {
      ...zeros(),
      id: f.agent,
      type: f.meta?.agentType ?? 'unknown',
      description: f.meta?.description ?? '',
      model: '',
      depth: f.meta?.spawnDepth ?? 1,
      parent: spawnedBy[f.meta?.toolUseId] ?? null,
      background: f.meta?.requestShape === 'background',
      workflow: f.workflow,
      start: f.start,
      end: f.end,
      toolCalls: 0,
    }
  }

  for (const r of s.requests) {
    add((buckets[`${day(r.at)}|${r.model}|${r.agent ? 1 : 0}`] ??= { ...zeros(), day: day(r.at), model: r.model, sub: Boolean(r.agent) }), r)
    count(hours, `${day(r.at)}|${new Date(r.at).getHours()}`, tokens(r))

    if (agents[r.agent]) {
      add(agents[r.agent], r).model = r.model
    }
  }

  for (const use of s.uses) {
    const counted = tool(use.name)
    const daily = on(use.at)
    const isDone = !use.isError
    counted.calls++
    counted.errors += isDone ? 0 : 1
    counted.chars += use.chars ?? 0
    daily.calls++
    daily.fails += isDone ? 0 : 1
    daily.added += use.add ?? 0
    daily.removed += use.del ?? 0
    daily.commits += isDone && use.git === 'commit' ? 1 : 0
    daily.prs += isDone && use.git === 'pr' ? 1 : 0

    if (use.add !== undefined) {
      daily.files.add(use.file)
    }

    if (use.skill) {
      count(skills, use.skill)
    }

    if (agents[use.agent]) {
      agents[use.agent].toolCalls++
    }
  }

  for (const row of s.rows) {
    if (row.ev === 'tool') {
      const timed = tool(row.tool)
      const ms = row.at - row.startedAt
      timed.timed++
      timed.ms += ms
      timed.maxMs = Math.max(timed.maxMs, ms)
      timed.denied += row.outcome === 'denied' && asked.has(row.id) ? 1 : 0
    } else if (row.ev === 'ask') {
      tool(row.tool).asked++
      asked.add(row.id)
    } else if (row.ev === 'command') {
      count(commands, row.command)
    }

    for (const [event, ran] of Object.entries(row.hooks ?? {})) {
      const held = (hooks[event] ??= { n: 0, ms: 0, blocked: 0 })
      held.n += ran.n
      held.ms += ran.ms
      held.blocked += ran.blocked
    }
  }

  const log = logOf(s)
  const end = Math.max(...times)
  const reads = s.uses.filter(use => use.name === 'Read' && !use.agent && use.chars).sort((a, b) => b.chars - a.chars)
  const fails = s.uses.filter(use => use.isError).sort((a, b) => b.at - a.at)

  return {
    id: s.id,
    title: main.map(f => f.title ?? f.aiTitle).find(Boolean) ?? prompts[0]?.text.slice(0, 80) ?? s.id,
    project: path.basename(cwd) || facts.folder || '',
    cwd,
    start: Math.min(...times),
    end,
    live: !log?.endReason && Date.now() - end < LIVE_MS,
    model: s.requests.findLast(r => !r.agent)?.model ?? null,
    version: facts.version ?? null,
    entrypoint: facts.entrypoint ?? null,
    prompts: prompts.length,
    compactions: main.reduce((n, f) => n + f.compacts.length, 0),
    usage: Object.values(buckets),
    tools,
    agents: Object.values(agents),
    hours,
    days: Object.values(days).map(daily => ({ ...daily, files: daily.files.size })),
    fails: fails.slice(0, 5).map(use => ({ at: use.at, tool: use.name, text: use.err ?? '' })),
    reads: reads.slice(0, 5).map(use => ({ at: use.at, file: use.file, tokens: Math.round(use.chars / CHARS_PER_TOKEN) })),
    skills,
    commands,
    hooks,
    log,
  }
}

/** The percent used of one plan window in a log row. */
const percentAt = (row, kind) => row?.usage?.rateLimits?.find(one => one.kind === kind)?.percentUsed ?? null

/** One session with its turns, events and workflows, as /api/session sends it. */
const detail = async s => {
  const main = s.files.filter(f => !f.agent)
  const prompts = main.flatMap(f => f.prompts).sort((a, b) => a.at - b.at)
  const starts = s.rows.filter(row => row.ev === 'turn.start')
  const mainRequests = s.requests.filter(r => !r.agent)
  const turns = prompts.map((prompt, i) => {
    const until = prompts[i + 1]?.at ?? Infinity
    const inTurn = one => one.at >= prompt.at && one.at < until
    const made = mainRequests.filter(inTurn)
    const started = starts.find(row => row.at >= prompt.at - 5000 && row.at < until)
    const ended = started && s.rows.find(row => row.ev === 'turn.end' && row.turnId === started.turnId && !row.agentId)

    return {
      at: prompt.at,
      end: made.at(-1)?.at ?? prompt.at,
      prompt: prompt.text,
      model: made.at(-1)?.model ?? null,
      ...made.reduce((total, r) => add(total, r), zeros()),
      toolCalls: s.uses.filter(use => !use.agent && inTurn(use)).length,
      log: ended
        ? {
            reason: ended.reason,
            durationMs: ended.durationMs,
            p5: [percentAt(started, 'five_hour'), percentAt(ended, 'five_hour')],
            p7: [percentAt(started, 'seven_day'), percentAt(ended, 'seven_day')],
            contextPercent: ended.usage?.context?.percent ?? null,
            contextTokens: ended.usage?.context?.tokens ?? null,
          }
        : null,
    }
  })
  const compacts = s.rows.length
    ? s.rows.filter(row => row.ev === 'compact' && row.trigger !== 'precompute')
    : main.flatMap(f => f.compacts)
  const events = [
    ...s.rows.filter(row => row.ev === 'session.start').map(row => ({ at: row.at, kind: row.ev, detail: [row.model, row.surface, row.version].filter(Boolean).join(', ') })),
    ...s.rows.filter(row => row.ev === 'session.end').map(row => ({ at: row.at, kind: row.ev, detail: row.reason })),
    ...s.rows.filter(row => row.ev === 'tool' && row.outcome === 'denied').map(row => ({ at: row.at, kind: 'tool.denied', detail: row.tool })),
    ...s.files.filter(f => f.agent).map(f => ({ at: f.end, kind: 'subagent.end', detail: [f.meta?.agentType, f.meta?.description].filter(Boolean).join(': ') })),
    ...compacts.map(c => ({
      at: c.at,
      kind: 'compact',
      detail: [c.trigger, c.agentId && `agent ${c.agentId}`, c.skip && `skipped: ${c.skip}`, c.tokensBefore && `${c.tokensBefore} tokens before`, c.tokensAfter && `${c.tokensAfter} after`].filter(Boolean).join(', '),
    })),
  ].sort((a, b) => a.at - b.at)
  const runs = await Promise.all(
    [...new Set(s.files.map(f => path.join(PROJECTS, f.folder, s.id, 'workflows')))].map(dir =>
      fsp.readdir(dir).then(names => Promise.all(names.filter(name => name.endsWith('.json')).map(name => fsp.readFile(path.join(dir, name), 'utf8').then(JSON.parse))), () => []),
    ),
  )
  const workflows = runs.flat().map(run => ({
    id: run.runId,
    name: run.workflowName,
    status: run.status,
    durationMs: run.durationMs ?? null,
    agents: run.agentCount ?? 0,
    tokens: run.totalTokens ?? 0,
    toolCalls: run.totalToolCalls ?? 0,
  }))

  const compactions = compacts.filter(c => !c.skip).map(c => ({ at: c.at, before: c.tokensBefore ?? null, after: c.tokensAfter ?? null }))

  return { session: summarize(s), turns, events, workflows, compactions }
}

/** A text cut to the characters the page shows. */
const clip = text => (text.length > BLOCK_CHARS ? `${text.slice(0, BLOCK_CHARS)}\n… ${text.length - BLOCK_CHARS} more characters` : text)

/** A tool call's input in a few words: the file, command, pattern or address it names. */
const argOf = (input = {}) => {
  const file = input.file_path ?? input.path
  const named = input.command ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? input.description ?? ''

  return file ? String(file).split(/[\\/]/).slice(-2).join('/') : firstLine(String(named), 60)
}

/** The turns of one transcript file: each prompt with the tool calls, the reply and the requests that answered it. */
const chat = async (file, s, isAgent) => {
  const turns = []
  const calls = {}
  const took = Object.fromEntries(s.rows.filter(row => row.ev === 'tool').map(row => [row.id, row.at - row.startedAt]))
  const spawned = Object.fromEntries(s.files.filter(f => f.agent).map(f => [f.meta?.toolUseId, f.agent]))
  let turn

  for await (const r of lines(file, isRead)) {
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || !r.message) {
      continue
    }

    const at = Date.parse(r.timestamp)
    const content = typeof r.message.content === 'string' ? [{ type: 'text', text: r.message.content }] : r.message.content ?? []

    if (r.type === 'user' && (isAgent ? !r.toolUseResult && textOf(content).trim() : isPrompt(r))) {
      turns.push((turn = { at, end: at, prompt: clip(textOf(content).trim()), tools: [], reply: '', model: null, requests: {} }))
    } else if (turn) {
      turn.end = at || turn.end

      for (const block of content) {
        if (block.type === 'text' && r.type === 'assistant') {
          turn.reply = clip(block.text)
        } else if (block.type === 'tool_use') {
          turn.tools.push((calls[block.id] = { name: block.name, arg: argOf(block.input), ms: took[block.id] ?? null, isError: false, agent: spawned[block.id] ?? null }))
        } else if (block.type === 'tool_result' && block.is_error && calls[block.tool_use_id]) {
          calls[block.tool_use_id].isError = true
        }
      }

      if (r.type === 'assistant' && r.message.usage && r.message.model !== '<synthetic>') {
        turn.model = r.message.model
        turn.requests[r.requestId ?? r.message.id] = usageOf(r.message)
      }
    }
  }

  return { turns: turns.map(({ requests, ...kept }) => ({ ...kept, ...Object.values(requests).reduce((total, r) => add(total, { ...r, cost: cost(r) }), zeros()) })) }
}

/** A JSON file's value, or the fallback when the file holds none. */
const readJson = (file, fallback) => fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => fallback)

/** What one cache miss costs a session, in dollars: its context written to the cache again, not read from it. */
const missOf = s => {
  const last = s.requests.findLast(r => !r.agent)
  const price = last && rate(last.model)
  const written = s.requests.reduce((total, r) => total + r.cacheWrite, 0)
  const hourly = written ? s.requests.reduce((total, r) => total + r.cacheWrite1h, 0) / written : 0
  const write = PRICES.write5m + (PRICES.write1h - PRICES.write5m) * hourly

  return price ? ((last.input + last.cacheRead + last.cacheWrite) * (price.input * write - price.read)) / 1e6 : 0
}

/** The loaded items, the rules on them and what applying a change costs, as /api/context sends them. */
const context = async () => {
  const [catalog, { rules = {}, order = null, cap, prev }] = await Promise.all([readJson(CONTEXT, {}), readJson(RULES, {})])
  const sessions = [...built.sessions.values()]
  const lastAt = s => Math.max(0, ...s.files.map(f => f.end), s.rows.at(-1)?.at ?? 0)
  const open = sessions.filter(s => Date.now() - lastAt(s) < OPEN_MS && !s.rows.some(row => row.ev === 'session.end'))
  const reads = sessions.flatMap(s => s.uses.filter(use => use.name === 'Read' && !use.agent && use.chars && Date.now() - use.at < 30 * 86_400_000))

  return {
    sessions: Object.keys(catalog.sessions ?? {}).length,
    items: Object.entries(catalog.items ?? {}).map(([id, { at, ...item }]) => ({
      id,
      ...item,
      tok: item.tok ?? Math.round(item.chars / CHARS_PER_TOKEN),
      seen: item.kind === 'blocks' || item.name === 'skill_listing' ? built.blocks[item.name] ?? 0 : undefined,
    })),
    rules,
    order,
    cap: { ...NO_CAP, ...cap },
    canUndo: Boolean(prev),
    open: open.length,
    miss: open.reduce((total, s) => total + missOf(s), 0),
    reads: reads.sort((a, b) => b.chars - a.chars).slice(0, 12).map(use => ({ file: use.file, tokens: Math.round(use.chars / CHARS_PER_TOKEN) })),
  }
}

/** A request's JSON body. */
const bodyOf = async request => {
  let text = ''

  for await (const chunk of request) {
    text += chunk

    if (text.length > BODY_CHARS) {
      throw new Error('body too large')
    }
  }

  return JSON.parse(text)
}

/** The rules a posted document holds, or undefined when it is not a rules document. */
const rulesOf = ({ rules = {}, order = null, cap = {} }) => {
  const isRule = rule => ACTIONS.has(rule?.a) && (rule.text === undefined || typeof rule.text === 'string')
  const isOrder = order === null || (Array.isArray(order) && order.every(id => typeof id === 'string'))

  return typeof rules === 'object' && Object.values(rules).every(isRule) && isOrder
    ? { rules, order, cap: { on: Boolean(cap.on), k: Math.min(1000, Math.max(1, Number(cap.k) || NO_CAP.k)), part: cap.part !== false } }
    : undefined
}

/** Writes the posted rules, or the ones before the last write when the post asks to undo; resolves whether it wrote. */
const applyRules = async request => {
  const [posted, { prev, ...before }] = await Promise.all([bodyOf(request), readJson(RULES, {})])
  const next = posted.undo ? prev : rulesOf(posted)

  if (!next) {
    return false
  }

  await fsp.mkdir(HOME, { recursive: true })
  await fsp.writeFile(RULES, JSON.stringify(posted.undo ? next : { ...next, prev: before }))

  return true
}

/** The price table as the page shows it: dollars per million tokens, by model prefix. */
const prices = () =>
  Object.fromEntries(Object.entries(PRICES.models).map(([model, { input, output, read }]) => [model, { input, output, read, write5m: input * PRICES.write5m, write1h: input * PRICES.write1h }]))

const routes = {
  '/api/data': () => ({
    generatedAt: Date.now(),
    loggingSince: built.loggingSince,
    prices: prices(),
    sessions: [...built.sessions.values()].filter(s => s.requests.length).map(summarize),
    plan: built.plan,
  }),
  '/api/session': id => built.sessions.has(id) && detail(built.sessions.get(id)),
  '/api/chat': (id, query) => {
    const agent = query.get('agent')
    const s = built.sessions.get(id)
    const file = s?.files.find(f => (agent ? f.agent === agent : !f.agent))

    return file && chat(file.file, s, Boolean(agent))
  },
  '/api/context': context,
}

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const [, route, id] = /^(\/api\/[a-z]+)(?:\/([^/]+))?$/.exec(url.pathname) ?? []
    const send = (status, type, body) => response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }).end(body)

    const { host, origin } = request.headers

    try {
      if (!HOSTS.has(host) || (origin && origin !== `http://${host}`)) {
        return send(403, 'application/json', '{"error":"forbidden"}')
      }

      if (request.method === 'POST' && url.pathname === '/api/stop') {
        return response.end('{}', () => process.exit())
      }

      if (request.method === 'POST') {
        const isRules = url.pathname === '/api/rules' && request.headers['content-type']?.startsWith('application/json')

        return isRules && (await applyRules(request)) ? send(200, 'application/json', '{}') : send(400, 'application/json', '{"error":"not a rules document"}')
      }

      if (!routes[route]) {
        return send(200, 'text/html', await fsp.readFile(path.join(HERE, 'index.html')))
      }

      await refresh()
      const body = await routes[route](id, url.searchParams)

      return body ? send(200, 'application/json', JSON.stringify(body)) : send(404, 'application/json', '{"error":"not found"}')
    } catch (error) {
      return send(500, 'application/json', JSON.stringify({ error: String(error?.message ?? error) }))
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Claude dashboard: http://127.0.0.1:${PORT}`))
