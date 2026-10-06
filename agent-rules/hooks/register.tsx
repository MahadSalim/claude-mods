import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Config, Mode, Preview, Snippet, Toggle } from '../types'

const PANE = 'mods'
// Fewest body columns at which the pane header shows "this session".
const SCOPE_COLUMNS = 42
const STORE = 'defaults'
const CONFIG = { plugin: 'agent-rules', key: 'config' } as const

const TOGGLES: Record<Toggle, string> = {
  rewrite: 'Rewrite',
  append: 'Append',
  ask: 'Ask tool',
  tasks: 'Tasks',
  context: 'Context cap',
}
const MODES: Record<Mode, string> = { default: 'Default', orchestrator: 'Orchestrator', noSubagents: 'No subagents' }
const ABOUT: Record<Toggle | Mode, string> = {
  default: 'The main agent chooses when to delegate.',
  orchestrator: 'The main agent delegates all work.',
  noSubagents: 'Blocks new subagents.',
  rewrite: 'Reworks each prompt with Haiku.',
  append: 'Adds the ticked snippets to each prompt.',
  ask: 'Turns a closing question into a dialog.',
  tasks: 'Keeps the turn going while tasks stay open.',
  context: 'Refuses large reads, so a subagent reads them.',
}
const IDS = Object.keys(TOGGLES) as Toggle[]
const MODE_IDS = Object.keys(MODES) as Mode[]

const TOOLS = ['Agent', 'SendMessage', 'AskUserQuestion', 'Tasks', 'Skill', 'ToolSearch', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']
// Tool names one setting entry stands for.
const GROUPS: Record<string, string[]> = {
  Agent: ['Agent', 'TaskOutput', 'TaskStop'],
  Tasks: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite'],
}
const MODELS = ['inherit', 'haiku', 'sonnet', 'opus']
const CAPS = Array.from({ length: 13 }, (_, i) => i)
const CTX = Array.from({ length: 20 }, (_, i) => (i + 1) * 5)

// Agent types this mod ships, and the model setting each one reads.
const ROLES: Record<string, 'reader' | 'editor'> = { 'agent-rules:reader': 'reader', 'agent-rules:editor': 'editor' }
const AGENTS = [
  {
    name: 'reader',
    description: 'Read-only work: find, read and summarise files or web pages. Changes nothing.',
    prompt: 'You read and report. Find what the task asks for, read it, and answer with the facts and their file paths. Change nothing.',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  },
  {
    name: 'editor',
    description: 'Work that changes files: write code, edit files, run commands.',
    prompt: 'You carry out one task that changes files. Make the change, verify it, and report what you changed.',
  },
]

const DEFAULTS: Config = {
  on: { rewrite: false, append: false, ask: false, tasks: false, context: false },
  mode: 'default',
  open: ['Agent', 'SendMessage', 'AskUserQuestion', 'Tasks', 'Skill', 'ToolSearch'],
  cap: 4,
  reader: 'haiku',
  editor: 'sonnet',
  other: 'inherit',
  apply: 'dialog',
  style: 'fix wording',
  hint: true,
  ctx: 25,
  slices: true,
  snippets: [],
}
const config = atom(CONFIG, DEFAULTS)
// Keys of the pane cards that show their settings.
const expanded = atom({ plugin: 'agent-rules', key: 'expanded' } as const, [] as string[])
// Values the UI draws in place of the session's.
const preview = atom({ plugin: 'agent-rules', key: 'preview' } as const, null as Preview | null)

/** What the UI draws: the session's values, with the preview's over them. */
const shown = async ($: EngineInterface) => {
  const seen = await read($, preview)
  const c = await read($, config)

  return {
    c: { ...c, ...seen?.config, on: { ...c.on, ...seen?.config?.on } },
    opened: seen?.expanded ?? (await read($, expanded)),
  }
}

/** How many toggles are on, plus one for a mode other than the default. */
const count = (c: Config) => IDS.filter(id => c.on[id]).length + Number(c.mode !== 'default')
const norm = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '')

