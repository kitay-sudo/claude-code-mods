// tdd: the two gates and what they remember, as plain data. No `$`.
//
// The edit gate: code is not edited before a test file was touched (since the
// last commit). The commit gate: no commit while code was edited after the last
// green run of the tests. Both come in three modes: off, observe (they only
// say so) and enforce (they refuse). The commit gate lets a commit through
// after it has refused twice in a session, so it never traps anyone.

import type { Gates, Run } from '../types'
import { isCodeFile, isTestFile } from './rules'

export type { Gates, Run }

export const FRESH_RUN: Run = {
  testTouched: false,
  dirty: false,
  edits: 0,
  redStreak: 0,
  commitRefusals: 0,
  skip: false,
  lastGreen: null,
}

export type Verdict = 'pass' | 'warn' | 'deny'

/** The person's words that lift the gates for what they asked. */
const SKIP_WORDS = /без\s+тест/i

/** A message of the person: it ends the last "без тестов" and may start a new one. */
export function personSaid(run: Run, text: string): Run {
  return { ...run, skip: SKIP_WORDS.test(text) }
}

/** A file about to be edited. A test file counts; code asks for a test first. */
export function editGate(run: Run, mode: Gates, path: string): { run: Run; verdict: Verdict } {
  if (isTestFile(path)) return { run: { ...run, testTouched: true }, verdict: 'pass' }
  if (!isCodeFile(path)) return { run, verdict: 'pass' }
  if (mode !== 'off' && !run.skip && !run.testTouched) {
    if (mode === 'enforce') return { run, verdict: 'deny' }
    return { run: { ...run, dirty: true, edits: run.edits + 1 }, verdict: 'warn' }
  }
  return { run: { ...run, dirty: true, edits: run.edits + 1 }, verdict: 'pass' }
}

/** A commit about to be made, in a project whose test command is known or not. */
export function commitGate(run: Run, mode: Gates, hasTests: boolean): { run: Run; verdict: Verdict } {
  if (mode === 'off' || run.skip || !hasTests || !run.dirty) return { run, verdict: 'pass' }
  if (mode === 'observe') return { run, verdict: 'warn' }
  if (run.commitRefusals >= 2) return { run: { ...run, commitRefusals: 0 }, verdict: 'pass' }
  return { run: { ...run, commitRefusals: run.commitRefusals + 1 }, verdict: 'deny' }
}

/** A commit that went through: the next work starts from a clean slate, refusals counted afresh. */
export function committed(run: Run): Run {
  return { ...run, testTouched: false, commitRefusals: 0 }
}

/** The tests ran: green clears the work waiting for a check, red adds to the streak. */
export function testRan(run: Run, isGreen: boolean, now: number): Run {
  if (isGreen) return { ...run, dirty: false, edits: 0, redStreak: 0, lastGreen: now }
  return { ...run, redStreak: run.redStreak + 1 }
}

export const RED_LIMIT = 3

export const EDIT_DENY =
  'Тесты до кода включены в этом проекте. Сначала напиши тест, который падает: поведение, которое ты меняешь, ' +
  'должно проверяться через публичный интерфейс. Потом повтори правку. Если для этой правки тест не нужен, ' +
  'скажи об этом пользователю и попроси ответить "без тестов".'

export function commitDeny(command: string | null): string {
  return (
    'Коммит остановлен: после последней правки кода тесты не прогонялись или были красными. ' +
    `Запусти тесты проекта${command === null ? '' : ` (${command})`}, и если они зелёные, повтори коммит. ` +
    'Если нужно закоммитить без проверки, попроси пользователя ответить "без тестов".'
  )
}

export const RED_NUDGE =
  'Это третий красный прогон тестов подряд. Остановись и объясни пользователю, что не получается и что уже пробовал. ' +
  'Не ослабляй и не удаляй тесты, чтобы они прошли.'

/** The chip in the block above the input: how loud it should be. */
export type Chip = { text: string; tone: 'dim' | 'normal' | 'attention' }

/**
 * Where TDD stands in this project, in a few words, and a nudge when it could
 * be on and is not: so nobody has to remember to open /tdd.
 */
export function chipOf(mode: Gates, rule: 'unknown' | 'added' | 'absent', hasTests: boolean, dirty: boolean): Chip {
  if (mode !== 'off' && dirty) return { text: 'TDD ⚠ код без проверки', tone: 'attention' }
  const gate = mode === 'enforce' ? 'блок' : mode === 'observe' ? 'наблюдаю' : null
  if (gate !== null || rule === 'added') {
    return { text: `TDD ${[rule === 'added' ? 'правила ✓' : null, gate].filter(part => part !== null).join(' · ')}`, tone: 'normal' }
  }
  return hasTests ? { text: 'TDD: включить?', tone: 'attention' } : { text: 'TDD выкл', tone: 'dim' }
}

/** The state in a line for the pane. */
export function statusLine(run: Run, now: number): string {
  if (run.dirty) return `⚠ код правили (${run.edits}), после этого тесты не прогоняли или они красные`
  if (run.lastGreen !== null) {
    const minutes = Math.max(0, Math.floor((now - run.lastGreen) / 60_000))
    return minutes < 1 ? '✓ тесты зелёные, только что' : `✓ тесты зелёные, ${minutes} мин назад`
  }
  return 'пока тишина: код не правили, тесты не гоняли'
}
