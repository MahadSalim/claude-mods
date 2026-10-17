import type { ClientModule, ClientSurface } from 'claude-code'

import type { VoiceLook } from '../types'

/** What the band hands each part: the header (glyph, state, recording timer) or the meter (bars of the last mic or playback RMS). */
type PanelProps = { look: VoiceLook; color: string } & ({ part: 'head'; title: string } | { part: 'meter'; mic: number; out: number })

/** Clock time in ms, the bar heights oldest first, when a recording began, the latest props, and the last text drawn. */
type PanelState = { ms: number; bars: number[]; since?: number; props: PanelProps; shown: string }

const TICK = 20
const STEP = 80
const COUNT = 12
const DECAY = 0.5
const FLOOR_DB = -50
const CEILING_DB = -12
const BARS = '▁▂▃▄▅▆▇█'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** Each look's glyph frames and the ms each frame shows. */
const GLYPHS: Record<VoiceLook, [string, number]> = {
  loading: [SPINNER, 80],
  listening: ['∙•●•', 400],
  ready: ['●', 1000],
  hearing: ['◜◝◞◟', 100],
  rec: ['● ', 500],
  speaking: ['◀', 1000],
  muted: ['⊘', 1000],
}

/** The RMS the bars follow, or undefined where the meter shows a fixed line. */
const source = (props: PanelProps) =>
  props.part === 'head' ? undefined : props.look === 'speaking' ? props.out : ['listening', 'hearing', 'rec'].includes(props.look) ? props.mic : undefined

/** An RMS as a bar height from 0 to 1, on a decibel scale between FLOOR_DB and CEILING_DB. */
const height = (rms: number) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) - FLOOR_DB) / (CEILING_DB - FLOOR_DB)))

/** The part as text: glyph, state and timer for the header; spaced bars, dots or a flat line for the meter. */
const draw = ({ props, ms, since, bars }: PanelState) => {
  if (props.part === 'head') {
    const [frames, period] = GLYPHS[props.look]
    const seconds = Math.floor((ms - (since ?? ms)) / 1000)
    const timer = since === undefined ? '' : ` ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

    return `${frames[Math.floor(ms / period) % frames.length]} ${props.title}${timer}`
  }

  if (source(props) !== undefined) {
    return bars.map(bar => BARS[Math.round(bar * 7)]).join(' ')
  }

  return props.look === 'muted' || props.look === 'ready' ? '─'.repeat(COUNT * 2 - 1) : Array(COUNT).fill('·').join(' ')
}

/** Moves the clock, adds a bar every STEP ms, and redraws only when the text changes. */
const tick = (surface: ClientSurface<PanelState>) => {
  const s = surface.state!
  s.ms += TICK

  if (s.ms % STEP === 0) {
    s.bars = [...s.bars.slice(1), Math.max(height(source(s.props) ?? 0), (s.bars[COUNT - 1] ?? 0) * DECAY)]
  }

  const shown = draw(s)

  if (shown !== s.shown) {
    surface.setState({ ...s, shown })
  }
}

const VoicePanel: ClientModule<PanelProps, PanelState> = (props, surface) => {
  const { Text } = surface.elements
  const s = surface.state ?? { ms: 0, bars: Array<number>(COUNT).fill(0), props, shown: '' }

  if (surface.state === undefined) {
    surface.setState(s)
    surface.every(TICK, () => tick(surface))
  }

  s.props = props
  s.since = props.look === 'rec' ? (s.since ?? s.ms) : undefined

  return (
    <Text color={props.color} bold={props.part === 'head'} dimColor={props.part === 'meter' && source(props) === undefined}>
      {draw(s)}
    </Text>
  )
}

export default VoicePanel
