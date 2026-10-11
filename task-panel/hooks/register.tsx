// task-panel: a side pane that follows the task at hand, a /goal or what the
// person asked for, drawn as an engineer's panel: the task, a readiness gauge
// that is always there, the stage and the minutes, and the plan's steps under
// Roman numerals. Green once everything is done.
//
// The plan comes from the plugin's own `plan` tool, which the model calls
// wherever it has no list of its own, or from the model's todo list
// (TodoWrite) or task list (TaskCreate, TaskUpdate, TaskList), read as those
// tools run. A new task opens the pane; /task-panel opens it by hand where the
// terminal is too narrow to place it.
//
// Prompts typed while Claude works wait in a queue shown at the top: each
// leaves it when the model reads it, mid-turn after a step or as the turn it
// starts.
//
// Below the task the project's backlog: what is left for later, kept between
// chats. The model adds to it with its `backlog` tool, the person with the
// field; "в работу" hands an item to Claude.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderElement } from 'claude-code'

import type { Backlog, Queued, Step, Task } from '../types'
import {
  addItems,
  ageText,
  backlogBriefing,
  bar,
  checkItem,
  closeItems,
  currentStep,
  emptyBacklog,
  formatElapsed,
  fromPlan,
  fromTaskList,
  fromTodos,
  progress,
  queueHint,
  readiness,
  isStale,
  removeItems,
  reopenItem,
  restoreBacklog,
  roman,
  settle,
  startsTask,
  takeQueued,
  titleOf,
  withCreated,
  withUpdate,
} from './board'

const PANE = 'task-panel'
const PANE_TITLE = 'Пульт задачи'
const PLAN_TOOL = 'mcp__task-panel__plan'
const BACKLOG_TOOL = 'mcp__task-panel__backlog'
const TICK_MS = 20_000
const NUMERAL_WIDTH = 7
const QUEUE_SHOWN = 90
// Idle with prompts still queued means they were taken back: the engine starts
// a queued prompt as soon as the session is idle.
const STALE_QUEUE_MS = 15_000
// Tools that keep the plan itself, not work on the task.
const PLAN_TOOLS = new Set([PLAN_TOOL, BACKLOG_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
// After this many actions without a plan the model is reminded, once a task.
const NUDGE_AFTER = 4

const BRIEFING =
  'The user follows your work in the Task panel beside the chat. For a request that takes three or more steps, ' +
  `call ${PLAN_TOOL} before you start, with every step, then again each time a step starts or finishes. ` +
  'Without a plan the panel shows the user no progress. Prompts the user types while you work wait there as a ' +
  'queue until you read them.'

const NUDGE =
  'The Task panel beside the chat shows no plan for this task yet, so the user sees no progress. If the task ' +
  `takes three or more steps, call ${PLAN_TOOL} now with every step (the current one in_progress), then again as ` +
  'each step finishes. If it is nearly done, ignore this.'

// Prompts the person wrote: at the prompt, through Remote Control, or in the
// app hosting the session.
const PERSON = new Set(['composer', 'bridge', 'sdk'])
const GOAL_CLEAR = /^(clear|stop|off|reset|none)$/i

// A suggestion the person pressed reaches here as a plugin's prompt in their words.
function isPerson(origin: PromptOrigin): boolean {
  return PERSON.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
}

const PLAN_DESCRIPTION =
  'Shows the user the plan of the current task in the Task panel beside the chat: its steps, which are done, ' +
  'and how far along it is. For a task of three or more steps, call it when you start with every step, then ' +
  'again each time a step starts or finishes, passing the whole list every time. Exactly one step is ' +
  'in_progress while you work on it. Write step titles short, in the language the user writes in.'

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description: 'Every step of the plan, in order.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the step does, in a few words.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        },
        required: ['title', 'status'],
      },
    },
  },
  required: ['steps'],
}

const BACKLOG_DESCRIPTION =
  "Keeps the project's backlog in the Task panel: things to do later, kept between chats. Add items when the user " +
  'says to do something later or next time, or when work is left over at the end of a task; mark items done by id ' +
  "once they are finished, and drop the ones no longer needed. One short line per item, in the user's language."

