import type { EngineInterface, PromptComposeSection, Register } from 'claude-code'

// The mod's folder, from the Claude config folder.
const HOME = 'prompt-strip'
// The dashboard's address.
const DASHBOARD = 'http://127.0.0.1:5199'
// The slash command that opens and stops the dashboard.
const COMMAND = 'prompt-strip'
// A node script that starts the script named after it as a process of its own.
const DETACH = "require('child_process').spawn(process.execPath,[process.argv[1]],{detached:true,stdio:'ignore',windowsHide:true}).unref()"
// Characters of one item's text the catalog holds.
const TEXT_CHARS = 100_000
// Milliseconds the catalog keeps an item no session loaded again.
const ITEM_MS = 30 * 86_400_000
// Events whose answers the engine caches.
const CACHED = ['prompt.section', 'prompt.context', 'prompt.attachment', 'tool.describe', 'command.describe'] as const
const NO_RULES: Rules = { paused: false, rules: {}, order: null, added: [] }

/** The layers of what a session loads, by the prefix of their catalog ids. */
type Kind = 'sections' | 'context' | 'reminders' | 'tools' | 'skills' | 'agents' | 'commands'
type Rule = { off?: boolean; text?: string }
type Added = { id: string; text: string; off?: boolean }
type Rules = { paused: boolean; rules: Record<string, Rule>; order: string[] | null; added: Added[] }
type Item = { kind: Kind; name: string; text: string; chars: number; count?: number; scope?: string; deferred?: boolean; hidden?: boolean; source?: string }
type Catalog = { items?: Record<string, Item & { at: number }>; compose?: { ids: string[]; model: string; at: number } }

