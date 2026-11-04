import type { Item } from '@/types'

/** Descriptions longer than this open in the text viewer. */
const LONG_TEXT = 90

/** The text that the viewer shows for an item, if it has any. */
export const fullText = (item: Item) => item.view ?? item.edit?.text ?? ((item.description?.length ?? 0) > LONG_TEXT ? item.description : undefined)

/** True when the item's title, description or badge contains the query. */
export const matches = (item: Item, query: string) => [item.title, item.description, item.badge].some(text => String(text ?? '').toLowerCase().includes(query))
