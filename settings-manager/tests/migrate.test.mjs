// Run with `node --test tests/`. Checks that `main.mjs --migrate` moves the old `disabled` folders into disabled.json.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'main.mjs')

function setUp(files) {
  const root = mkdtempSync(join(tmpdir(), 'settings-manager-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const migrate = root => execFileSync(process.execPath, [MAIN, root.replace(/\\/g, '/'), '--migrate'])
const read = (root, path) => readFileSync(join(root, path), 'utf8')
const hookId = (event, group) => createHash('sha256').update(JSON.stringify([event, group])).digest('hex').slice(0, 12)

test('the old disabled folders move into disabled.json', () => {
  const group = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }
  const root = setUp({
    'skills/mine/SKILL.md': '---\nname: mine\n---\n',
    'skills/disabled/old-mine/SKILL.md': '---\nname: old-mine\n---\nmy text',
    'skills/disabled/anthropic-skills__pdf/skill.json': JSON.stringify({ name: 'anthropic-skills:pdf' }),
    'skills/anthropic-skills__docx/skill.json': JSON.stringify({ name: 'anthropic-skills:docx' }),
    'prompts/disabled/tone.md': 'Claude Code text',
    'prompts/reminders/disabled/todo_reminder.md': 'Claude Code text',
    'prompts/reminders/model.md': 'kept',
    'prompts/reminders/disabled/model.md': 'old copy',
    'agents/disabled/reviewer.md': '---\nname: code-reviewer\n---\nmy agent',
    'agents/disabled/Plan.json': JSON.stringify({ name: 'Plan' }),
    'commands/disabled/compact.json': JSON.stringify({ name: 'compact' }),
    'hooks/disabled/abc.json': JSON.stringify({ event: 'PreToolUse', group }),
    'settings-manager/catalog.json': JSON.stringify({ sections: { 'tone': {} }, reminders: { todo_reminder: {} } }),
    'settings-manager/disabled.json': JSON.stringify({ commands: ['clear'] }),
  })
  try {
    migrate(root)
    const disabled = JSON.parse(read(root, 'settings-manager/disabled.json'))
    assert.deepEqual(disabled.skills, ['anthropic-skills:pdf', 'old-mine'])
    assert.deepEqual(disabled.sections, ['tone'])
    assert.deepEqual(disabled.reminders, ['model', 'todo_reminder'])
    assert.deepEqual(disabled.agents, ['code-reviewer', 'Plan'])
    assert.deepEqual(disabled.commands, ['clear', 'compact'])
    assert.deepEqual(disabled.hooks, { [hookId('PreToolUse', group)]: { event: 'PreToolUse', group } })

    // Your own files go back to their folders; generated files and markers are deleted.
    assert.equal(read(root, 'skills/old-mine/SKILL.md'), '---\nname: old-mine\n---\nmy text')
    assert.equal(read(root, 'agents/reviewer.md'), '---\nname: code-reviewer\n---\nmy agent')
    assert.equal(read(root, 'prompts/tone.md'), 'Claude Code text')
    assert.equal(read(root, 'prompts/reminders/model.md'), 'kept')
    assert.equal(existsSync(join(root, 'skills/anthropic-skills__docx')), false)
    assert.equal(existsSync(join(root, 'skills/mine/SKILL.md')), true)
    for (const dir of ['skills', 'prompts', 'prompts/reminders', 'agents', 'commands', 'hooks']) assert.equal(existsSync(join(root, dir, 'disabled')), false, dir)

    // A second run changes nothing.
    const before = read(root, 'settings-manager/disabled.json')
    migrate(root)
    assert.equal(read(root, 'settings-manager/disabled.json'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file of yours whose name is taken stays in the disabled folder', () => {
  const root = setUp({
    'skills/twin/SKILL.md': '---\nname: twin\n---\nnew',
    'skills/disabled/twin/SKILL.md': '---\nname: twin\n---\nold',
  })
  try {
    migrate(root)
    assert.equal(read(root, 'skills/twin/SKILL.md'), '---\nname: twin\n---\nnew')
    assert.equal(read(root, 'skills/disabled/twin/SKILL.md'), '---\nname: twin\n---\nold')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