/** The Claude config folder: CLAUDE_CONFIG_DIR, or .claude under the home folder. */
const configDir = async ($: EngineInterface) =>
  (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))}/.claude`

/** Whether the dashboard's server answers. */
const isUp = ($: EngineInterface) => $.http.fetch(`${DASHBOARD}/api/ping`).then(response => response.ok, () => false)

/** Starts the dashboard's server; resolves whether it was started. */
const start = ($: EngineInterface) =>
  $.process.run(['node', '-e', DETACH, `${$.plugin.root}/dashboard/server.mjs`]).then(ran => ran.exitCode === 0, () => false)

/** The rules a rules file's text holds; none when it holds no JSON. */
const parse = (text: string): Rules => {
  try {
    const held = JSON.parse(text)

    return { paused: held.paused === true, rules: held.rules ?? {}, order: Array.isArray(held.order) ? held.order : null, added: Array.isArray(held.added) ? held.added : [] }
  } catch {
    return NO_RULES
  }
}

let config: Promise<string> | undefined
let rules = NO_RULES
let rulesText = ''
// Items this process loaded, by catalog id.
let catalog: Record<string, Item> = {}
let compose: { ids: string[]; model: string } | undefined
let isDirty = false

/** The rule on one catalog id, or none while the rules are paused. */
const ruleOf = (id: string): Rule | undefined => (rules.paused ? undefined : rules.rules[id])

/** Clears the answers the engine cached, so each one passes through these hooks again. */
const recache = ($: EngineInterface) => Promise.all(CACHED.map(event => $.ui.invalidate(event))).catch(() => {})

/** Reads the rules file; on a change, clears the answers the engine cached. */
const loadRules = async ($: EngineInterface) => {
  const text = await $.fs.read(`${await (config ??= configDir($))}/${HOME}/rules.json`).catch(() => '')

  if (text === rulesText) {
    return
  }

  rulesText = text
  rules = parse(text)
  await recache($)
}

/** Holds one loaded item in the catalog, its text as the engine computed it. */
const note = (id: string, item: Omit<Item, 'chars'>) => {
  const text = item.text.slice(0, TEXT_CHARS)
  const held = catalog[id]
  const count = item.kind === 'reminders' ? (held?.count ?? 0) + 1 : undefined
  isDirty ||= held?.text !== text || held.deferred !== item.deferred || held.hidden !== item.hidden
  catalog[id] = { ...held, ...item, text, chars: item.text.length, ...(count ? { count } : {}) }
}

/** Holds the system prompt's sections, as composed for one model, in the catalog. */
const noteSections = (sections: readonly PromptComposeSection[], model: string) => {
  sections.forEach(section => note(`s:${section.id}`, { kind: 'sections', name: section.id, text: section.text, scope: section.scope }))
  const ids = sections.map(section => section.id)
  isDirty ||= compose?.ids.join() !== ids.join()
  compose = { ids, model }
}

/** Merges this process's items into the catalog file, after an item changed. */
const flush = async ($: EngineInterface) => {
  if (!isDirty) {
    return
  }

  isDirty = false
  const [at, root] = await Promise.all([$.clock.now(), (config ??= configDir($))])
  const path = `${root}/${HOME}/catalog.json`
  const held: Catalog = await $.fs.read(path).then(JSON.parse).catch(() => ({}))
  const fresh = Object.fromEntries(Object.entries(held.items ?? {}).filter(([, row]) => at - row.at < ITEM_MS))
  const mine = Object.fromEntries(Object.entries(catalog).map(([key, item]) => [key, { ...item, at }]))
  const merged: Catalog = { items: { ...fresh, ...mine }, compose: compose ? { ...compose, at } : held.compose }
  await $.fs.write(path, JSON.stringify(merged)).catch(() => {})
}

/** The system prompt's sections under the rules: dropped, rewritten, added and reordered, every shared one first. */
const arrange = (sections: readonly PromptComposeSection[]): PromptComposeSection[] => {
  const added = (rules.paused ? [] : rules.added).filter(one => !one.off && one.text.trim()).map(one => ({ id: `${HOME}:${one.id}`, text: one.text, scope: 'session' as const }))
  const kept = [...sections, ...added]
    .filter(section => !ruleOf(`s:${section.id}`)?.off)
    .map((section, at) => ({ ...section, text: ruleOf(`s:${section.id}`)?.text ?? section.text, at }))
  const order = rules.paused ? null : rules.order
  const rank = (id: string) => order?.indexOf(id) ?? -1
  const side = (section: PromptComposeSection) => (section.scope === 'shared' ? 0 : 1)
  const placed = (section: PromptComposeSection & { at: number }) => (rank(section.id) < 0 ? kept.length + section.at : rank(section.id))

  return kept.sort((a, b) => side(a) - side(b) || (order ? placed(a) - placed(b) : 0) || a.at - b.at).map(({ at, ...section }) => section)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadRules($)
    await recache($)
    await $.command.register({ name: COMMAND, description: 'Opens the prompt-strip dashboard, or stops it.', argumentHint: '[stop]' })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await loadRules($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    await flush($)

    return answered
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await $.prompt.compose().then(composed => noteSections(composed.sections, compose?.model ?? ''), () => {})
    await recache($)
    await flush($)

    if (e.args.trim() === 'stop') {
      const wasUp = await isUp($)
      await $.http.fetch(`${DASHBOARD}/api/stop`, { method: 'POST' }).catch(() => undefined)

      return { text: wasUp ? 'prompt-strip dashboard stopped.' : 'prompt-strip dashboard was not running.' }
    }

    if ((await isUp($)) || (await start($))) {
      return { text: `prompt-strip dashboard: ${DASHBOARD}\nChanges apply from the next turn.` }
    }

    return { text: 'prompt-strip dashboard did not start. It needs node on the PATH.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    noteSections(sections, e.promptModel)

    return { sections: arrange(sections) }
  })

  on('prompt.context', async ($, e, next) => {
    const answered = await next(e)
    answered.blocks.forEach(block => note(`c:${block.name}`, { kind: 'context', name: block.name, text: block.text }))
    const blocks = answered.blocks
      .filter(block => !ruleOf(`c:${block.name}`)?.off)
      .map(block => ({ ...block, text: ruleOf(`c:${block.name}`)?.text ?? block.text }))

    return { ...answered, blocks }
  })

  on('prompt.attachment', async ($, e, next) => {
    const attached = await next(e)
    const rule = ruleOf(`r:${e.type}`)

    if (attached.text !== null) {
      note(`r:${e.type}`, { kind: 'reminders', name: e.type, text: attached.text, source: e.origin.kind === 'engine' ? 'engine' : `${e.origin.kind}:${e.origin.event}` })
    }

    return rule ? { text: rule.off ? null : (rule.text ?? attached.text) } : attached
  })

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    const rule = ruleOf(`t:${e.tool}`)
    note(`t:${e.tool}`, { kind: 'tools', name: e.tool, text: described.description, deferred: (described.isDeferred ?? e.isDeferred) === true, source: e.provider.plugin })

    return {
      ...described,
      ...(rule?.text !== undefined ? { description: rule.text } : {}),
      ...(rule?.off ? { isDeferred: true } : {}),
    }
  })

  on('skill.prompt', async ($, e, next) => {
    const prompted = await next(e)
    const rule = ruleOf(`k:${e.skill}`)
    note(`k:${e.skill}`, { kind: 'skills', name: e.skill, text: prompted.text })

    return rule ? { text: rule.off ? '' : (rule.text ?? prompted.text) } : prompted
  })

  on('agent.offer', async ($, e, next) => {
    note(`a:${e.agent}`, { kind: 'agents', name: e.agent, text: e.description, source: e.source })

    return ruleOf(`a:${e.agent}`)?.off ? { isOffered: false } : next(e)
  })

  on('command.describe', async ($, e, next) => {
    const described = await next(e)
    const rule = ruleOf(`m:${e.command}`)
    note(`m:${e.command}`, { kind: 'commands', name: e.command, text: described.description, hidden: described.isHidden, source: e.provider.plugin })

    return {
      ...described,
      ...(rule?.text !== undefined ? { description: rule.text } : {}),
      ...(rule?.off ? { isHidden: true } : {}),
    }
  })
}
