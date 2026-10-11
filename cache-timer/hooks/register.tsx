// cache-timer: in the shared row above the prompt, the minutes left before
// this chat's prompt cache cools, the tokens in context and a «Сжать» button
// that runs /compact. A toast warns shortly before the cache cools.
//
// The cache is refreshed by every request of the main conversation, so the
// countdown starts when the last request that came back was sent. The engine
// does not say which TTL the account has; the `cacheTtl` option does.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { CacheGauge } from '../types'
import { joinRow } from './status-row'

const MINUTE = 60_000
const TICK_MS = 15_000
const TOAST_MS = MINUTE

const lastAt = atom({ plugin: 'cache-timer', key: 'lastAt' } as const, null)
const warnedFor = atom({ plugin: 'cache-timer', key: 'warnedFor' } as const, null)
const gauge = atom({ plugin: 'cache-timer', key: 'gauge' } as const, {
  minutesLeft: null,
  tokens: null,
  window: 0,
})
const isCompacting = atom({ plugin: 'cache-timer', key: 'isCompacting' } as const, false)

function short(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

function describeGauge(shown: CacheGauge): string {
  const cache =
    shown.minutesLeft === null
      ? 'кэш: —'
      : shown.minutesLeft === 0
        ? 'кэш остыл'
        : `кэш: ${shown.minutesLeft} мин`
  if (shown.tokens === null) return `${cache} · контекст: —`
  const percent = shown.window > 0 ? ` (${Math.round((shown.tokens / shown.window) * 100)}%)` : ''
  return `${cache} · контекст: ${short(shown.tokens)} из ${short(shown.window)}${percent}`
}

function isSame(a: CacheGauge, b: CacheGauge): boolean {
  return a.minutesLeft === b.minutesLeft && a.tokens === b.tokens && a.window === b.window
}

type Timing = { ttlMs: number; leadMs: number }

// Whether a main-conversation turn runs now; a reload resets it, which is fine.
let isWorking = false

async function refresh($: EngineInterface, timing: Timing): Promise<void> {
  const [now, at, usage] = await Promise.all([$.clock.now(), read($, lastAt), $.session.usage()])
  const msLeft = at === null ? null : Math.max(0, at + timing.ttlMs - now)
  const fresh: CacheGauge = {
    minutesLeft: msLeft === null ? null : Math.ceil(msLeft / MINUTE),
    tokens: usage.context.tokens ?? null,
    window: usage.context.window,
  }
  if (!isSame(await read($, gauge), fresh)) await update($, gauge, () => fresh)

  if (at === null || msLeft === null || msLeft === 0 || msLeft > timing.leadMs || isWorking) return
  if ((await read($, warnedFor)) === at) return
  await update($, warnedFor, () => at)
  $.ui.toast(
    `Кэш чата остынет через ${Math.ceil(msLeft / MINUTE)} мин. ` +
      'Потом следующий запрос заново запишет весь контекст в кэш: сожми его или продолжи разговор.',
    { timeoutMs: TOAST_MS },
  )
}

function refreshLater($: EngineInterface, timing: Timing): void {
  refresh($, timing).catch(error => $.ui.log(`refresh failed: ${String(error)}`, { to: 'debug' }))
}

async function forget($: EngineInterface, timing: Timing): Promise<void> {
  await update($, lastAt, () => null)
  await update($, warnedFor, () => null)
  await refresh($, timing)
}

async function compact($: EngineInterface): Promise<void> {
  await update($, isCompacting, () => true)
  try {
    await $.command.run({ command: 'compact' })
  } catch (error) {
    $.ui.toast(`Не удалось сжать: ${String(error)}`)
  } finally {
    await update($, isCompacting, () => false)
  }
}

export const register: Register = (on, options) => {
  const ttlMs = (options.cacheTtl === '5m' ? 5 : 60) * MINUTE
  // With a 5-minute cache a 5-minute warning would fire right after every answer.
  const timing: Timing = { ttlMs, leadMs: ttlMs > 5 * MINUTE ? 5 * MINUTE : MINUTE }

  on('session.start', async ($, e, next) => {
    // A reload mid-compaction leaves no `finally` to clear the flag.
    await update($, isCompacting, () => false)
    $.clock.every(TICK_MS, () => refreshLater($, timing))
    await refresh($, timing)
    return next(e)
  })

  // A resumed chat: count from its last answer, so a warm cache shows as warm.
  on('classic.SessionStart', async ($, e, next) => {
    const seconds = e.seconds_since_last_response
    if (seconds !== undefined) {
      const now = await $.clock.now()
      await update($, lastAt, () => now - seconds * 1000)
      await refresh($, timing)
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      isWorking = false
      await refresh($, timing)
    }
    return result
  })

  // Each request of the main conversation reads and refreshes the cache; a
  // subagent's requests carry a prefix of their own.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage !== null) {
      await update($, lastAt, () => sentAt)
      await refresh($, timing)
    }
    return result
  })

  // After a compaction the conversation is new: nothing of it is cached yet.
  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== 'precompute'
    if (isMain) await update($, isCompacting, () => true)
    try {
      const result = await next(e)
      if (isMain && result.messages !== undefined) await forget($, timing)
      return result
    } finally {
      if (isMain) await update($, isCompacting, () => false)
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await forget($, timing)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next): Promise<RenderElement> => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return below
    const shown = await read($, gauge)
    const compacting = await read($, isCompacting)
    const { Box, Text, Button } = $.ui.resolve(e)

    return joinRow(
      below,
      <Box key="seg-1-cache" gap={1}>
        <Text dimColor>⏱ {describeGauge(shown)}</Text>
        {compacting ? (
          <Text dimColor>сжимаю…</Text>
        ) : e.props.isWorking || shown.tokens === null ? null : (
          <Button key="compact" label="Сжать" onPress={() => void compact($)} />
        )}
      </Box>,
      Box,
      'status',
    )
  })
}
