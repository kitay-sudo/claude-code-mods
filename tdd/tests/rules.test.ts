import { expect, test } from 'claude-code/testing'

import { FRESH_RUN, RED_LIMIT, commitGate, committed, editGate, personSaid, statusLine, testRan } from '../hooks/gate'
import type { Run } from '../hooks/gate'
import {
  END,
  RULES_TEXT,
  START,
  addRule,
  hasRule,
  isCodeFile,
  isCommitCommand,
  isTestCommand,
  isTestFile,
  removeRule,
  ruleBlock,
  testCommandOf,
} from '../hooks/rules'

test('the rules go into CLAUDE.md between markers, once, and come out whole', () => {
  const written = addRule('')
  expect(written).toBe(`${ruleBlock()}\n`)
  expect(hasRule(written)).toBe(true)
  expect(written).toContain('Сначала тест, потом код.')
  expect(written).toContain('запросы к базе только с параметрами')
  // The project-style rule was dropped on purpose; the cycle is not shown, only the result.
  expect(RULES_TEXT).not.toMatch(/стиль/i)

  const mine = '# Проект\n\nПишем на русском.\n'
  const added = addRule(mine)
  expect(added.startsWith('# Проект\n\nПишем на русском.\n\n')).toBe(true)
  expect(added.split(START)).toHaveLength(2)
  // Pressing twice changes nothing.
  expect(addRule(added)).toBe(added)
  // Taking them out leaves the rest as it was.
  expect(removeRule(added)).toBe(mine)
  expect(removeRule(written)).toBe('')
  expect(removeRule(mine)).toBe(mine)
})

test('the block is refreshed in place and keeps the file\'s line endings', () => {
  const stale = `Начало\r\n\r\n${START}\r\nстарый текст\r\n${END}\r\n\r\nКонец\r\n`
  const fresh = addRule(stale)
  expect(fresh).toContain(RULES_TEXT.replace(/\n/g, '\r\n'))
  expect(fresh).not.toContain('старый текст')
  expect(fresh.startsWith('Начало\r\n\r\n')).toBe(true)
  expect(fresh.endsWith('\r\n\r\nКонец\r\n')).toBe(true)
  expect(removeRule(fresh)).toBe('Начало\r\n\r\nКонец\r\n')
})

test('tests, code and the rest are told apart by their path', () => {
  for (const path of ['tests/auth.test.mjs', 'src/auth.spec.ts', 'C:\\proj\\tests\\x.mjs', 'pkg/test_auth.py', 'pkg/auth_test.go', 'src/__tests__/a.js']) {
    expect(isTestFile(path)).toBe(true)
    expect(isCodeFile(path)).toBe(false)
  }
  for (const path of ['server/auth.mjs', 'src/app.tsx', 'C:\\proj\\lib\\db.py', 'tools/build.ps1']) expect(isCodeFile(path)).toBe(true)
  for (const path of ['README.md', 'public/index.html', 'style.css', 'package.json', 'node_modules/x/index.js', 'dist/app.js', 'types/index.d.ts', '.claude/mods/x.mjs']) {
    expect(isCodeFile(path)).toBe(false)
  }
})

test('a test run and a commit are told in a command, in a chain too', () => {
  for (const command of ['npm test', 'npm run test', 'pnpm test', 'node --test', 'node --test tests/', 'pytest -q', 'go test ./...', 'cargo test', 'npx vitest run', 'powershell -File .\\check.ps1 quick-steps', 'cd app && npm test']) {
    expect(isTestCommand(command)).toBe(true)
  }
  for (const command of ['npm install', 'git status', 'echo testing', 'node server/index.mjs']) expect(isTestCommand(command)).toBe(false)
  for (const command of ['git commit -m "x"', 'git add . && git commit -m x', 'git -C /repo commit -am fix', 'git -c user.name=a commit -m x']) {
    expect(isCommitCommand(command)).toBe(true)
  }
  for (const command of ['git log --oneline', 'git commit-tree abc', 'echo git commit']) expect(isCommitCommand(command)).toBe(false)
})

test('the test command comes from package.json, the npm placeholder does not count', () => {
  expect(testCommandOf('{"scripts":{"test":"node --test"}}')).toBe('npm test')
  expect(testCommandOf('{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}')).toBeNull()
  expect(testCommandOf('{"scripts":{}}')).toBeNull()
  expect(testCommandOf('не json')).toBeNull()
})

const run = (patch: Partial<Run> = {}): Run => ({ ...FRESH_RUN, ...patch })

test('the edit gate: a test file first, then code; observe warns, enforce refuses, "без тестов" lifts it', () => {
  const code = 'server/auth.mjs'
  expect(editGate(run(), 'off', code)).toEqual({ run: run({ dirty: true, edits: 1 }), verdict: 'pass' })
  expect(editGate(run(), 'observe', code).verdict).toBe('warn')
  expect(editGate(run(), 'enforce', code)).toEqual({ run: run(), verdict: 'deny' })
  // A test file counts, and code after it passes.
  const touched = editGate(run(), 'enforce', 'tests/auth.test.mjs')
  expect(touched).toEqual({ run: run({ testTouched: true }), verdict: 'pass' })
  expect(editGate(touched.run, 'enforce', code).verdict).toBe('pass')
  // Text, styles and markup are not asked for a test.
  expect(editGate(run(), 'enforce', 'README.md')).toEqual({ run: run(), verdict: 'pass' })
  // The person said so.
  expect(editGate(personSaid(run(), 'сделай, без тестов'), 'enforce', code).verdict).toBe('pass')
  expect(personSaid(personSaid(run(), 'без тестов'), 'теперь с тестами').skip).toBe(false)
})

test('the commit gate: work after the last green run waits; the third attempt passes; a commit starts afresh', () => {
  const dirty = run({ dirty: true, edits: 2 })
  expect(commitGate(dirty, 'off', true).verdict).toBe('pass')
  expect(commitGate(run(), 'enforce', true).verdict).toBe('pass')
  expect(commitGate(dirty, 'enforce', false).verdict).toBe('pass')
  expect(commitGate(dirty, 'observe', true).verdict).toBe('warn')
  const first = commitGate(dirty, 'enforce', true)
  expect(first.verdict).toBe('deny')
  const second = commitGate(first.run, 'enforce', true)
  expect(second.verdict).toBe('deny')
  expect(commitGate(second.run, 'enforce', true).verdict).toBe('pass')
  expect(committed(run({ testTouched: true })).testTouched).toBe(false)
})

test('a green run clears the waiting work, reds add up, and the pane line says where it stands', () => {
  const NOW = 10 * 60_000
  let state = run({ dirty: true, edits: 3 })
  expect(statusLine(state, NOW)).toContain('код правили (3)')
  state = testRan(state, false, NOW)
  state = testRan(state, false, NOW)
  state = testRan(state, false, NOW)
  expect(state.redStreak).toBe(RED_LIMIT)
  expect(state.dirty).toBe(true)
  state = testRan(state, true, NOW - 4 * 60_000)
  expect(state).toMatchObject({ dirty: false, edits: 0, redStreak: 0, lastGreen: NOW - 4 * 60_000 })
  expect(statusLine(state, NOW)).toBe('✓ тесты зелёные, 4 мин назад')
  expect(statusLine(run(), NOW)).toContain('пока тишина')
})
