// spend-meter: what developing this project costs, in rubles, always in view.
//
// At the right of the first line of the shared block above the prompt: this
// session, the project's total and today's spend. The /spend pane breaks it down by day,
// shows how full the subscription's windows are (5 hours, week) with their
// reset times, warned about at 80 % and 95 %, and a budget for the project,
// warned about at 80 % and 100 %. Rubles at a fixed rate, the
// `rubPerUsd` option (87 when not set).
//
// Costs are the session's ledger as /cost totals it (API prices). Each run of
// a session is added to the project whole, the part before the meter was
// installed too, and a resumed or reloaded one only for what is new, so
// nothing is counted twice.
//
// Time on the project beside the money: while Claude works, and the person's
// pauses up to 10 minutes; a longer break is not work. Every chat of the
// project writes to one record, so two chats at once do not count twice.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderElement } from 'claude-code'

import type { SpendDraft, SpendView } from '../types'
import {
  addSpend,
  bar,
  crossed,
  dayKey,
  emptySpend,
  formatDuration,
  formatUsd,
  lastDays,
  limitLabel,
  limitsFrom,
  money,
  newSpend,
  resetLabel,
  restoreSpend,
  shortDay,
  timeIn,
  totalTime,
  touched,
} from './money'
import { joinRow } from './status-row'

const PANE = 'spend-meter'
const PANE_TITLE = 'Расход'
const DEFAULT_RUB_PER_USD = 87
const TICK_MS = 30_000
const LIMIT_MARKS = [80, 95]
const BUDGET_MARKS = [80, 100]
const SHOWN_DAYS = 7
const DAY_BAR = 18
// The time's mark; ⏱ is the cache's, beside it in the same block.
const CLOCK = '🕐'

const EMPTY_VIEW: SpendView = { sessionUsd: null, project: emptySpend(''), limits: [], today: '' }
const EMPTY_DRAFT: SpendDraft = { budget: '', error: '' }

const view = atom({ plugin: 'spend-meter', key: 'view' } as const, EMPTY_VIEW)
const seen = atom({ plugin: 'spend-meter', key: 'seen' } as const, null)
const warned = atom({ plugin: 'spend-meter', key: 'warned' } as const, [])
const draft = atom({ plugin: 'spend-meter', key: 'draft' } as const, EMPTY_DRAFT)
const project = atom({ plugin: 'spend-meter', key: 'project' } as const, '')
const isWorking = atom({ plugin: 'spend-meter', key: 'isWorking' } as const, false)

// Prompts the person wrote, or pressed as a suggestion.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

function isPerson(origin: PromptOrigin): boolean {
  return PERSON.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
}

function limitLook(percent: number): Record<string, string | boolean> {
  if (percent >= 95) return { color: 'error' }
  if (percent >= 80) return { color: 'warning' }
  return { dimColor: true }
}

