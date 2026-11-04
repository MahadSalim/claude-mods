import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Section } from '@/types'
import { SettingsApp } from './SettingsApp'

const SECTIONS: Section[] = [
  {
    id: 'skills',
    title: 'Skills',
    folder: 'skills',
    note: 'Turned-off skills move to skills/disabled.',
    groups: [
      {
        title: 'Your skills',
        items: [
          { title: 'my-grill-me', description: 'A short one.', value: true, act: { type: 'move', name: 'my-grill-me' }, edit: { path: 'skills/my-grill-me/SKILL.md', text: '# Grill' } },
          { title: 'plain', description: 'No full text.', value: false, act: { type: 'move', name: 'plain' } },
        ],
      },
    ],
  },
  {
    id: 'general',
    title: 'General',
    folder: '',
    note: 'Settings from settings.json.',
    groups: [{ title: 'Model', items: [{ title: 'Model', control: 'select', value: '', options: [{ value: '', label: 'Default' }, { value: 'opus', label: 'opus' }], act: { type: 'setting', key: ['model'] } }] }],
  },
  {
    id: 'mcp',
    title: 'MCP',
    folder: '',
    note: 'Turning a server or tool off adds it to permissions.deny in settings.json.',
    groups: [
      {
        title: 'atlas-db',
        toggle: { title: 'atlas-db', description: '1 tool', value: false, act: { type: 'deny', rule: 'mcp__atlas-db' } },
        items: [{ title: 'execute_sql', value: true, isDisabled: true, act: { type: 'deny', rule: 'mcp__atlas-db__execute_sql' } }],
      },
    ],
  },
  {
    id: 'env',
    title: 'Environment',
    folder: '',
    note: 'Variables from env in settings.json.',
    groups: [
      {
        title: 'Variables',
        items: [
          { title: 'API_KEY', value: 'sk-123', control: 'env', isSecret: true, act: { type: 'env', name: 'API_KEY' } },
          { title: 'DEBUG', value: '1', control: 'env', act: { type: 'env', name: 'DEBUG' } },
        ],
      },
    ],
  },
]

/** The label that the fake server sends for the last change. */
let lastChange: string | undefined

const posts: unknown[] = []

beforeEach(() => {
  posts.length = 0
  lastChange = undefined
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.body) posts.push({ path, ...JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ sections: SECTIONS, undo: lastChange }))
  }))
})

test('shows the first section and runs a switch action', async () => {
  render(<SettingsApp />)
  await screen.findByText('my-grill-me')
  await userEvent.click(screen.getByRole('switch', { name: 'plain' }))
  await waitFor(() => expect(posts).toEqual([{ path: '/api/act', act: { type: 'move', name: 'plain' }, value: true, label: 'Turn on plain' }]))
})

test('opens a skill with full text, edits it and saves', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('my-grill-me'))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('# Grill')).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
  await userEvent.type(within(dialog).getByRole('textbox'), '!')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(posts).toContainEqual({ path: '/api/act', act: { type: 'edit', path: 'skills/my-grill-me/SKILL.md', text: '# Grill!' }, value: null, label: 'Edit my-grill-me' }))
})

test('asks before it drops unsaved edits', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('my-grill-me'))
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
  await userEvent.type(within(dialog).getByRole('textbox'), '!')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(within(dialog).getByText('Discard your unsaved changes?')).toBeInTheDocument()
})

test('an MCP server has one switch beside its name, and its tools cannot change while it is off', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('MCP'))
  expect(screen.getByRole('heading', { name: 'atlas-db' })).toBeInTheDocument()
  expect(screen.queryByText('All tools')).not.toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'execute_sql' })).toBeDisabled()
  await userEvent.click(screen.getByRole('switch', { name: 'atlas-db' }))
  await waitFor(() => expect(posts).toEqual([{ path: '/api/act', act: { type: 'deny', rule: 'mcp__atlas-db' }, value: true, label: 'Turn on atlas-db' }]))
})

test('does not open a row without full text', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('plain'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('searches across sections', async () => {
  render(<SettingsApp />)
  await screen.findByText('my-grill-me')
  await userEvent.type(screen.getByPlaceholderText('Search'), 'Model ')
  expect(screen.getByPlaceholderText('Search')).toHaveValue('Model ')
  expect(screen.queryByText('my-grill-me')).not.toBeInTheDocument()
  expect(screen.getAllByText('Model').length).toBeGreaterThan(0)
  await userEvent.clear(screen.getByPlaceholderText('Search'))
  await userEvent.type(screen.getByPlaceholderText('Search'), 'zzz')
  expect(screen.getByText('Nothing matches your search.')).toBeInTheDocument()
})

test('shows the empty value of a select as its Default option', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('General'))
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Default')
})

test('hides a secret value until you click the eye button', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('Environment'))
  expect(screen.getByRole('textbox', { name: 'DEBUG' })).toHaveValue('1')
  const key = screen.getByLabelText('API_KEY')
  expect(key).toHaveAttribute('type', 'password')
  await userEvent.click(screen.getByRole('button', { name: 'Show API_KEY' }))
  expect(key).toHaveAttribute('type', 'text')
})

test('changes, deletes and adds variables', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('Environment'))
  const debug = screen.getByRole('textbox', { name: 'DEBUG' })
  await userEvent.clear(debug)
  await userEvent.type(debug, '2{Enter}')
  await userEvent.click(screen.getByRole('button', { name: 'Delete API_KEY' }))
  await userEvent.type(screen.getByLabelText('New variable name'), ' MY_VAR ')
  await userEvent.type(screen.getByLabelText('New variable value'), 'on{Enter}')
  await waitFor(() =>
    expect(posts).toEqual([
      { path: '/api/act', act: { type: 'env', name: 'DEBUG' }, value: '2', label: 'Change DEBUG' },
      { path: '/api/act', act: { type: 'env', name: 'API_KEY' }, value: null, label: 'Delete API_KEY' },
      { path: '/api/act', act: { type: 'env', name: 'MY_VAR', isNew: true }, value: 'on', label: 'Add MY_VAR' },
    ]),
  )
  await waitFor(() => expect(screen.getByLabelText('New variable name')).toHaveValue(''))
})

test('the Undo button undoes the last change', async () => {
  render(<SettingsApp />)
  await screen.findByText('my-grill-me')
  expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  lastChange = 'Turn on plain'
  await userEvent.click(screen.getByRole('switch', { name: 'plain' }))
  const undo = await screen.findByRole('button', { name: 'Undo: Turn on plain' })
  lastChange = undefined
  await userEvent.click(undo)
  await waitFor(() => expect(posts.at(-1)).toEqual({ path: '/api/undo' }))
  expect(await screen.findByRole('button', { name: 'Undo' })).toBeDisabled()
})
