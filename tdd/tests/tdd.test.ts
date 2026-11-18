import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { START } from '../hooks/rules'

const ROOT = 'C:\\proj'
const RULES = `${ROOT}\\CLAUDE.md`
const NOW = new Date(2026, 10, 19, 12, 0).getTime()

const PANE: RenderPropsOf['Pane'] = {
  title: 'Тесты до кода',
  isFocused: false,
  bodyColumns: 50,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}
const OPEN = { plugin: 'tdd', surface: 'desktop', component: 'Pane', requestId: 'tdd', props: PANE } as const

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const IN_BAND = { plugin: 'tdd', surface: 'desktop', component: 'AbovePrompt', props: BAND } as const

// The engine beneath the plugin: a disk of text files, the commands that ran,
// the tests' verdict, and the toasts shown.
function world(on: On, files: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  const disk = new Map(Object.entries(files))
  const toasts: string[] = []
  const ran: string[] = []
  const opened: string[] = []
  const sim = { testsGreen: true }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: disk.has(e.path) }))
  on('fs.read', ($, e) => ({ value: disk.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    disk.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      ran.push(e.command)
      const isTest = /\b(npm test|node --test)\b/.test(e.command)
      return { result: { stdout: '', stderr: '', interrupted: false } as never, ...(isTest && !sim.testsGreen ? { isError: true as const } : {}) }
    }
    return { result: {} as never }
  })
  return { clock, disk, toasts, ran, sim, opened }
}

