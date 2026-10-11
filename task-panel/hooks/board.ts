// The task's plan and clock as plain data: no `$`, so tests read it directly.

import type { Backlog, BacklogItem, Queued, Step, StepStatus, Task } from '../types'

const TITLE_MAX = 160
const ITEM_MAX = 300
const ITEMS_KEPT = 50

export function emptyBacklog(): Backlog {
  return { items: [], next: 1 }
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
  return { items: items.slice(-ITEMS_KEPT), next }
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
  const highest = items.reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0)
  return { items, next: Math.max(Number(kept.next) || 1, highest + 1) }
}

/** What the model reads about the backlog at a conversation's start. */
export function backlogBriefing(backlog: Backlog, tool: string): string {
  const how =
    `When the user says to do something later or next time, or work is left over when a task ends, add it with ${tool}; ` +
    'mark items done by id once they are finished. When the user asks what is left, start from this list.'
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
export function settle(task: Task, steps: Step[], at: number): Task {
  const isDone = steps.length > 0 && steps.every(step => step.status === 'completed')
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
  if (task.steps.length > 0) return progress(task.steps).percent
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