const BACKLOG_SCHEMA = {
  type: 'object',
  properties: {
    add: { type: 'array', items: { type: 'string' }, description: 'New items, one short line each.' },
    done: { type: 'array', items: { type: 'string' }, description: 'Ids of finished items, e.g. b3.' },
    drop: { type: 'array', items: { type: 'string' }, description: 'Ids of items no longer needed.' },
  },
}

const CHECK_BACKLOG =
  'Проверь бэклог проекта: по каждому пункту посмотри код, git и, если нужно, сервер, и реши, сделан ли он уже ' +
  'или больше не нужен. Сделанные закрой через backlog с done, ненужные с drop, остальные оставь как есть. ' +
  'В проекте ничего не меняй, только проверь, и коротко напиши, что закрыл и почему.'
const CLOSED_SHOWN = 3

const task = atom({ plugin: 'task-panel', key: 'task' } as const, null)
const now = atom({ plugin: 'task-panel', key: 'now' } as const, 0)
const isWorking = atom({ plugin: 'task-panel', key: 'isWorking' } as const, false)
const queue = atom({ plugin: 'task-panel', key: 'queue' } as const, [] as Queued[])
const idleSince = atom({ plugin: 'task-panel', key: 'idleSince' } as const, 0)
const actions = atom({ plugin: 'task-panel', key: 'actions' } as const, 0)
const nudged = atom({ plugin: 'task-panel', key: 'nudged' } as const, false)
const backlog = atom({ plugin: 'task-panel', key: 'backlog' } as const, emptyBacklog() as Backlog)
const backlogDraft = atom({ plugin: 'task-panel', key: 'backlogDraft' } as const, '')
const backlogClearing = atom({ plugin: 'task-panel', key: 'backlogClearing' } as const, false)

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

async function startTask($: EngineInterface, title: string, isGoal: boolean): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await update($, task, () => ({ title, isGoal, startedAt: at, finishedAt: null, steps: [] }))
  await update($, actions, () => 0)
  await update($, nudged, () => false)
  await openPane($)
}

async function changeSteps($: EngineInterface, change: (steps: readonly Step[]) => Step[]): Promise<void> {
  const at = await $.clock.now()
  const before = await read($, task)
  await update($, now, () => at)
  await update($, task, current => {
    const base: Task = current ?? { title: 'Текущая задача', isGoal: false, startedAt: at, finishedAt: null, steps: [] }
    return settle(base, change(base.steps), at)
  })
  if (before === null) await openPane($)
}

async function finishTask($: EngineInterface, isPlanless: boolean): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await update($, task, current => {
    if (current === null || current.finishedAt !== null) return current
    if (isPlanless && (current.isGoal || current.steps.length > 0)) return current
    return { ...current, finishedAt: at }
  })
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const waiting = await read($, queue)
  if (waiting.length > 0 && !(await read($, isWorking)) && at - (await read($, idleSince)) > STALE_QUEUE_MS) {
    await update($, queue, () => [])
  }
  const current = await read($, task)
  if (current === null || current.finishedAt !== null) return
  await update($, now, () => at)
}

async function enqueue($: EngineInterface, text: string, wait: boolean): Promise<void> {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('/')) return
  const at = await $.clock.now()
  await update($, queue, list => [...list, { id: `q${at}-${list.length}`, text: trimmed, at, wait }])
  await openPane($)
}

/** The queued prompts the model now reads, taken off the queue. */
async function dequeue($: EngineInterface, text: string, isEvery: boolean): Promise<Queued[]> {
  const waiting = await read($, queue)
  if (waiting.length === 0) return []
  const { taken, rest } = takeQueued(waiting, text, isEvery)
  if (taken.length > 0) await update($, queue, () => rest)
  return taken
}

/** One more action on the task at hand; the reminder to plan, when it is due. */
async function counted($: EngineInterface): Promise<string | null> {
  const current = await read($, task)
  if (current === null || current.finishedAt !== null) return null
  const count = (await read($, actions)) + 1
  await update($, actions, () => count)
  if (current.steps.length > 0 || count < NUDGE_AFTER || (await read($, nudged))) return null
  await update($, nudged, () => true)
  return NUDGE
}

function shortText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const points = [...line]
  return points.length > QUEUE_SHOWN ? `${points.slice(0, QUEUE_SHOWN - 1).join('')}…` : line
}