/** Fills a stored config's missing keys from the defaults. A config stored with one flag per mode gets that mode. */
const merge = (stored: unknown): Config => {
  const kept = (stored ?? {}) as Partial<Omit<Config, 'on'>> & { on?: Partial<Record<Toggle | Mode, boolean>> }
  const mode = kept.mode ?? MODE_IDS.find(id => kept.on?.[id]) ?? DEFAULTS.mode

  return { ...DEFAULTS, ...kept, mode, on: Object.fromEntries(IDS.map(id => [id, kept.on?.[id] ?? DEFAULTS.on[id]])) as Config['on'] }
}

/** Flips one toggle for this session. Returns the line to show. */
const flip = async ($: EngineInterface, id: Toggle) => {
  const { on } = await read($, config)
  await update($, config, now => ({ ...now, on: { ...now.on, [id]: !now.on[id] } }))

  return `${TOGGLES[id]} ${on[id] ? 'off' : 'on'}.`
}

/** Changes the snippet list in this session and in the stored defaults. */
const editSnippets = async ($: EngineInterface, change: (list: Snippet[]) => Snippet[]) => {
  await update($, config, now => ({ ...now, snippets: change(now.snippets) }))
  const stored = merge(await $.store.get(STORE))
  await $.store.set(STORE, { ...stored, snippets: change(stored.snippets) })
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Mods', closeOnEscape: true })

/** Closes the pane when the surface shows it, opens it otherwise. */
const togglePane = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown) ? $.ui.close({ id: PANE }) : openPane($)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { version } = await $.state.get(CONFIG)

    if (version === 0) {
      await $.state.set(CONFIG, merge(await $.store.get(STORE)))
    }

    await $.command.register({ name: 'mods', description: 'Toggle a mod, or open the mods pane', argumentHint: '[mod]' })
    await Promise.all(AGENTS.map(spec => $.agent.register(spec)))
    await $.tool.register({
      name: 'ui_test',
      description:
        'Test only. Sets what the UI draws, never the session: `preview` holds the values to draw (null clears it), `pane` opens or closes the pane, `toast` shows a toast.',
      inputSchema: {
        type: 'object',
        properties: { preview: { type: ['object', 'null'] }, pane: { enum: ['open', 'close'] }, toast: { type: 'string' } },
      },
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__agent-rules__ui_test' }, async ($, e) => {
    const { preview: seen, pane, toast } = e

    if (seen !== undefined) {
      await update($, preview, () => seen)
    }

    if (pane) {
      await (pane === 'open' ? openPane($) : $.ui.close({ id: PANE }))
    }

    if (toast) {
      $.ui.toast(toast)
    }

    return { result: JSON.stringify({ panes: await $.ui.panes(), preview: await read($, preview) }) }
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const asked = norm(e.args)
    /** The key of `names` whose key or label was asked for. */
    const named = <T extends string>(names: Record<T, string>) =>
      (Object.keys(names) as T[]).find(one => norm(one) === asked || norm(names[one]) === asked)
    const id = named(TOGGLES)
    const mode = named(MODES)

    if (id) {
      return { text: await flip($, id) }
    }

    if (mode) {
      const picked = (await read($, config)).mode === mode ? DEFAULTS.mode : mode
      await update($, config, now => ({ ...now, mode: picked }))

      return { text: `Delegation: ${MODES[picked]}.` }
    }

    if (asked) {
      return { text: `Unknown mod. Use one of: ${Object.values({ ...MODES, ...TOGGLES }).join(', ')}.` }
    }

    await openPane($)

    return { text: 'Mods pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const c = await read($, config)
    const note = c.mode === 'orchestrator'
      ? `Orchestrator mode is on. Delegate all work to subagents with the Agent tool. You may call only these tools yourself: ${c.open.join(', ')}.`
      : c.mode === 'noSubagents'
        ? 'No-subagents mode is on. Do not start new subagents. SendMessage to an existing subagent still works.'
        : undefined

    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  on('tool.call', async ($, e, next) => {
    const c = await read($, config)
    const isMain = e.agentId === undefined && next.origin.plugin === 'engine'
    const isOpen = c.open.some(name => (GROUPS[name] ?? [name]).includes(e.tool))

    return c.mode === 'orchestrator' && isMain && !isOpen
      ? { deny: `${$.plugin.name}: Orchestrator mode is on. The main agent may not call ${e.tool}. Delegate this work to a subagent with the Agent tool.` }
      : next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const c = await read($, config)

    if (c.mode === 'noSubagents') {
      return { deny: `${$.plugin.name}: No-subagents mode is on. Do the work yourself, or SendMessage an existing subagent.` }
    }

    const agents = c.cap ? await $.agent.list() : []

    if (c.cap && agents.length >= c.cap) {
      const names = agents.map(agent => agent.name ?? agent.id).join(', ')

      return { deny: `${$.plugin.name}: This session reached its cap of ${c.cap} subagents. Reuse one with SendMessage: ${names}.` }
    }

    const model = c[ROLES[e.subagentType] ?? 'other']

    return next(model === 'inherit' || e.fork ? e : { ...e, model })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'mobile' || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
    const { c } = await shown($)

    return (
      <Box flexDirection="row" justifyContent="flex-end">
        <Button key="mods" label={`Mods · ${count(c)} on`} onPress={() => togglePane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') {
      return next(e)
    }

    const { Box, Button, Input, Markdown, Select, Text } = $.ui.resolve(e)
    const { c, opened } = await shown($)
    const gap = e.surface === 'desktop' ? 1 : 0
    /** Merges a patch, or what `patch` makes of the session's config, into that config. */
    const set = (patch: Partial<Config> | ((now: Config) => Partial<Config>)) =>
      update($, config, now => ({ ...now, ...(typeof patch === 'function' ? patch(now) : patch) }))
    const blocked = TOOLS.filter(tool => !c.open.includes(tool))
    const row = (left: JSX.Element, right: JSX.Element) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
        {left}
        {right}
      </Box>
    )
    /** One card: title and description left, its buttons right, its settings beneath while expanded. */
    const card = (key: string, name: string, about: string, owned: JSX.Element[], ...buttons: JSX.Element[]) => {
      const isOpen = opened.includes(key)
      const more = (
        <Button
          key={`more:${key}`}
          label={isOpen ? '▾' : '▸'}
          onPress={() => update($, expanded, list => (isOpen ? list.filter(one => one !== key) : [...list, key]))}
        />
      )

      return (
        <Box flexDirection="column" rowGap={1} borderStyle="round" borderDimColor paddingX={1}>
          {row(
            <Box flexGrow={1} flexShrink={1}>
              <Markdown text={`### ${name}\n\n${about}`} />
            </Box>,
            <Box flexDirection="row" columnGap={1}>
              {owned.length ? [more, ...buttons] : buttons}
            </Box>,
          )}
          {isOpen
            ? [
                <Box flexDirection="column" rowGap={gap}>
                  {owned}
                </Box>,
              ]
            : []}
        </Box>
      )
    }
    /** The card of one session toggle. */
    const mod = (id: Toggle, ...owned: JSX.Element[]) =>
      card(
        id,
        TOGGLES[id],
        ABOUT[id],
        owned,
        <Button
          key={id}
          label={c.on[id] ? '●' : '○'}
          variant={c.on[id] ? 'primary' : 'secondary'}
          dimColor={!c.on[id]}
          onPress={() => flip($, id)}
        />,
      )
    const setting = (key: 'hint' | 'slices', label: string) =>
      row(
        <Text>{label}</Text>,
        <Button key={key} label={c[key] ? '✓ On' : 'Off'} dimColor={!c[key]} onPress={() => set(now => ({ [key]: !now[key] }))} />,
      )
    type Choice = 'mode' | 'cap' | 'reader' | 'editor' | 'other' | 'apply' | 'style' | 'ctx'
    type Value = string | number
    /** The dropdown of one setting. */
    const pick = (key: Choice, values: readonly Value[], show: (value: Value) => string = String) => (
      <Select
        key={key}
        value={String(c[key])}
        options={values.map(value => ({ value: String(value), label: show(value) }))}
        onSelect={value => set({ [key]: typeof c[key] === 'number' ? Number(value) : value } as Partial<Config>)}
      />
    )
    const choice = (key: Choice, label: string, values: readonly Value[], show?: (value: Value) => string) =>
      row(<Text>{label}</Text>, pick(key, values, show))

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column" paddingX={1}>
          {row(
            <Box flexDirection="row" columnGap={1}>
              <Text bold>{`${count(c)} of ${IDS.length + 1} on`}</Text>
              {e.props.bodyColumns < SCOPE_COLUMNS ? [] : [<Text dimColor>this session</Text>]}
            </Box>,
            <Button
              key="save"
              label="Save as default"
              onPress={async () => {
                await $.store.set(STORE, await read($, config))
                $.ui.toast('Saved as default.')
              }}
            />,
          )}
        </Box>

        {card(
          'delegation',
          'Delegation',
          ABOUT[c.mode],
          [
            ...(c.mode === 'orchestrator'
              ? [
                  row(
                    <Text>May call</Text>,
                    blocked.length ? (
                      <Select
                        key="open"
                        value=""
                        options={[{ value: '', label: 'Add a tool' }, ...blocked.map(value => ({ value }))]}
                        onSelect={tool => tool && set(now => ({ open: [...now.open, tool] }))}
                      />
                    ) : (
                      <Text dimColor>every tool</Text>
                    ),
                  ),
                  <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={gap}>
                    {TOOLS.filter(tool => c.open.includes(tool)).map(tool => (
                      <Button
                        key={`open:${tool}`}
                        label={`${tool} ✕`}
                        onPress={() => set(now => ({ open: now.open.filter(one => one !== tool) }))}
                      />
                    ))}
                  </Box>,
                ]
              : []),
            choice('cap', 'Cap', CAPS, value => (value ? String(value) : 'off')),
            choice('reader', 'Reader model', MODELS),
            choice('editor', 'Editor model', MODELS),
            choice('other', 'Other model', MODELS),
          ],
          pick('mode', MODE_IDS, id => MODES[id as Mode]),
        )}

        {mod('rewrite', choice('apply', 'Apply', ['dialog', 'direct']), choice('style', 'Style', ['fix wording', 'expand']))}

        {mod(
          'append',
          ...c.snippets.map(({ text, isOn }, i) =>
            row(
              <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1}>
                <Button
                  key={`snippet:${i}`}
                  label={isOn ? '✓' : '○'}
                  dimColor={!isOn}
                  onPress={() => set(now => ({ snippets: now.snippets.map(one => (one.text === text ? { ...one, isOn: !one.isOn } : one)) }))}
                />
                <Box flexShrink={1}>
                  <Text dimColor={!isOn}>{text}</Text>
                </Box>
              </Box>,
              <Button key={`drop:${i}`} label="✕" dimColor onPress={() => editSnippets($, list => list.filter(one => one.text !== text))} />,
            ),
          ),
          <Box flexDirection="row" justifyContent="flex-end">
            <Input
              key="snippet"
              placeholder="Add a snippet"
              submitLabel="add"
              value=""
              onSubmit={typed => {
                const text = typed.trim()

                if (text) {
                  void editSnippets($, list => [...list.filter(one => one.text !== text), { text, isOn: true }])
                }
              }}
            />
          </Box>,
        )}

        {mod('ask', setting('hint', 'Hidden hint'))}

        {mod('tasks')}

        {mod('context', choice('ctx', 'Token cap per read', CTX, value => `${value}k`), setting('slices', 'Slices under cap'))}
      </Box>
    )
  })
}
