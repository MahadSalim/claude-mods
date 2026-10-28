import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { LaunchConfiguration, Page, PageLink, PageMode, PaneView, ServerState, Snapshot, Tab } from '../types'

const PANE = 'browser'
const TITLE = 'Browser'
const COMMAND = 'browser'
const LAUNCH_FILE = '.claude/launch.json'
const LOG_LINES = 200
const MAX_BODY = 90_000
const MAX_LINKS = 200
const PROBE_MS = 5000
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SNAPSHOT_WIDTH = 1280
const SNAPSHOT_HEIGHT = 800
const SNAPSHOT_TIMEOUT_MS = 60_000

const tabsAtom = atom({ plugin: 'browser-pane', key: 'tabs' } as const, [] as Tab[], { shape: 'tabs-1' })
const activeAtom = atom({ plugin: 'browser-pane', key: 'active' } as const, '', { shape: 'active-1' })
const pagesAtom = atom({ plugin: 'browser-pane', key: 'pages' } as const, {} as Record<string, Page>, {
  shape: 'pages-1',
})
const serversAtom = atom({ plugin: 'browser-pane', key: 'servers' } as const, {} as Record<string, ServerState>, {
  shape: 'servers-1',
})
const viewAtom = atom(
  { plugin: 'browser-pane', key: 'view' } as const,
  { logsFor: null, isConfigShown: false, isLinksShown: false } as PaneView,
  { shape: 'view-1' },
)
const modeAtom = atom({ plugin: 'browser-pane', key: 'mode' } as const, 'snapshot' as PageMode, { shape: 'mode-1' })
const snapshotsAtom = atom(
  { plugin: 'browser-pane', key: 'snapshots' } as const,
  {} as Record<string, Snapshot>,
  { shape: 'snapshots-1' },
)

type $ = EngineInterface
type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

/** Running dev-server children by configuration name. */
const children = new Map<string, Child>()
/** Names of servers being stopped by the person. */
const stopping = new Set<string>()
/** The pane's width budget as last drawn. */
let paneColumns = 68

const newId = () => crypto.randomUUID().slice(0, 8)

const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

const joinPath = (base: string, rel: string | undefined) => {
  if (!rel || rel === '.') return base
  if (isWindowsPath(rel) || rel.startsWith('/')) return rel
  const sep = isWindowsPath(base) ? '\\' : '/'
  const trimmed = rel.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)
  return base.replace(/[\\/]+$/, '') + sep + trimmed
}

const clean = (text: string) =>
  text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const currentUrl = (tab: Tab | undefined) => (tab ? (tab.history[tab.index] ?? '') : '')

/** Turns what was typed in the address field into a URL. */
const normalizeUrl = (input: string) => {
  const text = input.trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (/^:\d+/.test(text)) return `http://localhost${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(text)}`
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', middot: '·', bull: '•', times: '×', raquo: '»',
  laquo: '«', larr: '←', rarr: '→', uarr: '↑', darr: '↓', deg: '°',
  euro: '€', pound: '£', yen: '¥', cent: '¢', para: '¶', sect: '§',
  shy: '', zwj: '', zwnj: '', thinsp: ' ', ensp: ' ', emsp: ' ',
}

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') : undefined
}

const absolute = (href: string, base: string) => {
  try {
    return new URL(href, base).href
  } catch {
    return undefined
  }
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '')

const escapeLinkText = (text: string) => text.replace(/([[\]])/g, '\\$1')

/** Converts an HTML document to readable Markdown and the links it holds. */
export const htmlToMarkdown = (html: string, base: string) => {
  const links: PageLink[] = []
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1] ?? '')).replace(/\s+/g, ' ').trim() : ''

  let body = html
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html) ?? /<body[^>]*>([\s\S]*)$/i.exec(html)
  if (bodyMatch) body = bodyMatch[1] ?? ''
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript|template|iframe|canvas|object|head|math)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|link|meta|input|button|select|textarea)\b[^>]*>/gi, '')

  const blocks: string[] = []
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, '\n'))).replace(/\n+$/, '')
    blocks.push('\n\n```\n' + code.replace(/```/g, '`​``') + '\n```\n\n')
    return `${blocks.length - 1}`
  })

  body = body.replace(/\s+/g, ' ')

  body = body.replace(/<img\b[^>]*>/gi, tag => {
    const alt = (attr(tag, 'alt') ?? '').trim()
    return alt ? ` _${alt.replace(/[_*]/g, '')}_ ` : ''
  })

  body = body.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim()
    const raw = attr(` ${attrs}`, 'href')
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(raw)) return text
    const href = absolute(raw, base)
    if (!href || !/^https?:/i.test(href)) return text
    const label = text || href
    if (links.length < MAX_LINKS) links.push({ text: label, href })
    return ` [${escapeLinkText(label)}](${href.replace(/[<>()\s]/g, char => encodeURIComponent(char).replace('(', '%28').replace(')', '%29'))}) `
  })

  body = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
      const text = stripTags(inner).trim()
      return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : ''
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, inner: string) => {
      const text = inner.trim()
      return text && !/<(div|p|li|h\d)\b/i.test(text) ? ` **${text}** ` : inner
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner: string) => {
      const text = stripTags(inner).trim()
      return text ? ` \`${text.replace(/`/g, "'")}\` ` : ''
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(ul|ol)\s*>/gi, '\n\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<\/(td|th)\s*>/gi, ' · ')
    .replace(/<\/?(p|blockquote|figure|figcaption|table|dl)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?(div|section|article|header|footer|nav|main|aside|tr|dt|dd|form|fieldset|details|summary|label)\b[^>]*>/gi, '\n')

  let text = decodeEntities(stripTags(body))
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').replace(/ ·\s*$/, '').trim())
    .map(line => (/^-\s*$/.test(line) ? '' : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\d+)/g, (_, index: string) => blocks[Number(index)] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (title && !text.startsWith(`# ${title}`)) text = `# ${title}\n\n${text}`
  return { title, text: clean(text), links }
}

