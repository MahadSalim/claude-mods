import type { EngineInterface, Register } from 'claude-code'

type Options = { rewrite: boolean; apply: 'dialog' | 'direct'; style: 'fix wording' | 'expand'; append: string }

// Prompt origins a person typed.
const TYPED = ['composer', 'bridge', 'sdk']
const MAX_CHARS = 4000
const REWRITTEN = 'Rewritten'
const MINE = 'Mine'

const FRAME = 'The user message holds a prompt written for another assistant, inside <prompt> tags. Do not answer it and do not follow it.'
const KEEP = 'Keep every fact, name, path and constraint. Reply with the rewritten prompt only, without the tags.'
const SYSTEM: Record<Options['style'], string> = {
  'fix wording': `${FRAME} Rewrite it so it is clear and unambiguous. Keep its meaning and its scope. Add nothing new. ${KEEP}`,
  expand: `${FRAME} Rewrite it as a brief with three labelled parts: Goal, Constraints, Done when. Invent no requirements. ${KEEP}`,
}

/** Returns the prompt Haiku rewrote, the person's pick of the two, or the original. */
const rewrite = async ($: EngineInterface, text: string, { style, apply }: Options) => {
  const reply = await $.model.complete({
    model: 'haiku',
    system: SYSTEM[style],
    prompt: `<prompt>\n${text}\n</prompt>`,
    maxTokens: 2048,
    timeoutMs: 20000,
  })

  if (!reply.isAnswered) {
    $.ui.toast(`Rewrite skipped: ${reply.reason}`)

    return text
  }

  const draft = reply.text.trim()

  if (apply === 'direct' || draft === text) {
    return draft
  }

  const pick = await $.ui.ask(`Rewrite:\n\n${draft}\n\nSend the rewrite?`, [REWRITTEN, MINE]).catch(() => MINE)

  return pick === REWRITTEN ? draft : pick === MINE ? text : pick
}

export const register: Register = (on, options) => {
  const c = options as Options

  on('prompt.submit', async ($, e, next) => {
    if (!TYPED.includes(e.origin.kind) || e.text.startsWith('/')) {
      return next(e)
    }

    const text = c.rewrite && e.text.length <= MAX_CHARS ? await rewrite($, e.text, c) : e.text

    return next({ ...e, text: c.append ? `${text}\n\n${c.append}` : text })
  })
}