const start = ($: { session: { start: (input: { cwd: string; surface: 'desktop'; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

const PACKAGE = JSON.stringify({ scripts: { test: 'node --test' } })
const edit = (path: string) => ({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' }) as never
const bash = (command: string) => ({ tool: 'Bash', command }) as never
const say = ($: { prompt: { submit: (input: { text: string; wait: false; origin: { kind: 'composer' } }) => Promise<unknown> } }, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('"Добавить в проект" writes the rules into CLAUDE.md, keeping what is there, and "Убрать" takes them out', async ($, on) => {
  const { disk, toasts } = world(on, { [RULES]: '# Проект\n\nПишем на русском.\n' })
  await start($)
  const pane = await $.ui.mount(OPEN)
  expect(await pane.find({ type: 'Text', text: /Не добавлено/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'rule-remove' })).toBeUndefined()

  await pane.press({ key: 'rule-add' })
  const written = String(disk.get(RULES))
  expect(written.startsWith('# Проект\n\nПишем на русском.\n\n')).toBe(true)
  expect(written).toContain(START)
  expect(written).toContain('Сначала тест, потом код.')
  expect(toasts).toContain('Правила добавлены в CLAUDE.md проекта. Агент теперь работает по ним.')
  expect(await pane.find({ type: 'Text', text: /Добавлено в CLAUDE.md проекта/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'rule-add' })).toBeUndefined()

  await pane.press({ key: 'rule-remove' })
  expect(disk.get(RULES)).toBe('# Проект\n\nПишем на русском.\n')
  expect(await pane.find({ type: 'Text', text: /Не добавлено/ })).toBeDefined()
})

test('a project with no CLAUDE.md gets one, and a project that has the rules shows them as added', async ($, on) => {
  const { disk } = world(on)
  await start($)
  const pane = await $.ui.mount(OPEN)
  await pane.press({ key: 'rule-add' })
  expect(String(disk.get(RULES)).startsWith(START)).toBe(true)
})

test('off by default; observe warns; enforce refuses code before a test and lets it after', async ($, on) => {
  const { toasts } = world(on, { [`${ROOT}\\package.json`]: PACKAGE })
  await start($)
  const pane = await $.ui.mount(OPEN)
  const code = `${ROOT}\\server\\auth.mjs`
  const test = `${ROOT}\\tests\\auth.test.mjs`

  expect((await $.tool.call(edit(code))).deny).toBeUndefined()
  expect(toasts).toEqual([])

  await pane.press({ key: 'gates-observe' })
  expect((await $.tool.call(edit(code))).deny).toBeUndefined()
  expect(toasts).toEqual(['Тесты до кода: auth.mjs правится без теста'])

  await pane.press({ key: 'gates-enforce' })
  const refused = await $.tool.call(edit(code))
  expect(refused.deny).toContain('Сначала напиши тест, который падает')
  expect(refused.deny).toContain('"без тестов"')
  // The test first, then the code.
  expect((await $.tool.call(edit(test))).deny).toBeUndefined()
  expect((await $.tool.call(edit(code))).deny).toBeUndefined()
  // Text and styles are not asked for a test.
  expect((await $.tool.call(edit(`${ROOT}\\README.md`))).deny).toBeUndefined()
})

test('"без тестов" from the person lifts the edit gate until their next message', async ($, on) => {
  world(on)
  await start($)
  const pane = await $.ui.mount(OPEN)
  await pane.press({ key: 'gates-enforce' })
  const code = `${ROOT}\\server\\auth.mjs`
  expect((await $.tool.call(edit(code))).deny).toBeDefined()
  await say($, 'поправь текст ошибки, без тестов')
  expect((await $.tool.call(edit(code))).deny).toBeUndefined()
  await say($, 'теперь добавь проверку')
  expect((await $.tool.call(edit(code))).deny).toBeDefined()
})

test('the commit gate wants a green run after the last edit; the third attempt passes', async ($, on) => {
  const { ran, sim } = world(on, { [`${ROOT}\\package.json`]: PACKAGE })
  await start($)
  const pane = await $.ui.mount(OPEN)
  await pane.press({ key: 'gates-enforce' })
  await $.tool.call(edit(`${ROOT}\\tests\\auth.test.mjs`))
  await $.tool.call(edit(`${ROOT}\\server\\auth.mjs`))

  const stopped = await $.tool.call(bash('git commit -am "auth"'))
  expect(stopped.deny).toContain('Запусти тесты проекта (npm test)')
  expect(ran).not.toContain('git commit -am "auth"')
  expect(await pane.find({ type: 'Text', text: /код правили \(1\)/ })).toBeDefined()

  // Red tests do not clear it; green ones do.
  sim.testsGreen = false
  await $.tool.call(bash('npm test'))
  expect((await $.tool.call(bash('git commit -am "auth"'))).deny).toBeDefined()
  sim.testsGreen = true
  await $.tool.call(bash('npm test'))
  expect(await pane.find({ type: 'Text', text: /тесты зелёные/ })).toBeDefined()
  expect((await $.tool.call(bash('git commit -am "auth"'))).deny).toBeUndefined()
  expect(ran).toContain('git commit -am "auth"')

  // Another round: it refuses twice, then lets the third through.
  await $.tool.call(edit(`${ROOT}\\tests\\more.test.mjs`))
  await $.tool.call(edit(`${ROOT}\\server\\db.mjs`))
  expect((await $.tool.call(bash('git commit -m two'))).deny).toBeDefined()
  expect((await $.tool.call(bash('git commit -m two'))).deny).toBeDefined()
  expect((await $.tool.call(bash('git commit -m two'))).deny).toBeUndefined()
})

test('a chain that runs the tests first is not stopped, observe only warns, and with no known tests nothing waits', async ($, on) => {
  const { toasts } = world(on, { [`${ROOT}\\package.json`]: PACKAGE })
  await start($)
  const pane = await $.ui.mount(OPEN)
  await pane.press({ key: 'gates-enforce' })
  await $.tool.call(edit(`${ROOT}\\tests\\a.test.mjs`))
  await $.tool.call(edit(`${ROOT}\\server\\a.mjs`))
  expect((await $.tool.call(bash('npm test && git commit -m chained'))).deny).toBeUndefined()

  await $.tool.call(edit(`${ROOT}\\tests\\b.test.mjs`))
  await $.tool.call(edit(`${ROOT}\\server\\b.mjs`))
  await pane.press({ key: 'gates-observe' })
  expect((await $.tool.call(bash('git commit -m watched'))).deny).toBeUndefined()
  expect(toasts).toContain('Тесты до кода: коммит без свежего прогона тестов')
})

test('no test command and no run seen: the commit gate does not stand in the way', async ($, on) => {
  world(on)
  await start($)
  const pane = await $.ui.mount(OPEN)
  await pane.press({ key: 'gates-enforce' })
  await $.tool.call(edit(`${ROOT}\\tests\\a.test.mjs`))
  await $.tool.call(edit(`${ROOT}\\server\\a.mjs`))
  expect((await $.tool.call(bash('git commit -m ok'))).deny).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /Команда тестов не найдена/ })).toBeDefined()
})

test('three red runs in a row tell the agent to stop and explain; a green run starts over', async ($, on) => {
  const { toasts, sim } = world(on, { [`${ROOT}\\package.json`]: PACKAGE })
  await start($)
  sim.testsGreen = false
  const first = await $.tool.call(bash('npm test'))
  const second = await $.tool.call(bash('npm test'))
  expect(first.context).toBeUndefined()
  expect(second.context).toBeUndefined()
  const third = await $.tool.call(bash('npm test'))
  expect(String(third.context?.join(' '))).toContain('третий красный прогон тестов подряд')
  expect(toasts).toContain('Тесты красные 3 раза подряд')
  sim.testsGreen = true
  await $.tool.call(bash('npm test'))
  sim.testsGreen = false
  expect((await $.tool.call(bash('npm test'))).context).toBeUndefined()
})

test('the gate mode is kept for the project and read back in the next chat', async ($, on) => {
  world(on)
  await start($)
  const pane = await $.ui.mount(OPEN)
  expect(await pane.find({ type: 'Text', text: /Ворота выключены/ })).toBeDefined()
  await pane.press({ key: 'gates-enforce' })
  expect(await pane.find({ type: 'Text', text: /Блокируют/ })).toBeDefined()
  // A new chat of the same project reads the mode from the store.
  await pane.unmount()
  await start($)
  const again = await $.ui.mount(OPEN)
  expect(await again.find({ type: 'Text', text: /Блокируют/ })).toBeDefined()
})

test('a chip above the input says where TDD stands, nudges when it could be on, and opens the pane in one press', async ($, on) => {
  const { opened, clock } = world(on, { [`${ROOT}\\package.json`]: PACKAGE })
  await start($)
  await clock.settle()
  const band = await $.ui.mount(IN_BAND)
  const chip = async () => (await band.find({ type: 'Button', key: 'tdd-open' }))?.text

  // A project with tests that has not turned TDD on: the chip asks, so nobody has to remember /tdd.
  expect(await chip()).toBe('TDD: включить?')
  await band.press({ key: 'tdd-open' })
  expect(opened).toEqual(['tdd'])

  const pane = await $.ui.mount(OPEN)
  await pane.press({ key: 'rule-add' })
  expect(await chip()).toBe('TDD правила ✓')
  await pane.press({ key: 'gates-observe' })
  expect(await chip()).toBe('TDD правила ✓ · наблюдаю')
  await pane.press({ key: 'gates-enforce' })
  expect(await chip()).toBe('TDD правила ✓ · блок')
  // Code edited after a test, the tests not run since: the chip says so.
  await $.tool.call(edit(`${ROOT}\\tests\\a.test.mjs`))
  await $.tool.call(edit(`${ROOT}\\server\\a.mjs`))
  expect(await chip()).toBe('TDD ⚠ код без проверки')
})

test('a project with no tests gets a quiet chip, not a nudge', async ($, on) => {
  world(on)
  await start($)
  const band = await $.ui.mount(IN_BAND)
  expect((await band.find({ type: 'Button', key: 'tdd-open' }))?.text).toBe('TDD выкл')
})

test('the chip leaves the block alone while a survey holds it', async ($, on) => {
  world(on)
  await start($)
  const band = await $.ui.mount({ ...IN_BAND, props: { ...BAND, hasSurvey: true } })
  expect(await band.find({ type: 'Button', key: 'tdd-open' })).toBeUndefined()
})