async function storeKey($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  return `spend:${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

async function load($: EngineInterface): Promise<void> {
  const [cwd, now] = await Promise.all([$.session.cwd(), $.clock.now()])
  const today = dayKey(now)
  const spend = restoreSpend(await $.store.get(await storeKey($)), today)
  await update($, view, one => ({ ...one, project: spend, today }))
  await update($, project, () => cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? cwd)
}

async function warnOnce($: EngineInterface, key: string, text: string): Promise<void> {
  const done = await read($, warned)
  if (done.includes(key)) return
  await update($, warned, list => [...list, key].slice(-50))
  $.ui.toast(text, { timeoutMs: 15_000 })
}

async function warnings($: EngineInterface, before: SpendView, after: SpendView, rub: number): Promise<void> {
  for (const limit of after.limits) {
    const was = before.limits.find(one => one.kind === limit.kind)?.percent ?? 0
    for (const mark of crossed(was, limit.percent, LIMIT_MARKS)) {
      await warnOnce(
        $,
        `limit:${limit.kind}:${mark}:${limit.resetsAt ?? ''}`,
        `Лимит «${limitLabel(limit.kind)}» использован на ${Math.round(limit.percent)}%${limit.resetsAt === undefined ? '' : `, ${resetLabel(limit.resetsAt, Date.parse(limit.resetsAt) - 1)}`}`,
      )
    }
  }
  const budget = after.project.budgetRub
  if (budget !== null) {
    const was = ((before.project.usd * rub) / budget) * 100
    const now = ((after.project.usd * rub) / budget) * 100
    for (const mark of crossed(was, now, BUDGET_MARKS)) {
      await warnOnce($, `budget:${budget}:${mark}`, `Бюджет проекта: потрачено ${Math.round(now)}% (${money(after.project.usd, rub)} из ${money(budget / rub, rub)})`)
    }
  }
}

// Reads the session's cost and windows; adds what is new to the project.
async function refresh($: EngineInterface, rub: number): Promise<void> {
  const [usage, now] = await Promise.all([$.session.usage(), $.clock.now()])
  const today = dayKey(now)
  const usd = usage.cost?.usd ?? null
  const before = await read($, view)
  let spend = before.project
  if (usd !== null) {
    const run = String(usage.startedAt)
    const last = await read($, seen)
    // Fresh from the store: another session of the project may have added since.
    const key = await storeKey($)
    const stored = restoreSpend(await $.store.get(key), today)
    const counted = newSpend(stored.counted, run, usd, last)
    spend = addSpend({ ...stored, counted: counted.counted }, counted.delta, today)
    if (counted.delta > 0 || stored.counted[run] !== usd) await $.store.set(key, spend)
    await update($, seen, () => ({ run, usd }))
  }
  const after: SpendView = { sessionUsd: usd, project: spend, limits: limitsFrom(usage.rateLimits), today }
  await update($, view, () => after)
  await warnings($, before, after, rub)
}

/** One more activity in this project: the work since the last one, in any chat, added to its day. */
async function touch($: EngineInterface, isWorkingNow: boolean): Promise<void> {
  const key = await storeKey($)
  const now = await $.clock.now()
  const today = dayKey(now)
  const next = touched(restoreSpend(await $.store.get(key), today), now, isWorkingNow)
  await $.store.set(key, next)
  await update($, view, one => ({ ...one, project: next, today }))
}

/** What the model knows of the time, for "how long did it take" and a client report that wants hours. */
function timeBriefing(shown: SpendView): string {
  const today = shown.project.time[shown.today] ?? 0
  return (
    `Time spent on this project (counted by spend-meter: Claude working, and the user's pauses up to 10 minutes): ` +
    `today ${formatDuration(today)}, last 7 days ${formatDuration(timeIn(shown.project, shown.today, 7))}, ` +
    `since ${shortDay(shown.project.since)} ${formatDuration(totalTime(shown.project))}. ` +
    'Use it when the user asks how long the work took, or in a client report when they want the hours.'
  )
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

async function editBudget($: EngineInterface, value: string): Promise<void> {
  await update($, draft, () => ({ budget: value, error: '' }))
}

async function setBudget($: EngineInterface, isClearing: boolean): Promise<void> {
  const value = isClearing ? null : Number((await read($, draft)).budget.replace(/\s/g, '').replace(',', '.'))
  if (value !== null && !(value > 0)) {
    await update($, draft, one => ({ ...one, error: 'Бюджет: число рублей, например 20000' }))
    return
  }
  const key = await storeKey($)
  const today = (await read($, view)).today
  const spend = { ...restoreSpend(await $.store.get(key), today), budgetRub: value }
  await $.store.set(key, spend)
  await update($, view, one => ({ ...one, project: spend }))
  await update($, warned, list => list.filter(one => !one.startsWith('budget:')))
  await update($, draft, () => EMPTY_DRAFT)
}

export const register: Register = (on, options) => {
  const rate = Number(options.rubPerUsd)
  const rub = rate > 0 ? rate : DEFAULT_RUB_PER_USD

  on('session.start', async ($, e, next) => {
    await load($)
    await $.command.register({ name: 'spend', description: 'Открыть расход: стоимость проекта в рублях, по дням, лимиты подписки, бюджет' })
    $.clock.every(TICK_MS, () => {
      refresh($, rub).catch(() => undefined)
      // While Claude works the time runs on; at rest only the person's next step counts the pause.
      void read($, isWorking)
        .then(working => (working ? touch($, true) : undefined))
        .catch(() => undefined)
    })
    refresh($, rub).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => {
    await openPane($)
    return { text: 'Расход открыт.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isPerson(e.origin)) await touch($, false).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await touch($, false).catch(() => undefined)
    await update($, isWorking, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await touch($, true).catch(() => undefined)
      await update($, isWorking, () => false)
      await refresh($, rub).catch(() => undefined)
    }
    return result
  })

  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    return { ...context, blocks: [...context.blocks, { name: 'projectTime', text: timeBriefing(await read($, view)) }] }
  })

  // At the right of the status line: what it costs. The subscription's windows stay in the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next): Promise<RenderElement> => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return below
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, view)
    const todayUsd = shown.project.days[shown.today] ?? 0
    const todayTime = shown.project.time[shown.today] ?? 0
    const budget = shown.project.budgetRub
    const budgetPercent = budget !== null ? Math.round(((shown.project.usd * rub) / budget) * 100) : null

    const spend = (
      <Box key="seg-3-spend" gap={1}>
        <Text color="claude">₽</Text>
        {shown.sessionUsd === null ? <Text dimColor>расход недоступен</Text> : <Text>сессия {money(shown.sessionUsd, rub)}</Text>}
        <Text dimColor>
          · проект {money(shown.project.usd, rub)} · сегодня {money(todayUsd, rub)}
          {todayTime >= 60_000 ? ` · ${CLOCK} ${formatDuration(todayTime)}` : ''}
        </Text>
        {budgetPercent !== null && <Text {...limitLook(budgetPercent)}>· бюджет {budgetPercent}%</Text>}
      </Box>
    )
    return joinRow(below, spend, Box, 'status')
  })

  // The pane in sections with air between them, headings a row above their
  // content: money and time, by day, the subscription's windows, the budget.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // A surface without text fields (mobile) shows the figures alone.
    const Input = 'Input' in elements ? elements.Input : undefined
    const shown = await read($, view)
    const form = await read($, draft)
    const name = await read($, project)
    const now = await $.clock.now()
    const days = lastDays(shown.project, shown.today, SHOWN_DAYS)
    const weekUsd = days.reduce((sum, one) => sum + one.usd, 0)
    const top = Math.max(...days.map(one => one.usd), 0)
    const budget = shown.project.budgetRub
    const budgetPercent = budget !== null ? ((shown.project.usd * rub) / budget) * 100 : null
    const todayTime = shown.project.time[shown.today] ?? 0
    const weekTime = timeIn(shown.project, shown.today, SHOWN_DAYS)
    const allTime = totalTime(shown.project)

    const heading = (key: string, text: string) => (
      <Box key={key} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {heading('h-project', 'РАСХОД НА РАЗРАБОТКУ')}
        <Text>{name}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text>{money(shown.project.usd, rub)}</Text>
            <Text dimColor>
              {' '}
              всего с {shortDay(shown.project.since)} · {formatUsd(shown.project.usd)}
            </Text>
          </Text>
          <Text dimColor>
            сессия {shown.sessionUsd === null ? '—' : money(shown.sessionUsd, rub)} · сегодня {money(shown.project.days[shown.today] ?? 0, rub)} · 7 дней{' '}
            {money(weekUsd, rub)}
          </Text>
          {budget !== null && budgetPercent !== null && (
            <Text {...limitLook(budgetPercent)}>
              бюджет {money(budget / rub, rub)} {bar(budgetPercent, 16)} {Math.round(budgetPercent)}%
            </Text>
          )}
        </Box>

        <Box marginTop={2} flexDirection="column">
          {heading('h-time', 'ВРЕМЯ НА ПРОЕКТ')}
          <Text>
            {CLOCK} сегодня {formatDuration(todayTime)} · 7 дней {formatDuration(weekTime)}
          </Text>
          <Text dimColor>
            всего с {shortDay(shown.project.since)}: {formatDuration(allTime)}
          </Text>
        </Box>

        <Box marginTop={2} flexDirection="column">
          {heading('h-days', 'ПО ДНЯМ')}
          {days.map(one => {
            const ms = shown.project.time[one.day] ?? 0
            return (
              <Box key={`day-${one.day}`}>
                <Box width={7} flexShrink={0}>
                  <Text dimColor>{shortDay(one.day)}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color="claude" wrap="truncate">
                    {bar(top === 0 ? 0 : (one.usd / top) * 100, DAY_BAR)}
                  </Text>
                </Box>
                <Text {...(one.usd === 0 && ms < 60_000 ? { dimColor: true } : {})}>
                  {' '}
                  {money(one.usd, rub)}
                  {ms >= 60_000 ? ` · ${CLOCK} ${formatDuration(ms)}` : ''}
                </Text>
              </Box>
            )
          })}
        </Box>

        <Box marginTop={2} flexDirection="column">
          <Text dimColor wrap="wrap">
            Сессия: этот чат с его начала. Проект: все чаты в этой папке с {shortDay(shown.project.since)}, когда заработал счётчик, каждый
            чат целиком. Время: пока Claude работает, и твои паузы между сообщениями до 10 минут. Перерывы дольше не считаются, а два
            чата одного проекта одновременно не считаются дважды. Курс: {rub} ₽ за доллар.
          </Text>
        </Box>

        <Box marginTop={2} flexDirection="column">
          {heading('h-limits', 'ЛИМИТЫ ПОДПИСКИ')}
          <Text dimColor wrap="wrap">
            Сколько использовано из окон подписки: 5-часового и недельного. На 100% придётся ждать сброса.
          </Text>
          {shown.limits.length === 0 && <Text dimColor>Появятся после первого ответа, если вход по подписке.</Text>}
          {shown.limits.map(limit => (
            <Box key={`limit-${limit.kind}`} flexDirection="column" marginTop={1}>
              <Box gap={1}>
                <Text>{limitLabel(limit.kind)}</Text>
                <Text {...limitLook(limit.percent)}>
                  {bar(limit.percent, 16)} {Math.round(limit.percent)}%
                </Text>
              </Box>
              {limit.resetsAt !== undefined && <Text dimColor>{resetLabel(limit.resetsAt, now)}</Text>}
            </Box>
          ))}
        </Box>

        <Box marginTop={2} flexDirection="column">
          {heading('h-budget', 'БЮДЖЕТ ПРОЕКТА')}
          {Input !== undefined && (
            <Input
              key="sm-budget"
              placeholder={budget === null ? 'например 20000' : String(Math.round(budget))}
              value={form.budget}
              onInput={value => void editBudget($, value)}
              onSubmit={value => void editBudget($, value).then(() => setBudget($, false))}
            />
          )}
          <Text dimColor>рублей на весь проект, Enter чтобы сохранить</Text>
          {budget !== null && (
            <Box marginTop={1}>
              <Button key="sm-budget-clear" label="Убрать бюджет" onPress={() => void setBudget($, true)} />
            </Box>
          )}
          {form.error !== '' && (
            <Text color="error" wrap="wrap">
              {form.error}
            </Text>
          )}
        </Box>

        <Box marginTop={2}>
          <Text dimColor wrap="wrap">
            Стоимость считается по ценам API Anthropic, как в /cost. На подписке это оценка стоимости работы, а не списание. Реальные
            ограничения подписки это лимиты выше.
          </Text>
        </Box>
      </Box>
    )
  })
}
