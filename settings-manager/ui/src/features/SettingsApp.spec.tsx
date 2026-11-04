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
]

const posts: unknown[] = []

beforeEach(() => {
  posts.length = 0
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.body) posts.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ sections: SECTIONS }))
  }))
})

test('shows the first section and runs a switch action', async () => {
  render(<SettingsApp />)
  await screen.findByText('my-grill-me')
  await userEvent.click(screen.getByRole('switch', { name: 'plain' }))
  await waitFor(() => expect(posts).toEqual([{ act: { type: 'move', name: 'plain' }, value: true }]))
})

test('opens a skill with full text, edits it and saves', async () => {
  render(<SettingsApp />)
  await userEvent.click(await screen.findByText('my-grill-me'))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('# Grill')).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
  await userEvent.type(within(dialog).getByRole('textbox'), '!')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(posts).toContainEqual({ act: { type: 'edit', path: 'skills/my-grill-me/SKILL.md', text: '# Grill!' }, value: null }))
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
