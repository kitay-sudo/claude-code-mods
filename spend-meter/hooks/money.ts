// Money and dates as plain data: no `$`, so tests read them directly.

import type { Limit, ProjectSpend } from '../types'

const NBSP = ' '

export function dayKey(ms: number): string {
  const at = new Date(ms)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

export function shortDay(key: string): string {
  const [, month, day] = key.split('-')
  return `${day}.${month}`
}

function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** Rubles as people read them: whole above ten, one decimal below. */
export function formatRub(rub: number): string {
  if (rub < 10) return `${rub.toFixed(1).replace('.', ',')}${NBSP}₽`
  return `${grouped(Math.round(rub))}${NBSP}₽`
}

export function formatUsd(usd: number): string {
  return `$${usd < 10 ? usd.toFixed(2) : grouped(Math.round(usd))}`
}

/** Dollars in rubles at the given rate. */
export function money(usd: number, rub: number): string {
  return formatRub(usd * rub)
}

const HOUR_MS = 3_600_000

/** What the person's own time would cost at `perHour` rubles an hour, as rubles read. */
export function humanCost(ms: number, perHour: number): string {
  return formatRub((Math.max(0, ms) / HOUR_MS) * perHour)
}

export function emptySpend(today: string): ProjectSpend {
  return { usd: 0, days: {}, since: today, budgetRub: null, counted: {}, time: {}, lastActive: 0 }
}

const RUNS_KEPT = 200

export function addSpend(spend: ProjectSpend, usd: number, day: string): ProjectSpend {
  if (!(usd > 0)) return spend
  return { ...spend, usd: spend.usd + usd, days: { ...spend.days, [day]: (spend.days[day] ?? 0) + usd } }
}

/** A project's spending read back from the store, anything malformed left out. */
export function restoreSpend(raw: unknown, today: string): ProjectSpend {
  const kept = (raw ?? {}) as Partial<ProjectSpend>
  const days: Record<string, number> = {}
  for (const [key, value] of Object.entries(kept.days ?? {})) {
    if (/^\d{4}-\d\d-\d\d$/.test(key) && Number(value) > 0) days[key] = Number(value)
  }
  const budget = Number(kept.budgetRub)
  const runs = Object.entries(kept.counted ?? {})
    .filter(([run, value]) => /^\d+$/.test(run) && Number(value) >= 0)
    .sort(([a], [b]) => Number(b) - Number(a))
    .slice(0, RUNS_KEPT)
  return {
    usd: Number(kept.usd) > 0 ? Number(kept.usd) : 0,
    days,
    since: typeof kept.since === 'string' && /^\d{4}-\d\d-\d\d$/.test(kept.since) ? kept.since : today,
    budgetRub: budget > 0 ? budget : null,
    counted: Object.fromEntries(runs.map(([run, value]) => [run, Number(value)])),
    time: Object.fromEntries(
      Object.entries(kept.time ?? {})
        .filter(([key, value]) => /^\d{4}-\d\d-\d\d$/.test(key) && Number(value) > 0)
        .map(([key, value]) => [key, Number(value)]),
    ),
    lastActive: Number(kept.lastActive) > 0 ? Number(kept.lastActive) : 0,
  }
}

/** A pause longer than this is a break, not work. */
export const IDLE_MS = 10 * 60_000

/**
 * How much of the time since the project's last activity was work: all of it
 * while Claude works (a computer's sleep cut to the idle limit), a person's
 * pause only when it was short.
 */
export function activeGap(gapMs: number, isWorking: boolean): number {
  if (!(gapMs > 0)) return 0
  if (isWorking) return Math.min(gapMs, IDLE_MS)
  return gapMs <= IDLE_MS ? gapMs : 0
}

/** The project after one more activity at `now`: the work since the last one added to its day. */
export function touched(spend: ProjectSpend, now: number, isWorking: boolean): ProjectSpend {
  const gap = spend.lastActive > 0 ? activeGap(now - spend.lastActive, isWorking) : 0
  const day = dayKey(now)
  const time = gap > 0 ? { ...spend.time, [day]: (spend.time[day] ?? 0) + gap } : spend.time
  return { ...spend, time, lastActive: Math.max(now, spend.lastActive) }
}

/** Time in the last `count` days up to `today`, in ms. */
export function timeIn(spend: ProjectSpend, today: string, count: number): number {
  return lastDays({ ...spend, days: spend.time }, today, count).reduce((sum, one) => sum + one.usd, 0)
}

export function totalTime(spend: ProjectSpend): number {
  return Object.values(spend.time).reduce((sum, ms) => sum + ms, 0)
}

/** Hours and minutes as people say them: "2 ч 10 мин", "45 мин", "3 ч". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'меньше минуты'
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`
}

/** The last `count` days up to `today`, oldest first, zero where nothing was spent. */
export function lastDays(spend: ProjectSpend, today: string, count: number): { day: string; usd: number }[] {
  const [year, month, day] = today.split('-').map(Number)
  const out: { day: string; usd: number }[] = []
  for (let back = count - 1; back >= 0; back--) {
    const key = dayKey(new Date(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - back).getTime())
    out.push({ day: key, usd: spend.days[key] ?? 0 })
  }
  return out
}

export function bar(percent: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`
}

/** A window's name as short as the shared row wants it. */
export function limitShort(kind: string): string {
  if (kind === 'five_hour') return '5 ч'
  if (kind === 'seven_day') return 'неделя'
  if (kind === 'seven_day_opus') return 'неделя Opus'
  if (kind === 'spend_limit') return 'траты'
  return kind.replace(/_/g, ' ')
}

/**
 * How much of a session's cost is new to the project: a run never counted is
 * counted whole (from before the meter was installed too); a resumed run only
 * for what it cost since; a /clear that kept the cost is the same run going on.
 */
export function newSpend(
  counted: Readonly<Record<string, number>>,
  run: string,
  usd: number,
  seenBefore: { run: string; usd: number } | null,
): { delta: number; counted: Record<string, number> } {
  // A reading kept by an older version (no run in it) says nothing about this run.
  const last = seenBefore !== null && typeof seenBefore.run === 'string' ? seenBefore : null
  const isContinued = counted[run] === undefined && last !== null && last.run !== run && usd >= last.usd
  const already = counted[run] ?? (isContinued ? (counted[last.run] ?? last.usd) : 0)
  return { delta: usd > already ? usd - already : 0, counted: { ...counted, [run]: usd } }
}

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5 часов'
  if (kind === 'seven_day') return 'неделя'
  if (kind === 'seven_day_opus') return 'неделя Opus'
  if (kind === 'spend_limit') return 'лимит трат'
  return kind.replace(/_/g, ' ')
}

export function resetLabel(iso: string | undefined, now: number): string {
  if (iso === undefined) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return dayKey(at.getTime()) === dayKey(now) ? `сброс в ${time}` : `сброс ${shortDay(dayKey(at.getTime()))} в ${time}`
}

/** The warning marks a value has just passed, highest last. */
export function crossed(before: number, after: number, marks: readonly number[]): number[] {
  return marks.filter(mark => before < mark && after >= mark)
}

export function limitsFrom(raw: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Limit[] {
  return raw.map(limit => ({ kind: limit.kind, percent: limit.percentUsed, ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }) }))
}
