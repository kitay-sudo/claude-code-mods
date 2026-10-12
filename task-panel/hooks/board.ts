// The task's plan and clock as plain data: no `$`, so tests read it directly.

import type { Backlog, BacklogItem, ClosedItem, Intent, Queued, Step, StepStatus, Task } from '../types'

const TITLE_MAX = 160
const ITEM_MAX = 300
const ITEMS_KEPT = 50
const CLOSED_KEPT = 10
const DAY_MS = 24 * 60 * 60 * 1000
/** An item older than this is asked whether it is still needed. */
export const STALE_DAYS = 14

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

function startOfDay(ms: number): number {
  const at = new Date(ms)
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

export function removeItems(backlog: Backlog, ids: readonly string[]): Backlog {
  return { ...backlog, items: backlog.items.filter(item => !ids.includes(item.id)) }
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

/** What the model reads about the backlog at a conversation's start. */
export function backlogBriefing(backlog: Backlog, tool: string): string {
  const how =
    `When the user says to do something later or next time, or work is left over when a task ends, add it with ${tool}; ` +
    'mark items done by id once they are finished, and drop the ones no longer needed. When the user asks what is left, start from this list.'
  if (backlog.items.length === 0) return `The project's backlog in the Task panel is empty. ${how}`
  const lines = backlog.items.map(item => `- [${item.id}] ${item.text}`)
  return `The project's backlog in the Task panel (things to do later, kept between chats):\n${lines.join('\n')}\n${how}`
}

// Replies that answer a question rather than ask for new work.
const REPLY = /^(да|нет|ок|окей|ага|угу|давай|продолжай|дальше|go|yes|no|ok|y|n)[\s.!,]*$/iu
const SHORT_PROMPT = 15

export function titleOf(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  const points = [...line]
  return points.length > TITLE_MAX ? `${points.slice(0, TITLE_MAX - 1).join('')}…` : line
}

/** Whether a prompt typed after a task ended starts a new one, or answers the last. */
export function startsTask(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= SHORT_PROMPT && !REPLY.test(trimmed)
}

export function fromTodos(todos: readonly { content: string; status: StepStatus }[]): Step[] {
  return todos.map((todo, index) => ({ id: `todo-${index}`, title: todo.content, status: todo.status }))
}

export function fromTaskList(tasks: readonly { id: string; subject: string; status: StepStatus }[]): Step[] {
  return tasks.map(one => ({ id: one.id, title: one.subject, status: one.status }))
}

export function withCreated(steps: readonly Step[], id: string, title: string): Step[] {
  return [...steps.filter(step => step.id !== id), { id, title, status: 'pending' }]
}

export function withUpdate(
  steps: readonly Step[],
  id: string,
  change: { status?: StepStatus | 'deleted'; title?: string },
): Step[] {
  if (change.status === 'deleted') return steps.filter(step => step.id !== id)
  const status = change.status
  return steps.map(step =>
    step.id === id ? { ...step, title: change.title ?? step.title, status: status ?? step.status } : step,
  )
}

/** The task with its new steps: done once every step is, open again if one is not. */
/** True when there is no intent, or every one of its checks holds. */
export function intentMet(intent: Intent | null): boolean {
  return intent === null || intent.criteria.every(criterion => criterion.met)
}

const CRITERIA_MAX = 6

/** The intent the model passed: absent is null (keep the one there), a malformed one says why. */
export function fromIntent(raw: unknown): Intent | null | { error: string } {
  if (raw === undefined || raw === null) return null
  const one = raw as { goal?: unknown; criteria?: unknown }
  if (typeof one.goal !== 'string' || one.goal.trim() === '') return { error: 'intent.goal: одной строкой, зачем эта задача' }
  if (!Array.isArray(one.criteria) || one.criteria.length === 0 || one.criteria.length > CRITERIA_MAX) {
    return { error: `intent.criteria: от 1 до ${CRITERIA_MAX} проверяемых пунктов "готово, когда"` }
  }
  const criteria: Intent['criteria'] = []
  for (const item of one.criteria) {
    const text = (item as { text?: unknown }).text
    if (typeof text !== 'string' || text.trim() === '') return { error: 'intent.criteria[].text: что проверить' }
    criteria.push({ text: titleOf(text), met: (item as { met?: unknown }).met === true })
  }
  return { goal: titleOf(one.goal), criteria }
}

/** The task with its new steps: done once every step is and every check of its intent holds, open again if not. */
export function settle(task: Task, steps: Step[], at: number): Task {
  const isDone = steps.length > 0 && steps.every(step => step.status === 'completed') && intentMet(task.intent)
  return { ...task, steps, finishedAt: isDone ? (task.finishedAt ?? at) : steps.length > 0 ? null : task.finishedAt }
}

export function fromPlan(steps: unknown): Step[] | null {
  if (!Array.isArray(steps)) return null
  const plan: Step[] = []
  for (const [index, step] of steps.entries()) {
    const title = (step as { title?: unknown }).title
    const status = (step as { status?: unknown }).status
    if (typeof title !== 'string' || title.trim() === '') return null
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    plan.push({ id: `plan-${index}`, title: titleOf(title), status })
  }
  return plan
}

export function progress(steps: readonly Step[]): { done: number; total: number; percent: number } {
  const done = steps.filter(step => step.status === 'completed').length
  const total = steps.length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/** How ready the task is: its plan's share of done steps, or 0 and 100 without one. */
export function readiness(task: Task): number {
  if (task.steps.length > 0) {
    // The checks of the intent count with the steps: the last stretch is proving it works.
    const criteria = task.intent?.criteria ?? []
    const done = progress(task.steps).done + criteria.filter(criterion => criterion.met).length
    return Math.round((done / (task.steps.length + criteria.length)) * 100)
  }
  return task.finishedAt === null ? 0 : 100
}

/** The step being worked on, from 1: the one in progress, else the first not done. */
export function currentStep(steps: readonly Step[]): number {
  const working = steps.findIndex(step => step.status === 'in_progress')
  if (working !== -1) return working + 1
  const next = steps.findIndex(step => step.status !== 'completed')
  return next === -1 ? steps.length : next + 1
}

export function roman(n: number): string {
  if (n < 1 || n > 3999) return String(n)
  const digits: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ]
  let rest = n
  let out = ''
  for (const [value, letters] of digits) {
    while (rest >= value) {
      out += letters
      rest -= value
    }
  }
  return out
}

export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'меньше минуты'
  if (minutes < 60) return `${minutes} мин`
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`
}

export function bar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width)
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

function plain(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The queued prompts a text the model now reads carries, and the ones still
 * waiting: the first that matches for a message read mid-turn, every one that
 * matches for a turn they start.
 */
export function takeQueued(queue: readonly Queued[], text: string, isEvery: boolean): { taken: Queued[]; rest: Queued[] } {
  const reads = plain(text)
  const taken: Queued[] = []
  for (const item of queue) {
    if (!isEvery && taken.length > 0) break
    const words = plain(item.text)
    if (words !== '' && reads.includes(words)) taken.push(item)
  }
  return { taken, rest: queue.filter(item => !taken.includes(item)) }
}

/** What the queue means for the person: when its prompts will be read. */
export function queueHint(queue: readonly Queued[], isWorking: boolean): string {
  if (!isWorking) return 'Беру в работу...'
  const later = queue.filter(item => item.wait).length
  if (later === queue.length) return 'Начну, когда закончу эту задачу.'
  if (later > 0) return 'Прочитаю после текущего шага. Отмеченные "после задачи" начну, когда закончу эту.'
  return 'Прочитаю после текущего шага и учту в работе.'
}
