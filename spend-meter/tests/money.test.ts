import { expect, test } from 'claude-code/testing'

import {
  IDLE_MS,
  activeGap,
  addSpend,
  bar,
  crossed,
  emptySpend,
  formatDuration,
  formatRub,
  lastDays,
  limitLabel,
  limitShort,
  money,
  newSpend,
  restoreSpend,
  timeIn,
  totalTime,
  touched,
} from '../hooks/money'

const NBSP = '\u00a0'

test('rubles read as people write them', () => {
  expect(formatRub(1240.4)).toBe(`1${NBSP}240${NBSP}₽`)
  expect(formatRub(186_000)).toBe(`186${NBSP}000${NBSP}₽`)
  expect(formatRub(3.44)).toBe(`3,4${NBSP}₽`)
  expect(money(2, 94.5)).toBe(`189${NBSP}₽`)
})

test('spending adds up by day, and the last days fill the gaps with zero', () => {
  let spend = emptySpend('2026-10-09')
  spend = addSpend(spend, 1.5, '2026-10-09')
  spend = addSpend(spend, 2, '2026-10-11')
  spend = addSpend(spend, -3, '2026-10-11')
  expect(spend.usd).toBe(3.5)
  expect(lastDays(spend, '2026-10-11', 3)).toEqual([
    { day: '2026-10-09', usd: 1.5 },
    { day: '2026-10-10', usd: 0 },
    { day: '2026-10-11', usd: 2 },
  ])
  expect(
    restoreSpend(
      { usd: 'x', days: { bad: 1, '2026-10-11': 2 }, budgetRub: 0, counted: { x: 1, '5': 3 }, time: { bad: 5, '2026-10-11': 60_000 }, lastActive: 'x' },
      '2026-10-11',
    ),
  ).toEqual({
    usd: 0,
    days: { '2026-10-11': 2 },
    since: '2026-10-11',
    budgetRub: null,
    counted: { '5': 3 },
    time: { '2026-10-11': 60_000 },
    lastActive: 0,
  })
})

test('time counts work and short pauses, not breaks, and reads as hours and minutes', () => {
  const MINUTE = 60_000
  // While Claude works every minute counts, a computer's sleep only up to the idle limit.
  expect(activeGap(3 * MINUTE, true)).toBe(3 * MINUTE)
  expect(activeGap(3 * 60 * MINUTE, true)).toBe(IDLE_MS)
  // The person reading and thinking counts; a break does not.
  expect(activeGap(7 * MINUTE, false)).toBe(7 * MINUTE)
  expect(activeGap(40 * MINUTE, false)).toBe(0)

  const start = new Date(2026, 9, 11, 10, 0).getTime()
  let spend = emptySpend('2026-10-11')
  spend = touched(spend, start, false) // the first activity starts the clock
  spend = touched(spend, start + 5 * MINUTE, true) // Claude worked 5 minutes
  spend = touched(spend, start + 13 * MINUTE, false) // the person answered after 8
  spend = touched(spend, start + 13 * MINUTE + 90 * MINUTE, false) // back from lunch: not counted
  spend = touched(spend, start + 13 * MINUTE + 90 * MINUTE - MINUTE, true) // another chat's older tick: nothing, no going back
  expect(spend.time).toEqual({ '2026-10-11': 13 * MINUTE })
  expect(spend.lastActive).toBe(start + 103 * MINUTE)
  expect(timeIn(spend, '2026-10-11', 7)).toBe(13 * MINUTE)
  expect(totalTime(spend)).toBe(13 * MINUTE)

  expect(formatDuration(30_000)).toBe('меньше минуты')
  expect(formatDuration(45 * MINUTE)).toBe('45 мин')
  expect(formatDuration(3 * 60 * MINUTE)).toBe('3 ч')
  expect(formatDuration(130 * MINUTE)).toBe('2 ч 10 мин')
})

test('warning marks fire once as a value passes them', () => {
  expect(crossed(70, 85, [80, 95])).toEqual([80])
  expect(crossed(85, 90, [80, 95])).toEqual([])
  expect(crossed(79, 100, [80, 95])).toEqual([80, 95])
  expect(bar(50, 10)).toBe('▰▰▰▰▰▱▱▱▱▱')
  expect(limitLabel('five_hour')).toBe('5 часов')
  expect(limitLabel('seven_day')).toBe('неделя')
})

test('a run counts whole once, a resumed one for what is new, a kept-cost restart not again', () => {
  expect(newSpend({}, '100', 40, null)).toEqual({ delta: 40, counted: { '100': 40 } })
  expect(newSpend({ '100': 40 }, '100', 42, { run: '100', usd: 40 })).toEqual({ delta: 2, counted: { '100': 42 } })
  expect(newSpend({ '100': 42 }, '200', 0.5, { run: '100', usd: 42 }).delta).toBe(0.5)
  expect(newSpend({ '100': 42 }, '300', 43, { run: '100', usd: 42 }).delta).toBe(1)
  expect(newSpend({ '100': 42 }, '100', 30, { run: '100', usd: 42 }).delta).toBe(0)
  // An update in the middle of a chat: the older version's reading has no run, so the chat still counts whole.
  expect(newSpend({}, '100', 46, { session: 's1', usd: 39 } as unknown as { run: string; usd: number }).delta).toBe(46)
  expect(limitShort('five_hour')).toBe('5 ч')
  expect(limitShort('seven_day')).toBe('неделя')
})