const languageOf = (contentType: string, url: string) => {
  const type = contentType.toLowerCase()
  if (type.includes('javascript')) return 'javascript'
  if (type.includes('css')) return 'css'
  if (type.includes('xml')) return 'xml'
  if (type.includes('markdown')) return 'markdown'
  if (type.includes('yaml')) return 'yaml'
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]
  return ext ? ext.toLowerCase() : undefined
}

const formatBytes = (count: number) =>
  count < 1024 ? `${count} B` : count < 1024 * 1024 ? `${(count / 1024).toFixed(1)} KB` : `${(count / 1048576).toFixed(1)} MB`

const cap = (text: string) =>
  text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n\n... ${text.length - MAX_BODY} more characters not shown` : text

/** Fetches a URL, following redirects, and turns the answer into a Page. */
const fetchPage = async ($: $, url: string): Promise<Page> => {
  let target = url
  for (let hop = 0; hop < 6; hop++) {
    const res = await $.http.fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClaudeCodeBrowserPane/0.1)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    })
    const location = res.headers.location
    if (res.status >= 300 && res.status < 400 && location) {
      target = absolute(location, target) ?? location
      continue
    }
    const contentType = res.headers['content-type'] ?? ''
    const raw = res.text
    const base: Page = { url, status: 'done', code: res.status, contentType, bytes: raw.length }
    const looksHtml = /html/i.test(contentType) || (!contentType && /^\s*(<!doctype html|<html)/i.test(raw))
    if (looksHtml) {
      const { title, text, links } = htmlToMarkdown(raw, target)
      return { ...base, kind: 'markdown', title: title || undefined, body: cap(text || '_This page has no readable text._'), links }
    }
    if (/json/i.test(contentType) || /^\s*[[{]/.test(raw)) {
      try {
        return { ...base, kind: 'json', language: 'json', body: cap(JSON.stringify(JSON.parse(raw), null, 2)) }
      } catch {
        /* falls through to text */
      }
    }
    if (/^(image|audio|video|font)\/|octet-stream|zip|pdf/i.test(contentType)) {
      return { ...base, kind: 'text', body: `Binary content (${contentType}). Use Open externally to view it.` }
    }
    return { ...base, kind: 'text', language: languageOf(contentType, target), body: cap(clean(raw)) }
  }
  throw new Error('Too many redirects')
}

const setPage = ($: $, tabId: string, page: Page) =>
  update($, pagesAtom, pages => ({ ...pages, [tabId]: page }))

/** Loads the tab's current URL into its page. */
const load = async ($: $, tabId: string) => {
  const tab = (await read($, tabsAtom)).find(one => one.id === tabId)
  const url = currentUrl(tab)
  if (!url) {
    await update($, pagesAtom, pages => {
      const { [tabId]: _, ...rest } = pages
      return rest
    })
    void probeAll($)
    return
  }
  await setPage($, tabId, { url, status: 'loading' })
  let page: Page
  try {
    page = await fetchPage($, url)
  } catch (error) {
    page = { url, status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
  await update($, pagesAtom, pages => (pages[tabId]?.url === url ? { ...pages, [tabId]: page } : pages))
  if (page.status === 'done' && /^https?:/i.test(url) && (await read($, modeAtom)) === 'snapshot') {
    void capture($, tabId, url, paneColumns)
  }
}

const navigate = async ($: $, tabId: string, input: string) => {
  const url = input === '' ? '' : normalizeUrl(input)
  await update($, tabsAtom, tabs =>
    tabs.map(tab =>
      tab.id === tabId ? { ...tab, history: [...tab.history.slice(0, tab.index + 1), url].slice(-50), index: Math.min(tab.index + 1, 49) } : tab,
    ),
  )
  await update($, viewAtom, view => ({ ...view, isLinksShown: false }))
  await load($, tabId)
}

const step = async ($: $, tabId: string, delta: number) => {
  let moved = false
  await update($, tabsAtom, tabs =>
    tabs.map(tab => {
      if (tab.id !== tabId) return tab
      const index = tab.index + delta
      if (index < 0 || index >= tab.history.length) return tab
      moved = true
      return { ...tab, index }
    }),
  )
  if (moved) await load($, tabId)
}

const ensureTab = async ($: $) => {
  const tabs = await read($, tabsAtom)
  if (tabs.length > 0) {
    const active = await read($, activeAtom)
    if (!tabs.some(tab => tab.id === active)) await update($, activeAtom, () => tabs[0]!.id)
    return
  }
  const id = newId()
  await update($, tabsAtom, () => [{ id, history: [''], index: 0 }])
  await update($, activeAtom, () => id)
}

const addTab = async ($: $, url = '') => {
  const id = newId()
  await update($, tabsAtom, tabs => [...tabs, { id, history: [''], index: 0 }])
  await update($, activeAtom, () => id)
  if (url) await navigate($, id, url)
  else void probeAll($)
  return id
}

const closeTab = async ($: $, tabId: string) => {
  const tabs = await read($, tabsAtom)
  const at = tabs.findIndex(tab => tab.id === tabId)
  const rest = tabs.filter(tab => tab.id !== tabId)
  if (rest.length === 0) rest.push({ id: newId(), history: [''], index: 0 })
  await update($, tabsAtom, () => rest)
  await update($, activeAtom, active => (active === tabId ? rest[Math.max(0, Math.min(at, rest.length - 1))]!.id : active))
  await update($, pagesAtom, pages => {
    const { [tabId]: _, ...others } = pages
    return others
  })
  await update($, snapshotsAtom, snaps => {
    const { [tabId]: _, ...others } = snaps
    return others
  })
}

const readLaunch = async ($: $): Promise<{ configs: LaunchConfiguration[]; raw?: string; error?: string }> => {
  const path = joinPath(await $.session.cwd(), LAUNCH_FILE)
  if (!(await $.fs.exists(path))) return { configs: [] }
  let raw = ''
  try {
    raw = await $.fs.read(path)
    const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { configurations?: unknown }
    const list = Array.isArray(parsed.configurations) ? parsed.configurations : []
    const configs = list.filter(
      (one): one is LaunchConfiguration =>
        typeof one === 'object' && one !== null && typeof (one as LaunchConfiguration).name === 'string' &&
        typeof (one as LaunchConfiguration).runtimeExecutable === 'string',
    )
    return { configs, raw }
  } catch (error) {
    return { configs: [], raw, error: error instanceof Error ? error.message : String(error) }
  }
}

const setServer = ($: $, name: string, fn: (state: ServerState) => ServerState) =>
  update($, serversAtom, servers => ({ ...servers, [name]: fn(servers[name] ?? { status: 'stopped', logs: [] }) }))

const appendLogs = (logs: string[], lines: string[]) => [...logs, ...lines].slice(-LOG_LINES)

const probe = async ($: $, port: number) => {
  const timeout = $.clock.sleep(1500).then(() => false)
  const hit = $.http
    .fetch(`http://localhost:${port}/`, { method: 'HEAD' })
    .then(() => true)
    .catch(() => false)
  return Promise.race([hit, timeout])
}

