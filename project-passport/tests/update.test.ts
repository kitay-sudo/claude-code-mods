import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import type { Passport } from '../types'

const STORE_KEY = 'passport:c:/work/acme-crm'
const CWD = 'C:\\work\\acme-crm'
const NOW = new Date(2026, 9, 13, 14, 20).getTime()

const PANE: RenderPropsOf['Pane'] = {
  title: 'Паспорт проекта',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
}

// Two chats of one project share the store, as the engine's own does.
function world(on: On, disk: Map<string, unknown>) {
  const clock = mock.clock(on, { now: NOW })
  const forks: string[] = []
  const submitted: string[] = []
  on('store.get', ($, e) => ({ value: disk.get(e.key) }))
  on('store.set', ($, e) => {
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__project-passport__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return {
      value: {
        isAnswered: true as const,
        text: '{}',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  return { clock, forks, submitted }
}

const ANSWER = { answer: 'Готово.', durationMs: 1, isAborted: false, reason: 'answer' } as const
const OPEN = { plugin: 'project-passport', surface: 'desktop', component: 'Pane', requestId: 'project-passport', props: PANE } as const

test('nothing is taken from the chat by itself any more', async ($, on) => {
  const disk = new Map<string, unknown>()
  const { clock, forks } = world(on, disk)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Клиент Денис, всегда пишем ему по-английски', wait: false, origin: { kind: 'sdk' } })
  await $.turn.start({ text: 'Клиент Денис, всегда пишем ему по-английски', turnId: 't1' })
  await $.turn.complete({ ...ANSWER, turnId: 't1' })
  await clock.settle()
  expect(forks).toEqual([])
  expect(disk.get(STORE_KEY)).toBeUndefined()
  const pane = await $.ui.mount(OPEN)
  expect(await pane.find({ type: 'Button', key: 'pp-learn' })).toBeUndefined()
})

test('"Обновить" hands Claude a walk through the project and its code, any number of times', async ($, on) => {
  const disk = new Map<string, unknown>()
  const { submitted } = world(on, disk)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount(OPEN)

  await pane.press({ key: 'pp-update' })
  expect(submitted[0]).toContain('Обнови паспорт этого проекта. Пройди по проекту и коду')
  expect(submitted[0]).toContain('домены и сайты, админки, серверы, сторонние сервисы и интеграции')
  expect(submitted[0]).toContain('Пароли, ключи и токены не записывай.')
  expect(submitted[0]).toContain('Стек и правила по коду в паспорт не пиши')
  expect(submitted[0]).not.toMatch(/[—–]/)

  await $.turn.start({ text: submitted[0]!, turnId: 'u1' })
  await $.turn.complete({ ...ANSWER, turnId: 'u1' })
  // It stays, and says when it last ran.
  expect(await pane.find({ type: 'Button', key: 'pp-update' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Последнее обновление: сегодня в 14:20.' })).toBeDefined()
})

test('"Заполнить" and "Разобрать" go once Claude has done them, and stay when it did not finish', async ($, on) => {
  const disk = new Map<string, unknown>()
  const { submitted } = world(on, disk)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount(OPEN)
  expect((await pane.find({ type: 'Button', key: 'pp-fill' }))?.props.variant).toBe('primary')
  expect(await pane.find({ type: 'Button', key: 'pp-sort' })).toBeDefined()
  expect((await pane.find({ type: 'Button', key: 'pp-update' }))?.props.variant).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Заполнить и Разобрать нужны один раз: кнопка пропадёт, когда Claude её выполнит.' })).toBeDefined()

  await pane.press({ key: 'pp-fill' })
  // Claude may be busy: the request's own turn is the one that counts.
  await $.turn.start({ text: 'другая задача', turnId: 'other' })
  await $.turn.complete({ ...ANSWER, turnId: 'other' })
  expect(await pane.find({ type: 'Button', key: 'pp-fill' })).toBeDefined()

  await $.turn.start({ text: submitted[0]!, turnId: 'f1' })
  // While Claude works on it, the button is not offered.
  expect(await pane.find({ type: 'Button', key: 'pp-fill' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '✓ Передал Claude: заполнить паспорт. Ответ будет в чате.' })).toBeDefined()
  await $.turn.complete({ ...ANSWER, turnId: 'f1' })
  expect(await pane.find({ type: 'Button', key: 'pp-fill' })).toBeUndefined()
  expect((disk.get(STORE_KEY) as Passport).ran.fill).toBe(NOW)
  // With "Заполнить" gone, "Обновить" is the main one.
  expect((await pane.find({ type: 'Button', key: 'pp-update' }))?.props.variant).toBe('primary')

  await pane.press({ key: 'pp-sort' })
  await $.turn.start({ text: submitted[1]!, turnId: 's1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, reason: 'aborted', turnId: 's1' })
  expect(await pane.find({ type: 'Button', key: 'pp-sort' })).toBeDefined()

  await $.turn.start({ text: submitted[1]!, turnId: 's2' })
  await $.turn.complete({ ...ANSWER, turnId: 's2' })
  expect(await pane.find({ type: 'Button', key: 'pp-sort' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Заполнить и Разобрать нужны один раз: кнопка пропадёт, когда Claude её выполнит.' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'pp-update' })).toBeDefined()
})

test('a note another chat of the project wrote shows here within seconds', async ($, on) => {
  const disk = new Map<string, unknown>()
  const { clock } = world(on, disk)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount(OPEN)
  expect(await pane.find({ type: 'Text', text: /^Оплата после сдачи/ })).toBeUndefined()

  // The other chat writes straight to the shared store; it already filled the passport there.
  disk.set(STORE_KEY, { replyLanguage: null, next: 2, notes: [{ id: 'n1', section: 'client', text: 'Оплата после сдачи', at: 1, by: 'person' }], ran: { fill: 5 } })
  await clock.advance(5_000)
  expect(await pane.find({ type: 'Text', text: /^Оплата после сдачи/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'pp-fill' })).toBeUndefined()

  // A note added here keeps the other chat's one.
  await pane.input({ key: 'pp-text', text: 'Логотип не трогать', kind: 'submit' })
  expect((disk.get(STORE_KEY) as Passport).notes.map(note => note.text)).toEqual(['Оплата после сдачи', 'Логотип не трогать'])
})
