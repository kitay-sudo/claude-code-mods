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

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderElement } from 'claude-code'

import type { Queued, Step, Task } from '../types'
import {
  bar,
  currentStep,
  formatElapsed,
  fromPlan,
  fromTaskList,
  fromTodos,
  progress,
  queueHint,
  readiness,
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
const TICK_MS = 20_000
const NUMERAL_WIDTH = 7
const QUEUE_SHOWN = 90
// Idle with prompts still queued means they were taken back: the engine starts
// a queued prompt as soon as the session is idle.
const STALE_QUEUE_MS = 15_000
// Tools that keep the plan itself, not work on the task.
const PLAN_TOOLS = new Set([PLAN_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
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

const task = atom({ plugin: 'task-panel', key: 'task' } as const, null)
const now = atom({ plugin: 'task-panel', key: 'now' } as const, 0)
const isWorking = atom({ plugin: 'task-panel', key: 'isWorking' } as const, false)
const queue = atom({ plugin: 'task-panel', key: 'queue' } as const, [] as Queued[])
const idleSince = atom({ plugin: 'task-panel', key: 'idleSince' } as const, 0)
const actions = atom({ plugin: 'task-panel', key: 'actions' } as const, 0)
const nudged = atom({ plugin: 'task-panel', key: 'nudged' } as const, false)

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
    $.clock.every(TICK_MS, () => {
      tick($).catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'task-panel' }, async $ => {
    await openPane($)
    return { text: 'Пульт задачи открыт.' }
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
    return { ...context, blocks: [...context.blocks, { name: 'taskPanel', text: BRIEFING }] }
  })

  // Each action of the main thread counts; a long run without a plan gets one reminder.
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined || PLAN_TOOLS.has(e.tool_name)) return result
    const note = await counted($)
    return note === null ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), note] }
  }).catch(($, e, next) => next(e))

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
    const { Box, Text } = $.ui.resolve(e)
    const current = await read($, task)
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
      </Box>
    )
  })
}