/** Refreshes which configured servers answer on their ports. */
const probeAll = async ($: $) => {
  const { configs } = await readLaunch($)
  for (const config of configs) {
    if (typeof config.port !== 'number') continue
    const isUp = await probe($, config.port)
    const servers = await read($, serversAtom)
    const state = servers[config.name] ?? { status: 'stopped', logs: [] }
    let next: ServerState = state
    if (children.has(config.name)) {
      if (state.isListening !== isUp) next = { ...state, isListening: isUp }
    } else if (isUp && state.status !== 'external') {
      next = { ...state, status: 'external', isListening: true }
    } else if (!isUp && (state.status === 'external' || state.status === 'running')) {
      next = { ...state, status: 'stopped', isListening: false }
    }
    if (next !== state) await setServer($, config.name, () => next)
  }
}

const isWindows = async ($: $) => isWindowsPath(await $.session.cwd())

const startServer = async ($: $, config: LaunchConfiguration) => {
  if (children.has(config.name)) return
  const project = await $.session.cwd()
  const cwd = joinPath(project, config.cwd)
  let argv = [config.runtimeExecutable, ...(config.runtimeArgs ?? [])]
  if ((await isWindows($)) && /^(npm|npx|yarn|pnpm|bun[x]?)$/i.test(config.runtimeExecutable)) {
    argv = ['cmd', '/d', '/s', '/c', ...argv]
  }
  const child = $.process.spawn({ argv, cwd, env: config.env })
  children.set(config.name, child)
  stopping.delete(config.name)
  await setServer($, config.name, state => ({
    status: 'running',
    isListening: false,
    logs: appendLogs(state.logs, [`$ ${argv.join(' ')}  (in ${cwd})`]),
  }))
  void (async () => {
    const partial: Record<string, string> = { stdout: '', stderr: '' }
    try {
      for await (const { stream, text } of child) {
        const lines = (partial[stream] + clean(text)).split('\n')
        partial[stream] = lines.pop() ?? ''
        if (lines.length > 0) await setServer($, config.name, state => ({ ...state, logs: appendLogs(state.logs, lines) }))
      }
      const tail = [partial.stdout, partial.stderr].filter((line): line is string => !!line)
      const { code } = await child.result
      await setServer($, config.name, state => ({
        ...state,
        status: stopping.has(config.name) ? 'stopped' : 'exited',
        code,
        isListening: false,
        logs: appendLogs(state.logs, [...tail, `[exited with code ${code ?? 'signal'}]`]),
      }))
    } catch (error) {
      const isStopped = stopping.has(config.name)
      await setServer($, config.name, state => ({
        ...state,
        status: isStopped ? 'stopped' : 'failed',
        isListening: false,
        logs: appendLogs(state.logs, [isStopped ? '[stopped]' : `[failed: ${error instanceof Error ? error.message : String(error)}]`]),
      }))
    } finally {
      if (children.get(config.name) === child) children.delete(config.name)
      stopping.delete(config.name)
    }
  })()
  if (typeof config.port === 'number') {
    $.clock.after(2500, () => void probeAll($).catch(() => undefined))
  }
}

