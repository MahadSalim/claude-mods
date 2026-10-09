import type { EngineInterface, Register } from 'claude-code'

// Characters one log file holds before the next file starts.
const FILE_CHARS = 64_000
// The dashboard's log folder, from the Claude config folder.
const EVENTS = 'usage-log/events'
// The dashboard's address.
const DASHBOARD = 'http://127.0.0.1:5198'
// The slash command that turns the dashboard on and off.
const COMMAND = 'usage-dashboard'
// A node script that starts the script named after it as a process of its own.
const DETACH = "require('child_process').spawn(process.execPath,[process.argv[1]],{detached:true,stdio:'ignore',windowsHide:true}).unref()"

type Log = { id: string; path: string; text: string; written: number }

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

let config: Promise<string> | undefined
let log: Log | undefined
let files = 0
let writing = Promise.resolve()

/** Adds one row to the session's log file. */
const record = async ($: EngineInterface, ev: string, fields: object) => {
  const [id, at, root] = await Promise.all([$.session.id(), $.clock.now(), (config ??= configDir($))])

  if (log?.id !== id || log.text.length > FILE_CHARS) {
    log = { id, path: `${root}/${EVENTS}/${id}.${at}-${files++}.jsonl`, text: '', written: 0 }
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [model, { version }] = await Promise.all([$.session.model(), $.session.version()])
    await record($, 'session.start', { ...e, model, version, usage: await usage($) })
    await $.command.register({ name: COMMAND, description: 'Turns the usage dashboard on or off.', argumentHint: '[auto]' })

    if ((await isAuto($)) && !(await isUp($))) {
      await start($)
    }

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
    await record($, 'turn.start', { turnId: e.turnId, usage: await usage($) })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    const { turnId, agentId, reason, durationMs, usage: tokens } = e
    await record($, 'turn.end', { turnId, agentId, reason, durationMs, tokens, usage: await usage($) })

    return answered
  })

  on('session.measure', async ($, e, next) => {
    const { changed, ...measured } = e
    await record($, 'measure', { changed, usage: measured })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    const outcome = result.deny !== undefined ? 'denied' : result.isError ? 'error' : 'ok'
    await record($, 'tool', { tool: e.tool, id: e.tool_use_id, agentId: e.agentId, startedAt, outcome })

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const { messages, ...counts } = result
    await record($, 'compact', { trigger: e.trigger, agentId: e.agentId, ...counts })

    return result
  })

  on('session.end', async ($, e, next) => {
    await record($, 'session.end', { reason: e.reason, usage: await usage($) })

    return next(e)
  })
}