async function personSaid($: EngineInterface, text: string): Promise<void> {
  if (text.trim() === '' || text.trimStart().startsWith('/')) return
  const current = await read($, task)
  if (current === null || (current.finishedAt !== null && startsTask(text))) {
    await startTask($, titleOf(text), false)
    return
  }
  // A reply to a task that ended without a plan carries it on.
  if (current.finishedAt !== null && current.steps.length === 0) {
    await update($, task, one => (one === null ? one : { ...one, finishedAt: null }))
  }
}

async function backlogKey($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  return `backlog:${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

async function loadBacklog($: EngineInterface): Promise<Backlog> {
  const kept = restoreBacklog(await $.store.get(await backlogKey($)))
  await update($, backlog, () => kept)
  return kept
}

async function keepBacklog($: EngineInterface, next: Backlog): Promise<void> {
  await $.store.set(await backlogKey($), next)
  await update($, backlog, () => next)
}

async function personAddItem($: EngineInterface, text: string): Promise<void> {
  const checked = checkItem(text)
  if ('error' in checked) return
  await keepBacklog($, addItems(await read($, backlog), [checked.text], await $.clock.now(), 'person'))
  await update($, backlogDraft, () => '')
}

async function closeItem($: EngineInterface, id: string, how: 'done' | 'dropped'): Promise<void> {
  await keepBacklog($, closeItems(await read($, backlog), [id], how, await $.clock.now()))
}

async function reopen($: EngineInterface, id: string): Promise<void> {
  await keepBacklog($, reopenItem(await read($, backlog), id))
}

/** Every item closed as no longer needed: all of them can still come back from the closed list. */
async function clearAll($: EngineInterface): Promise<void> {
  await update($, backlogClearing, () => false)
  const current = await read($, backlog)
  await keepBacklog($, closeItems(current, current.items.map(item => item.id), 'dropped', await $.clock.now()))
}

/**
 * A request handed to Claude as the person's own. The plugin's own prompt
 * passes none of its own hooks: the task (or, while Claude works, its place in
 * the queue) is set here. It runs once Claude is idle.
 */
async function handOver($: EngineInterface, text: string, title: string): Promise<void> {
  if (await read($, isWorking)) await enqueue($, title, true)
  else await startTask($, titleOf(title), false)
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (error) {
    $.ui.toast(`Не удалось передать Claude: ${String(error)}`)
  }
}

/** The item handed to Claude, and off the list: it is the task now. */
async function takeItem($: EngineInterface, id: string): Promise<void> {
  const item = (await read($, backlog)).items.find(one => one.id === id)
  if (item === undefined) return
  await keepBacklog($, removeItems(await read($, backlog), [id]))
  await handOver($, item.text, item.text)
}

async function checkRelevance($: EngineInterface): Promise<void> {
  await handOver($, CHECK_BACKLOG, 'Проверка бэклога: что ещё актуально')
}

async function goalSet($: EngineInterface, condition: string): Promise<void> {
  const current = await read($, task)
  if (current !== null && current.finishedAt === null) {
    await update($, task, one => (one === null ? one : { ...one, title: condition, isGoal: true }))
    await openPane($)
    return
  }
  await startTask($, condition, true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'task-panel', description: 'Открыть пульт задачи: план, готовность и время' })
    await $.tool.register({ name: 'plan', description: PLAN_DESCRIPTION, inputSchema: PLAN_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'backlog', description: BACKLOG_DESCRIPTION, inputSchema: BACKLOG_SCHEMA, isDeferred: false })
    try {
      // A project with things left for later opens with them in view.
      if ((await loadBacklog($)).items.length > 0) void openPane($).catch(() => undefined)
    } catch {
      // No project to read from: the backlog starts empty.
    }
    $.clock.every(TICK_MS, () => {
      tick($).catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'task-panel' }, async ($, e) => {
    await openPane($)
    // Opened by another plugin: no line in the chat.
    return e.origin.kind === 'plugin' ? {} : { text: 'Пульт задачи открыт.' }
  })

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const result = await next(e)
    const condition = e.args.trim()
    if (condition === '') return result
    if (GOAL_CLEAR.test(condition)) await finishTask($, false)
    else await goalSet($, titleOf(condition))
    return result
  }).catch(($, e, next) => next(e))

  // Typed while Claude works, a prompt waits in the queue; it counts as said
  // once the model reads it.
  on('prompt.submit', async ($, e, next) => {
    if (isPerson(e.origin)) {
      if (e.turnId !== undefined || (await read($, isWorking))) await enqueue($, e.text, e.wait)
      else await personSaid($, e.text)
    }
    return next(e)
  })

  // Read mid-turn, after a step: it joins the task at hand.
  on('prompt.attachment', { type: 'queued_command' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await dequeue($, e.text, false)
    return result
  }).catch(($, e, next) => next(e))

  // Read as the turn it starts: it may start a task of its own.
  on('turn.start', async ($, e, next) => {
    for (const item of await dequeue($, e.text, true)) await personSaid($, item.text)
    await update($, isWorking, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, isWorking, () => false)
      await update($, idleSince, () => at)
      await finishTask($, true)
    }
    return result
  })

  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const text = `${BRIEFING}\n\n${backlogBriefing(await read($, backlog), BACKLOG_TOOL)}`
    return { ...context, blocks: [...context.blocks, { name: 'taskPanel', text }] }
  })

  // Each action of the main thread counts; a long run without a plan gets one reminder.
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined || PLAN_TOOLS.has(e.tool_name)) return result
    const note = await counted($)
    return note === null ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: BACKLOG_TOOL }, async ($, e) => {
    const input = e as unknown as { add?: unknown; done?: unknown; drop?: unknown }
    const errors: string[] = []
    const adds: string[] = []
    for (const one of Array.isArray(input.add) ? input.add : []) {
      const checked = checkItem(one)
      if ('error' in checked) errors.push(`"${String(one).slice(0, 60)}": ${checked.error}`)
      else adds.push(checked.text)
    }
    const current = await read($, backlog)
    const ids = Array.isArray(input.done) ? input.done.map(String) : []
    const drops = Array.isArray(input.drop) ? input.drop.map(String) : []
    for (const id of [...ids, ...drops]) if (!current.items.some(item => item.id === id)) errors.push(`нет пункта ${id}`)
    if (errors.length > 0) return { deny: `Бэклог не изменён: ${errors.join('; ')}.` }
    if (adds.length === 0 && ids.length === 0 && drops.length === 0) return { deny: 'Нечего менять: передай add, done или drop.' }
    const at = await $.clock.now()
    const next = addItems(closeItems(closeItems(current, ids, 'done', at), drops, 'dropped', at), adds, at, 'claude')
    await keepBacklog($, next)
    // What is new, an item already on the list not counted again.
    const before = new Set(current.items.map(item => item.id))
    const added = next.items.filter(item => !before.has(item.id)).map(item => `[${item.id}] ${item.text}`)
    const change = [
      added.length > 0 ? `+${added.length}` : '',
      ids.length > 0 ? `готово ${ids.length}` : '',
      drops.length > 0 ? `не актуально ${drops.length}` : '',
    ]
      .filter(Boolean)
      .join(', ')
    if (change !== '') $.ui.toast(`Бэклог: ${change}`)
    return { result: `Бэклог проекта: пунктов ${next.items.length}.${added.length > 0 ? ` Добавлено: ${added.join('; ')}.` : ''}` }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const plan = fromPlan((e as { steps?: unknown }).steps)
    if (plan === null) return { deny: 'steps: нужен список шагов { title, status }, status — pending, in_progress или completed.' }
    await changeSteps($, () => plan)
    const { done, total } = progress(plan)
    return { result: `План на пульте: готово ${done} из ${total}.` }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      await changeSteps($, () => fromTodos(e.todos))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const created = ran.result.task
      await changeSteps($, steps => withCreated(steps, created.id, created.subject))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true && ran.result.success) {
      await changeSteps($, steps => withUpdate(steps, e.taskId, { status: e.status, title: e.subject }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const tasks = ran.result.tasks
      await changeSteps($, () => fromTaskList(tasks))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ProposeGoal' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      await goalSet($, titleOf(ran.result.condition))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // A surface without text fields (mobile) adds to the backlog through the chat.
    const Input = 'Input' in elements ? elements.Input : undefined
    const current = await read($, task)
    const later = await read($, backlog)
    const draft = await read($, backlogDraft)
    const clearing = await read($, backlogClearing)
    const nowMs = await $.clock.now()
    const recentlyClosed = [...later.closed].reverse().slice(0, CLOSED_SHOWN)
    const at = await read($, now)
    const working = await read($, isWorking)
    const waiting = await read($, queue)
    const actionCount = await read($, actions)
    const width = Math.max(12, e.props.bodyColumns - 1)

    // What waits to be read, at the top, with when it will be.
    const queued =
      waiting.length > 0 ? (
        <Box key="queue" flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text dimColor>ОЧЕРЕДЬ</Text>
            <Text color="claude">{waiting.length}</Text>
          </Box>
          {waiting.map((item, index) => (
            <Box key={item.id}>
              <Box width={NUMERAL_WIDTH} flexShrink={0}>
                <Text color="claude">{index + 1}.</Text>
              </Box>
              <Box flexGrow={1}>
                <Text wrap="wrap">
                  {shortText(item.text)}
                  {item.wait ? <Text dimColor> · после задачи</Text> : ''}
                </Text>
              </Box>
            </Box>
          ))}
          <Text dimColor wrap="wrap">
            {queueHint(waiting, working)}
          </Text>
        </Box>
      ) : null

    // What is left for later in this project, below everything else.
    const backlogBlock = (
      <Box key="backlog" flexDirection="column" marginTop={2}>
        <Box marginBottom={1}>
          <Text dimColor>{later.items.length === 0 ? 'БЭКЛОГ ПРОЕКТА · пусто' : `БЭКЛОГ ПРОЕКТА · ${later.items.length}`}</Text>
        </Box>
        {later.items.length > 0 &&
          (clearing ? (
            <Box flexDirection="column" marginBottom={2}>
              <Text color="warning" wrap="wrap">
                Убрать все пункты ({later.items.length}) как неактуальные? Их можно будет вернуть из закрытых.
              </Text>
              <Box marginTop={1} gap={1}>
                <Button key="backlog-clear-yes" label="Да, очистить" onPress={() => void clearAll($)} />
                <Button key="backlog-clear-no" label="Отмена" onPress={() => void update($, backlogClearing, () => false)} />
              </Box>
            </Box>
          ) : (
            <Box marginBottom={2} gap={1} flexWrap="wrap">
              <Button key="backlog-check" label="Проверить, что актуально" onPress={() => void checkRelevance($)} />
              <Button key="backlog-clear" label="Очистить всё" onPress={() => void update($, backlogClearing, () => true)} />
            </Box>
          ))}
        {later.items.length === 0 && (
          <Text dimColor wrap="wrap">
            Скажи Claude "сделаем потом", и пункт появится здесь.
          </Text>
        )}
        {later.items.map((item, index) => {
          const isOld = isStale(item.at, nowMs)
          return (
            <Box key={item.id} flexDirection="column" {...(index > 0 ? { marginTop: 2 } : {})}>
              <Box>
                <Box width={NUMERAL_WIDTH} flexShrink={0}>
                  <Text dimColor>{index + 1}.</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text wrap="wrap">{item.text}</Text>
                </Box>
              </Box>
              <Box marginLeft={NUMERAL_WIDTH}>
                <Text {...(isOld ? { color: 'warning' } : { dimColor: true })}>
                  {item.by === 'claude' ? 'Claude' : 'ты'} · {ageText(item.at, nowMs)}
                  {isOld ? ' · давно, ещё нужно?' : ''}
                </Text>
              </Box>
              {/* Real buttons, a row under the text, so they read as buttons. */}
              <Box marginLeft={NUMERAL_WIDTH} marginTop={1} gap={1} flexWrap="wrap">
                <Button key={`take-${item.id}`} label="в работу" onPress={() => void takeItem($, item.id)} />
                <Button key={`done-${item.id}`} label="✓ сделано" onPress={() => void closeItem($, item.id, 'done')} />
                <Button key={`drop-${item.id}`} label="✕ не актуально" onPress={() => void closeItem($, item.id, 'dropped')} />
              </Box>
            </Box>
          )
        })}
        {recentlyClosed.length > 0 && (
          <Box marginTop={2} flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>ЗАКРЫТО НЕДАВНО</Text>
            </Box>
            {recentlyClosed.map((item, index) => (
              <Box key={`closed-${item.id}`} {...(index > 0 ? { marginTop: 1 } : {})}>
                <Box flexGrow={1}>
                  <Text dimColor wrap="wrap">
                    {item.how === 'done' ? '✓' : '✕'} {item.text}
                  </Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Button key={`reopen-${item.id}`} label="вернуть" onPress={() => void reopen($, item.id)} />
                </Box>
              </Box>
            ))}
          </Box>
        )}
        {/* A field drawn taller than its row: a hint under it and a spare row keep it whole at the pane's bottom. */}
        {Input !== undefined && (
          <Box marginTop={2} marginBottom={1} flexDirection="column">
            <Input
              key="backlog-add"
              placeholder="Добавить на потом"
              value={draft}
              onInput={value => void update($, backlogDraft, () => value)}
              onSubmit={value => void personAddItem($, value)}
            />
            <Box marginTop={1}>
              <Text dimColor>Enter, чтобы добавить</Text>
            </Box>
          </Box>
        )}
      </Box>
    )

    if (current === null) {
      return (
        <Box flexDirection="column">
          {queued}
          <Text dimColor>ЗАДАЧА</Text>
          <Text>не задана</Text>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Напиши, что сделать, или поставь цель через /goal.
            </Text>
          </Box>
          {backlogBlock}
        </Box>
      )
    }

    const percent = readiness(current)
    const { done, total } = progress(current.steps)
    const isDone = current.finishedAt !== null && percent === 100
    const green = isDone ? { color: 'success' } : {}
    const elapsed = formatElapsed((current.finishedAt ?? Math.max(at, current.startedAt)) - current.startedAt)
    const stage =
      total === 0
        ? actionCount > 0 && current.finishedAt === null
          ? `БЕЗ ПЛАНА · ДЕЙСТВИЙ: ${actionCount}`
          : 'ПЛАН НЕ СОСТАВЛЕН'
        : done === total
          ? `ВСЕ ЭТАПЫ ВЫПОЛНЕНЫ · ${roman(total)}`
          : `ЭТАП ${roman(currentStep(current.steps))} ИЗ ${roman(total)}`
    const mode = isDone
      ? `🪴 ВСЁ ГОТОВО ЗА ${elapsed.toUpperCase()}`
      : current.finishedAt !== null
        ? 'ОСТАНОВЛЕНО'
        : working
          ? 'РЕЖИМ: РАБОТАЮ'
          : 'РЕЖИМ: ЖДУ ТЕБЯ'

    return (
      <Box flexDirection="column">
        {queued}
        <Text dimColor>{current.isGoal ? 'ЦЕЛЬ · /goal' : 'ЗАДАЧА'}</Text>
        <Text wrap="wrap">
          «{current.title}»
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Box justifyContent="space-between">
            <Text dimColor>ГОТОВНОСТЬ</Text>
            <Text {...green}>{total === 0 && current.finishedAt === null ? '—' : `${percent} %`}</Text>
          </Box>
          <Text wrap="truncate" {...(isDone ? green : { color: 'claude' })}>
            {bar(percent, Math.min(24, width))}
          </Text>
          <Box justifyContent="space-between">
            <Text dimColor>{stage}</Text>
            <Text dimColor>⏱ {elapsed}</Text>
          </Box>
        </Box>
        {total > 0 && (
          <Box marginTop={1} flexDirection="column">
            {current.steps.map((step, index) => {
              // A done step goes grey with its tick green; the one at work in the accent colour.
              const look = step.status === 'in_progress' ? { color: 'claude' } : { dimColor: true }
              const markLook = step.status === 'completed' ? { color: 'success' } : look
              return (
                <Box key={step.id}>
                  <Box width={NUMERAL_WIDTH} flexShrink={0}>
                    <Text {...look}>{roman(index + 1)}.</Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text wrap="wrap" {...look}>
                      {step.title}
                    </Text>
                  </Box>
                  <Box width={2} flexShrink={0} justifyContent="flex-end">
                    <Text {...markLook}>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '←' : ' '}</Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor={!isDone} {...green}>
            {mode}
          </Text>
        </Box>
        {backlogBlock}
      </Box>
    )
  })
}