const stopServer = async ($: $, name: string) => {
  const child = children.get(name)
  if (!child) {
    await setServer($, name, state => ({ ...state, status: 'stopped', isListening: false }))
    return
  }
  stopping.add(name)
  await child.return({ code: null, signal: null }).catch(() => undefined)
}

const openExternally = async ($: $, url: string) => {
  if (!url) return
  const argv = (await isWindows($))
    ? ['rundll32', 'url.dll,FileProtocolHandler', url]
    : ['sh', '-c', 'command -v xdg-open >/dev/null && exec xdg-open "$1" || exec open "$1"', 'sh', url]
  try {
    const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: 10_000 })
    if (exitCode !== 0) $.ui.toast(`Could not open ${url}: ${stderr.trim() || `exit ${exitCode}`}`)
  } catch (error) {
    $.ui.toast(`Could not open ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * PowerShell that screenshots `BP_URL` with headless Edge (`BP_EDGE`), scales it
 * to `BP_COLS` x `BP_ROWS * 2` pixels and prints their RGB bytes as base64.
 */
const SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not (Test-Path -LiteralPath $env:BP_EDGE)) { [Console]::Error.Write('Microsoft Edge is not installed'); exit 2 }
$dir = Join-Path $env:TEMP 'claude-browser-pane'
New-Item -ItemType Directory -Force $dir | Out-Null
$png = Join-Path $dir ([guid]::NewGuid().ToString('N') + '.png')
$url = $env:BP_URL -replace '"', '%22'
$argv = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', ('--window-size=' + $env:BP_SIZE), '--virtual-time-budget=3000', ('--user-data-dir="' + $dir + '\profile"'), ('--screenshot="' + $png + '"'), ('"' + $url + '"'))
$p = Start-Process -FilePath $env:BP_EDGE -ArgumentList $argv -PassThru -WindowStyle Hidden
if (-not $p.WaitForExit(40000)) { try { $p.Kill() } catch {}; [Console]::Error.Write('Edge timed out'); exit 3 }
if (-not (Test-Path -LiteralPath $png)) { [Console]::Error.Write('Edge wrote no screenshot'); exit 4 }
Add-Type -AssemblyName System.Drawing
$w = [int]$env:BP_COLS; $h = [int]$env:BP_ROWS * 2
$fmt = [System.Drawing.Imaging.PixelFormat]::Format24bppRgb
$src = [System.Drawing.Image]::FromFile($png)
$bmp = New-Object System.Drawing.Bitmap $w, $h, $fmt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, 0, 0, $w, $h)
$g.Dispose(); $src.Dispose()
Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
$data = $bmp.LockBits((New-Object System.Drawing.Rectangle 0, 0, $w, $h), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $fmt)
$stride = $data.Stride
$raw = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
$bmp.UnlockBits($data); $bmp.Dispose()
$out = New-Object byte[] ($w * $h * 3)
$i = 0
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x++) {
    $o = $row + $x * 3
    $out[$i] = $raw[$o + 2]; $out[$i + 1] = $raw[$o + 1]; $out[$i + 2] = $raw[$o]
    $i += 3
  }
}
[Console]::Out.Write([Convert]::ToBase64String($out))
`

/** The script as PowerShell's `-EncodedCommand` takes it: UTF-16LE in base64. */
const encodedScript = (() => {
  let binary = ''
  for (const char of SNAPSHOT_SCRIPT) {
    const code = char.charCodeAt(0)
    binary += String.fromCharCode(code & 0xff, code >> 8)
  }
  return btoa(binary)
})()

/** Rows of `▀` cells that show a page at `columns` wide in its aspect ratio. */
export const snapshotRows = (columns: number) =>
  Math.min(256, Math.max(1, Math.round((columns * SNAPSHOT_HEIGHT) / SNAPSHOT_WIDTH / 2)))

/** Packs RGB pixels, `columns` x `rows * 2`, into Raster cells of `▀`. */
export const pixelsToCells = (rgb: Uint8Array, columns: number, rows: number) => {
  const words = new Uint32Array(columns * rows * 3)
  const color = (pixel: number) => ((rgb[pixel * 3] ?? 0) << 16) | ((rgb[pixel * 3 + 1] ?? 0) << 8) | (rgb[pixel * 3 + 2] ?? 0)
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const at = (row * columns + x) * 3
      words[at] = 0x2580
      words[at + 1] = color(row * 2 * columns + x)
      words[at + 2] = color((row * 2 + 1) * columns + x)
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

const decodeBase64 = (text: string) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
  return bytes
}

/** The readable part of PowerShell's standard error, CLIXML included. */
const powershellError = (stderr: string) => {
  if (!stderr.startsWith('#< CLIXML')) return stderr.trim()
  const parts = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(match => match[1] ?? '')
  return decodeEntities(parts.join('').replace(/_x000D_|_x000A_/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Screenshots `url` with headless Edge and returns it as Raster cells. */
const renderSnapshot = async ($: $, url: string, columns: number, rows: number) => {
  if (!(await isWindows($))) throw new Error('snapshots need Microsoft Edge on Windows')
  if (!(await $.fs.exists(EDGE))) throw new Error('Microsoft Edge is not installed')
  const { exitCode, stdout, stderr } = await $.process.run(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript],
    {
      env: {
        BP_EDGE: EDGE,
        BP_URL: url,
        BP_SIZE: `${SNAPSHOT_WIDTH},${SNAPSHOT_HEIGHT}`,
        BP_COLS: String(columns),
        BP_ROWS: String(rows),
      },
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    },
  )
  if (exitCode !== 0) throw new Error(powershellError(stderr) || `capture exited with code ${exitCode}`)
  const pixels = decodeBase64(stdout.trim())
  if (pixels.length !== columns * rows * 2 * 3) throw new Error('the capture returned an unexpected image size')
  return pixelsToCells(pixels, columns, rows)
}

/** Snapshot captures waiting or running, by tab, URL and width. */
const capturing = new Set<string>()
/** The chain that runs captures one at a time. */
let captureQueue: Promise<unknown> = Promise.resolve()

/** Queues a snapshot of `url` for the tab at `columns` wide. */
const capture = async ($: $, tabId: string, url: string, columns: number) => {
  const key = `${tabId} ${columns} ${url}`
  if (capturing.has(key)) return
  capturing.add(key)
  const rows = snapshotRows(columns)
  const pending: Snapshot = { url, columns, rows, status: 'rendering' }
  await update($, snapshotsAtom, snaps => ({ ...snaps, [tabId]: pending }))
  const isCurrent = (snap: Snapshot | undefined) => snap?.url === url && snap.columns === columns
  const job = captureQueue.then(async () => {
    try {
      if (!isCurrent((await read($, snapshotsAtom))[tabId])) return
      let next: Snapshot
      try {
        next = { url, columns, rows, status: 'done', cells: await renderSnapshot($, url, columns, rows) }
      } catch (error) {
        next = { url, columns, rows, status: 'error', error: error instanceof Error ? error.message : String(error) }
      }
      await update($, snapshotsAtom, snaps => (isCurrent(snaps[tabId]) ? { ...snaps, [tabId]: next } : snaps))
    } finally {
      capturing.delete(key)
    }
  }).catch(() => undefined)
  captureQueue = job
  await job
}

const openPane = ($: $, focus: boolean) =>
  $.ui.open(focus ? { id: PANE, title: TITLE, focus: true, columns: 80 } : { id: PANE, title: TITLE, columns: 80 })

const tabLabel = (tab: Tab, page: Page | undefined) => {
  const url = currentUrl(tab)
  if (!url) return 'New tab'
  if (page?.status === 'loading') return 'Loading...'
  const name = page?.title || (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  return name.length > 18 ? `${name.slice(0, 17)}…` : name
}

/** The Pane input with the frame's two columns taken from its body. */
function inset(e: RenderInput<'Pane'>): RenderInput<'Pane'> {
  if (e.props.placement !== 'dock') return e
  return { ...e, props: { ...e.props, bodyColumns: e.props.bodyColumns - 2 } } as RenderInput<'Pane'>
}

/** Wraps a docked pane's body in a rounded frame that fills the dock. */
function framed($: EngineInterface, e: RenderInput<'Pane'>, body: RenderElement): RenderElement {
  if (e.props.placement !== 'dock') return body
  const { Box } = $.ui.resolve(e)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="promptBorder"
      minHeight={e.props.scroll.bodyRows}
    >
      {body}
    </Box>
  )
}

/** Draws the pane's body. */
const drawPane = async ($: EngineInterface, e: RenderInput<'Pane'>) => {
  const table = $.ui.resolve(e)
  const { Box, Text, Button, Code, Markdown } = table
  const Input = 'Input' in table ? table.Input : undefined
  const Raster = 'Raster' in table ? table.Raster : undefined
  const tabs = await read($, tabsAtom)
  const activeId = await read($, activeAtom)
  const pages = await read($, pagesAtom)
  const view = await read($, viewAtom)
  const width = Math.max(10, e.props.bodyColumns - 2)
  paneColumns = Math.min(512, width)

  if (tabs.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text dimColor>{'⌂'} No tabs open.</Text>
          <Box flexDirection="row">
            <Button key="tab-new" variant="primary" onPress={() => void addTab($)}>
              New tab
            </Button>
          </Box>
        </Box>
      </Box>
    )
  }

  const tab = tabs.find(one => one.id === activeId) ?? tabs[0]!
  const url = currentUrl(tab)
  const page = url ? pages[tab.id] : undefined
  const canGoBack = tab.index > 0
  const canGoForward = tab.index < tab.history.length - 1

  const labelWidth = Math.max(3, Math.min(18, Math.floor((width - 3) / tabs.length) - 6))
  const inner = labelWidth + 4
  const fitLabel = (label: string) =>
    label.length > labelWidth ? `${label.slice(0, labelWidth - 1)}…` : label.padEnd(labelWidth)
  const stripWidth = 1 + tabs.length * (inner + 2)
  const tabStrip = (
    <Box flexDirection="column">
      <Text color="subtle">{' ' + tabs.map(() => `╭${'─'.repeat(inner)}╮`).join('')}</Text>
      <Box flexDirection="row">
        <Text> </Text>
        {tabs.map(one => {
          const isActive = one.id === tab.id
          const label = fitLabel(tabLabel(one, pages[one.id]))
          return (
            <Box key={`tabbox-${one.id}`} flexDirection="row">
              <Text color="subtle">{'│ '}</Text>
              <Button key={`tab-${one.id}`} plain dimColor={!isActive} onPress={() => void update($, activeAtom, () => one.id)}>
                {isActive ? <Text bold>{label}</Text> : label}
              </Button>
              <Text> </Text>
              <Button key={`close-${one.id}`} plain dimColor onPress={() => void closeTab($, one.id)}>
                {'×'}
              </Button>
              <Text color="subtle">{' │'}</Text>
            </Box>
          )
        })}
        <Text> </Text>
        <Button key="tab-new" plain dimColor onPress={() => void addTab($)}>
          +
        </Button>
      </Box>
      <Text color="subtle">
        {'─' +
          tabs.map(one => (one.id === tab.id ? `╯${' '.repeat(inner)}╰` : `┴${'─'.repeat(inner)}┴`)).join('') +
          '─'.repeat(Math.max(0, width - stripWidth))}
      </Text>
    </Box>
  )

  const addressBar = (
    <Box flexDirection="row" gap={1} borderStyle="round" borderColor="subtle">
      <Button key="nav-back" plain dimColor={!canGoBack} onPress={() => void step($, tab.id, -1)}>
        {'←'}
      </Button>
      <Button key="nav-forward" plain dimColor={!canGoForward} onPress={() => void step($, tab.id, 1)}>
        {'→'}
      </Button>
      <Button key="nav-reload" plain dimColor={!url} onPress={() => void load($, tab.id)}>
        {'↻'}
      </Button>
      <Button key="nav-home" plain dimColor={!url} onPress={() => void navigate($, tab.id, '')}>
        {'⌂'}
      </Button>
      <Box flexGrow={1} flexShrink={1}>
        {Input ? (
          <Input
            key={`url-${tab.id}-${tab.index}`}
            value={url}
            placeholder="Enter a URL or search"
            submitLabel="go"
            onSubmit={(value: string) => void navigate($, tab.id, value)}
          />
        ) : (
          <Text dimColor wrap="truncate-end">
            {url || 'Enter a URL or search'}
          </Text>
        )}
      </Box>
      {url ? (
        <Button key="open-external" plain dimColor onPress={() => void openExternally($, url)}>
          {'⧉'}
        </Button>
      ) : null}
    </Box>
  )

  const chrome = (
    <Box flexDirection="column">
      {tabStrip}
      {addressBar}
    </Box>
  )

  let blocks
  if (!url) {
    const launch = await readLaunch($)
    const servers = await read($, serversAtom)
    const firstStopped = launch.configs.find(config => {
      const state = servers[config.name]
      return !children.has(config.name) && state?.status !== 'running' && state?.status !== 'external'
    })
    blocks = [
      <Box key="servers" flexDirection="column">
        <Box flexDirection="row">
          <Text bold>Servers</Text>
          <Text dimColor> {launch.configs.length}</Text>
        </Box>
        {launch.error && (
          <Text color="error" wrap="wrap">
            launch.json: {launch.error}
          </Text>
        )}
        {!launch.error && launch.configs.length === 0 && (
          <Text dimColor wrap="wrap">
            No servers configured yet.
          </Text>
        )}
        {launch.configs.map(config => {
          const state = servers[config.name] ?? { status: 'stopped', logs: [] }
          const isStarted = children.has(config.name) || state.status === 'running'
          const statusText =
            state.status === 'running'
              ? state.isListening
                ? 'running'
                : 'starting'
              : state.status === 'external'
                ? 'external'
                : state.status === 'exited'
                  ? `exited ${state.code ?? 'signal'}`
                  : state.status
          const dotColor =
            state.status === 'running'
              ? state.isListening
                ? 'success'
                : 'warning'
              : state.status === 'external'
                ? 'success'
                : state.status === 'failed' || (state.status === 'exited' && state.code !== 0)
                  ? 'error'
                  : 'subtle'
          const isLogsShown = view.logsFor === config.name
          const portText = typeof config.port === 'number' ? `:${config.port}` : ''
          const nameRoom = Math.max(4, width - 4 - statusText.length - (portText ? portText.length + 2 : 0))
          const name = config.name.length > nameRoom ? `${config.name.slice(0, nameRoom - 1)}…` : config.name
          return (
            <Box key={`srv-${config.name}`} flexDirection="column">
              <Box flexDirection="row" columnGap={2}>
                <Box flexDirection="row" gap={1} flexShrink={1}>
                  <Text color={dotColor}>{'●'}</Text>
                  <Button
                    key={`srv-open-${config.name}`}
                    plain
                    onPress={() =>
                      typeof config.port === 'number'
                        ? void navigate($, tab.id, `http://localhost:${config.port}`)
                        : $.ui.toast(`${config.name} has no port in launch.json`)
                    }
                  >
                    {name}
                  </Button>
                </Box>
                {portText && <Text dimColor wrap="truncate-end">{portText}</Text>}
                <Text dimColor wrap="truncate-end">{statusText}</Text>
              </Box>
              <Box flexDirection="row" gap={2} paddingLeft={2}>
                {state.status === 'external' ? null : isStarted ? (
                  <Button key={`srv-toggle-${config.name}`} plain onPress={() => void stopServer($, config.name)}>
                    Stop
                  </Button>
                ) : config === firstStopped ? (
                  <Button key={`srv-toggle-${config.name}`} variant="primary" onPress={() => void startServer($, config)}>
                    Start
                  </Button>
                ) : (
                  <Button key={`srv-toggle-${config.name}`} plain onPress={() => void startServer($, config)}>
                    Start
                  </Button>
                )}
                <Button
                  key={`srv-logs-${config.name}`}
                  plain
                  dimColor={!isLogsShown}
                  onPress={() =>
                    void update($, viewAtom, v => ({ ...v, logsFor: v.logsFor === config.name ? null : config.name }))
                  }
                >
                  Logs
                </Button>
              </Box>
              {isLogsShown && (
                <Box flexDirection="column" paddingLeft={2}>
                  {state.logs.length > 0 ? <Code source={state.logs.join('\n')} /> : <Text dimColor>No output yet.</Text>}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>,
      <Box key="help" flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text dimColor>Open a server or enter a URL.</Text>
          <Button
            key="cfg-toggle"
            plain
            dimColor={!view.isConfigShown}
            onPress={() => void update($, viewAtom, v => ({ ...v, isConfigShown: !v.isConfigShown }))}
          >
            launch.json
          </Button>
        </Box>
        {view.isConfigShown &&
          (launch.raw !== undefined ? (
            <Code language="json" source={clean(launch.raw) || '{}'} />
          ) : (
            <Text dimColor wrap="wrap">
              {LAUNCH_FILE} does not exist yet.
            </Text>
          ))}
      </Box>,
    ]
  } else if (!page || page.status === 'loading') {
    blocks = [
      <Box key="loading">
        <Text dimColor wrap="truncate-end">
          Loading {url}…
        </Text>
      </Box>,
    ]
  } else if (page.status === 'error') {
    blocks = [
      <Box key="error" flexDirection="column">
        <Text color="error" wrap="truncate-end">
          Could not load {url}
        </Text>
        <Text dimColor wrap="wrap">
          {page.error ?? 'Unknown error'}
        </Text>
      </Box>,
    ]
  } else {
    const mode = await read($, modeAtom)
    const snaps = await read($, snapshotsAtom)
    const links = page.links ?? []
    const canSnapshot = /^https?:/i.test(url) && !!Raster
    const columns = paneColumns
    const snap = snaps[tab.id]?.url === url ? snaps[tab.id] : undefined
    const isSnapshotShown = mode === 'snapshot' && canSnapshot
    const pickMode = async (value: PageMode) => {
      await update($, modeAtom, () => value)
      if (value === 'snapshot' && canSnapshot && !snap) await capture($, tab.id, url, columns)
    }
    const modeButton = (value: PageMode, label: string) => (
      <Button key={`mode-${value}`} plain dimColor={mode !== value} onPress={() => void pickMode(value)}>
        {mode === value ? (
          <Text bold color="suggestion">
            {label}
          </Text>
        ) : (
          label
        )}
      </Button>
    )
    const contentType = (page.contentType ?? '').split(';')[0]?.trim() || 'unknown type'

    let snapshotBlock = null
    if (isSnapshotShown) {
      if (!snap) {
        snapshotBlock = (
          <Box key="snapshot">
            <Text dimColor wrap="wrap">
              No snapshot yet.
            </Text>
          </Box>
        )
      } else if (snap.status === 'rendering') {
        snapshotBlock = (
          <Box key="snapshot">
            <Text dimColor>Rendering…</Text>
          </Box>
        )
      } else if (snap.status === 'error' || !snap.cells || !Raster) {
        snapshotBlock = (
          <Box key="snapshot">
            <Text dimColor wrap="wrap">
              No snapshot: {snap.error ?? 'the capture failed'}. Showing text.
            </Text>
          </Box>
        )
      } else {
        snapshotBlock = (
          <Box key="snapshot" flexDirection="column">
            <Raster key={`snap-${tab.id}`} columns={snap.columns} rows={snap.rows} cells={snap.cells} />
          </Box>
        )
      }
    }

    blocks = [
      <Box key="page-bar" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            {modeButton('snapshot', 'Snapshot')}
            <Text dimColor>{'│'}</Text>
            {modeButton('text', 'Text')}
          </Box>
          {isSnapshotShown ? (
            <Button key="snap-retake" plain dimColor onPress={() => void capture($, tab.id, url, columns)}>
              {'↻'}
            </Button>
          ) : null}
        </Box>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {page.code} {'·'} {contentType} {'·'} {formatBytes(page.bytes ?? 0)}
            </Text>
          </Box>
          {links.length > 0 && (
            <Button
              key="links-toggle"
              plain
              dimColor={!view.isLinksShown}
              onPress={() => void update($, viewAtom, v => ({ ...v, isLinksShown: !v.isLinksShown }))}
            >
              {`Links ${links.length}`}
            </Button>
          )}
        </Box>
      </Box>,
      snapshotBlock,
      view.isLinksShown && links.length > 0 ? (
        <Box key="links" flexDirection="column">
          {links.map((link, index) => (
            <Button key={`link-${index}`} plain onPress={() => void navigate($, tab.id, link.href)}>
              {link.text.length > width - 2 ? `${link.text.slice(0, Math.max(8, width - 3))}…` : link.text}
              <Text dimColor> {link.href}</Text>
            </Button>
          ))}
        </Box>
      ) : null,
      <Box key="body" flexDirection="column">
        {page.kind === 'markdown' ? (
          <Markdown
            key={`page-${tab.id}`}
            text={page.body ?? ''}
            onLinkPress={link => void navigate($, tab.id, link.href)}
          />
        ) : (
          <Code language={page.language} source={page.body || ' '} />
        )}
      </Box>,
    ]
  }

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {chrome}
      {blocks.filter(Boolean)}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open the Browser pane: a text-mode browser and dev-server launcher',
      argumentHint: '[url]',
      immediate: true,
    })
    $.clock.every(PROBE_MS, () => void probeAll($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await ensureTab($)
    const url = e.args.trim()
    if (url) {
      const active = await read($, activeAtom)
      const tabs = await read($, tabsAtom)
      const tab = tabs.find(one => one.id === active)
      if (tab && currentUrl(tab) === '') void navigate($, tab.id, url)
      else void addTab($, url)
    } else {
      void probeAll($).catch(() => undefined)
    }
    await openPane($, true)
    return { text: url ? `Browser: opening ${normalizeUrl(url)}` : 'Browser pane opened.' }
  }).catch(($, e, next) => ({ text: 'The Browser pane could not open.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    framed($, e, await drawPane($, inset(e))),
  )
}
