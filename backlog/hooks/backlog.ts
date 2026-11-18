// The backlog as plain data: no `$`, so tests read it directly.

import type { Backlog, BacklogItem, ClosedItem, Row, Tab } from '../types'

const ITEM_MAX = 300
const ITEMS_KEPT = 50
// The "done" and "all" tabs are a history, so it is kept long.
const CLOSED_KEPT = 300
const DAY_MS = 24 * 60 * 60 * 1000
/** An item older than this is asked whether it is still needed. */
export const STALE_DAYS = 7

export function emptyBacklog(): Backlog {
  return { items: [], closed: [], next: 1 }
}

/** An item's text as kept: one line, trimmed; or why it cannot be. */
export function checkItem(text: unknown): { text: string } | { error: string } {
  if (typeof text !== 'string') return { error: 'нужен текст' }
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return { error: 'пустой пункт' }
  if (line.length > ITEM_MAX) return { error: `длиннее ${ITEM_MAX} символов` }
  return { text: line }
}

/** The backlog with these items added, the ones already there not twice, the oldest dropped past the limit. */
export function addItems(backlog: Backlog, texts: readonly string[], at: number, by: BacklogItem['by']): Backlog {
  let { items, next } = backlog
  for (const text of texts) {
    if (items.some(item => item.text.toLowerCase() === text.toLowerCase())) continue
    items = [...items, { id: `b${next}`, text, at, by }]
    next++
  }
  return { ...backlog, items: items.slice(-ITEMS_KEPT), next }
}

/** These items off the list, as done or not needed, into the recently closed. */
export function closeItems(backlog: Backlog, ids: readonly string[], how: ClosedItem['how'], at: number): Backlog {
  const closing = backlog.items.filter(item => ids.includes(item.id)).map(item => ({ ...item, closedAt: at, how }))
  if (closing.length === 0) return backlog
  return {
    ...backlog,
    items: backlog.items.filter(item => !ids.includes(item.id)),
    closed: [...backlog.closed.filter(item => !ids.includes(item.id)), ...closing].slice(-CLOSED_KEPT),
  }
}

/** A closed item back on the list, where it was in the order of ids. */
export function reopenItem(backlog: Backlog, id: string): Backlog {
  const item = backlog.closed.find(one => one.id === id)
  if (item === undefined) return backlog
  const back: BacklogItem = { id: item.id, text: item.text, at: item.at, by: item.by }
  const items = [...backlog.items, back].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  return { ...backlog, items, closed: backlog.closed.filter(one => one.id !== id) }
}

/** How long ago, in words: "сегодня", "вчера", "5 дн. назад". */
export function ageText(at: number, now: number): string {
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / DAY_MS)
  if (days <= 0) return 'сегодня'
  if (days === 1) return 'вчера'
  return `${days} дн. назад`
}

export function isStale(at: number, now: number): boolean {
  return now - at >= STALE_DAYS * DAY_MS
}

/** A date as people write it on a list: "19.11", with the year only when it is not this one. */
export function dateLabel(ms: number, now: number): string {
  if (!(ms > 0)) return ''
  const at = new Date(ms)
  const day = String(at.getDate()).padStart(2, '0')
  const month = String(at.getMonth() + 1).padStart(2, '0')
  return at.getFullYear() === new Date(now).getFullYear() ? `${day}.${month}` : `${day}.${month}.${at.getFullYear()}`
}

/**
 * The lines of a tab, the freshest first: by the date shown, then the newer id.
 * Items dropped as not needed are on neither tab: they are kept, but not shown.
 */
export function rowsOf(backlog: Backlog, tab: Tab): Row[] {
  const rows: Row[] =
    tab === 'open'
      ? backlog.items.map(item => ({ id: item.id, text: item.text, state: 'open', at: item.at, day: item.at, by: item.by }))
      : backlog.closed
          .filter(item => item.how === 'done')
          .map(item => ({ id: item.id, text: item.text, state: 'done', at: item.at, day: item.closedAt > 0 ? item.closedAt : item.at, by: item.by }))
  return rows.sort((a, b) => b.day - a.day || Number(b.id.slice(1)) - Number(a.id.slice(1)))
}

/** How many lines each tab holds. */
export function tabCounts(backlog: Backlog): Record<Tab, number> {
  return { open: backlog.items.length, done: backlog.closed.filter(item => item.how === 'done').length }
}

/** The small line under an item: its date and who added it, or when it was done. */
export function rowMeta(row: Row, now: number): string {
  if (row.state === 'open') {
    return `${dateLabel(row.day, now)} · ${row.by === 'claude' ? 'Claude' : 'ты'}${isStale(row.at, now) ? ' · давно, ещё нужно?' : ''}`
  }
  const done = dateLabel(row.day, now)
  const added = dateLabel(row.at, now)
  return added !== '' && added !== done ? `сделано ${done} · добавлено ${added}` : `сделано ${done}`
}

function startOfDay(ms: number): number {
  const at = new Date(ms)
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

/** A backlog read back from the store, anything malformed left out. */
export function restoreBacklog(raw: unknown): Backlog {
  const kept = (raw ?? {}) as Partial<Backlog>
  const items = (Array.isArray(kept.items) ? kept.items : []).flatMap(item => {
    const one = item as Partial<BacklogItem>
    const checked = checkItem(one.text)
    if (typeof one.id !== 'string' || !/^b\d+$/.test(one.id) || 'error' in checked) return []
    return [{ id: one.id, text: checked.text, at: Number(one.at) || 0, by: one.by === 'claude' ? ('claude' as const) : ('person' as const) }]
  })
  const closed = (Array.isArray(kept.closed) ? kept.closed : []).flatMap(item => {
    const one = item as Partial<ClosedItem>
    const checked = checkItem(one.text)
    if (typeof one.id !== 'string' || !/^b\d+$/.test(one.id) || 'error' in checked) return []
    return [
      {
        id: one.id,
        text: checked.text,
        at: Number(one.at) || 0,
        by: one.by === 'claude' ? ('claude' as const) : ('person' as const),
        closedAt: Number(one.closedAt) || 0,
        how: one.how === 'dropped' ? ('dropped' as const) : ('done' as const),
      },
    ]
  })
  const highest = [...items, ...closed].reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0)
  return { items, closed: closed.slice(-CLOSED_KEPT), next: Math.max(Number(kept.next) || 1, highest + 1) }
}

/** What the model reads about the backlog in every conversation. */
export function backlogBriefing(backlog: Backlog, tool: string): string {
  const how =
    `When the user says to do something later or next time, or work is left over when a task ends, add it with ${tool}; ` +
    'mark items done by id once they are finished, and drop the ones no longer needed. Before you finish a piece of work, check whether it completes ' +
    'an item on the list and mark that item done in the same turn: finished work must not stay on the list. When the user asks what is left, start from this list.'
  if (backlog.items.length === 0) return `The project's backlog (the Backlog pane) is empty. ${how}`
  const lines = backlog.items.map(item => `- [${item.id}] ${item.text}`)
  return `The project's backlog (the Backlog pane: things to do later, kept between chats):\n${lines.join('\n')}\n${how}`
}

/** What "в работу" hands Claude as the person's own words. */
export function takePrompt(item: BacklogItem): string {
  return `Сделай пункт бэклога [${item.id}]: ${item.text}. Когда закончишь, отметь его сделанным.`
}
