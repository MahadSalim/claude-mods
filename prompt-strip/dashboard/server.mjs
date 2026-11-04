import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// The Claude config folder.
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const HOME = path.join(CONFIG, 'prompt-strip')
// What sessions loaded, as the mod records it, and the rules it applies.
const CATALOG = path.join(HOME, 'catalog.json')
const RULES = path.join(HOME, 'rules.json')
// The rules as they stood before the last write.
const PREVIOUS = path.join(HOME, 'rules.prev.json')
const PORT = Number(process.env.PORT) || 5199
// Host headers the server answers.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
// Characters of a request body the server reads.
const BODY_CHARS = 4_000_000
// Prefixes of the catalog ids a rule may name.
const RULE_ID = /^[scrtkam]:.+$/
const ADDED_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A JSON file's value, or the fallback when it is missing or holds no JSON. */
const readJson = (file, fallback) => fsp.readFile(file, 'utf8').then(JSON.parse, () => fallback)

/** A posted request's body as text, refused past BODY_CHARS. */
const body = request =>
  new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      text += chunk

      if (text.length > BODY_CHARS) {
        reject(new Error('body too large'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })

/** The rules a posted document holds, or undefined when it is not a rules document. */
const rulesOf = posted => {
  const { paused = false, rules = {}, order = null, added = [] } = posted ?? {}
  const isRule = ([id, rule]) =>
    RULE_ID.test(id) && rule && typeof rule === 'object' && ['off', 'text'].every(key => !(key in rule) || typeof rule[key] === (key === 'off' ? 'boolean' : 'string'))
  const isAdded = one => one && ADDED_ID.test(one.id) && typeof one.text === 'string' && (!('off' in one) || typeof one.off === 'boolean')
  const isValid =
    typeof paused === 'boolean' &&
    rules && typeof rules === 'object' && Object.entries(rules).every(isRule) &&
    (order === null || (Array.isArray(order) && order.every(id => typeof id === 'string'))) &&
    Array.isArray(added) && added.every(isAdded) && new Set(added.map(one => one.id)).size === added.length

  if (!isValid) {
    return undefined
  }

  const kept = Object.fromEntries(
    Object.entries(rules)
      .map(([id, { off, text }]) => [id, { ...(off ? { off: true } : {}), ...(text !== undefined ? { text } : {}) }])
      .filter(([, rule]) => Object.keys(rule).length),
  )

  return { paused, rules: kept, order, added: added.map(({ id, text, off }) => ({ id, text, ...(off ? { off: true } : {}) })) }
}

/** Writes the posted rules, keeping the ones before; or puts those back when the post asks to undo. Resolves whether it wrote. */
const write = async posted => {
  const before = await fsp.readFile(RULES, 'utf8').catch(() => '{}')

  if (posted?.undo) {
    const previous = await fsp.readFile(PREVIOUS, 'utf8').catch(() => undefined)

    if (previous === undefined) {
      return false
    }

    await fsp.writeFile(RULES, previous)
    await fsp.writeFile(PREVIOUS, before)

    return true
  }

  const next = rulesOf(posted)

  if (!next) {
    return false
  }

  await fsp.mkdir(HOME, { recursive: true })
  await fsp.writeFile(PREVIOUS, before)
  await fsp.writeFile(RULES, JSON.stringify(next, null, 2))

  return true
}

/** What the page draws: every loaded item, the latest system prompt's order, and the rules. */
const state = async () => {
  const [catalog, rules, previous] = await Promise.all([readJson(CATALOG, {}), readJson(RULES, {}), fsp.stat(PREVIOUS).catch(() => undefined)])

  return { generatedAt: Date.now(), items: catalog.items ?? {}, compose: catalog.compose ?? null, rules: rulesOf(rules) ?? rulesOf({}), canUndo: Boolean(previous), rulesPath: RULES }
}

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const send = (status, type, text) => response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }).end(text)
    const json = (status, value) => send(status, 'application/json', JSON.stringify(value))
    const { host, origin } = request.headers

    try {
      if (!HOSTS.has(host) || (origin && origin !== `http://${host}`)) {
        return json(403, { error: 'forbidden' })
      }

      if (request.method === 'POST') {
        if (url.pathname === '/api/stop') {
          return response.end('{}', () => process.exit())
        }

        const isJson = request.headers['content-type']?.startsWith('application/json')

        if (url.pathname === '/api/rules' && isJson) {
          return (await write(JSON.parse(await body(request)))) ? json(200, await state()) : json(400, { error: 'not a rules document' })
        }

        return json(404, { error: 'not found' })
      }

      if (url.pathname === '/api/ping') {
        return json(200, {})
      }

      if (url.pathname === '/api/state') {
        return json(200, await state())
      }

      return url.pathname === '/' ? send(200, 'text/html', await fsp.readFile(path.join(HERE, 'index.html'))) : json(404, { error: 'not found' })
    } catch (error) {
      return json(500, { error: String(error?.message ?? error) })
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`prompt-strip: http://127.0.0.1:${PORT}`))
