import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { addItems, ageText, backlogBriefing, closeItems, emptyBacklog, isStale, reopenItem, restoreBacklog } from '../hooks/backlog'
import type { Backlog } from '../types'

const TOOL = 'mcp__backlog__backlog'
const CWD = 'C:\\work\\shop'
const KEY = 'backlog:c:/work/shop'
const NOW = new Date(2026, 9, 15, 12, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

const PANE: RenderPropsOf['Pane'] = {
  title: 'Бэклог',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
}
const OPEN = { plugin: 'backlog', surface: 'desktop', component: 'Pane', requestId: 'backlog', props: PANE } as const

// Two chats of one project share the store, as the engine's own does.
function world(on: On, disk = new Map<string, unknown>()) {
  const clock = mock.clock(on, { now: NOW })
  const submitted: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  on('store.get', ($, e) => ({ value: disk.get(e.key) }))
  on('store.set', ($, e) => {
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__backlog__${e.name}` } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { clock, disk, submitted, toasts, opened }
}

const start = ($: { session: { start: (input: { cwd: string; surface: 'desktop'; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

test('items come in once, go out as done or not needed, and come back', () => {
  let backlog: Backlog = emptyBacklog()
  backlog = addItems(backlog, ['Форма оплаты', 'форма оплаты', 'Логи сервера'], 1, 'person')
  expect(backlog.items.map(item => item.id)).toEqual(['b1', 'b2'])
  backlog = closeItems(backlog, ['b1'], 'done', 2)
  expect(backlog.items.map(item => item.text)).toEqual(['Логи сервера'])
  expect(backlog.closed[0]?.how).toBe('done')
  backlog = reopenItem(backlog, 'b1')
  expect(backlog.items.map(item => item.id)).toEqual(['b1', 'b2'])
  expect(restoreBacklog(JSON.parse(JSON.stringify(backlog))).next).toBe(3)
  expect(ageText(NOW - DAY, NOW)).toBe('вчера')
  expect(isStale(NOW - 15 * DAY, NOW)).toBe(true)
  expect(backlogBriefing(backlog, TOOL)).toContain('- [b2] Логи сервера')
})

test('the pane opens by itself, and the model reads the backlog without any plan or panel rules', async ($, on) => {
  const { opened } = world(on)
  await start($)
  expect(opened).toEqual(['backlog'])
  const blocks = (await $.prompt.context({ blocks: [] })).blocks
  expect(blocks.map(block => block.name)).toEqual(['backlog'])
  const text = blocks[0]?.text ?? ''
  expect(text).toContain("The project's backlog (the Backlog pane) is empty.")
  for (const gone of ['plan', 'intent', 'Task panel', 'queue']) expect(text).not.toContain(gone)
})

test('Claude adds and closes through its tool; the person adds, sends to work and closes in the pane', async ($, on) => {
  const { disk, submitted, toasts } = world(on)
  await start($)
  const added = await $.tool.call({ tool: TOOL, add: ['Подключить оплату', 'Подключить оплату'] })
  expect(added.result).toBe('Бэклог обновлён. Добавлено: [b1] Подключить оплату.')
  expect(toasts).toContain('Бэклог: +1')
  expect((await $.tool.call({ tool: TOOL, done: ['b9'] })).deny).toBe('Бэклог не изменён: нет пункта b9.')

  const pane = await $.ui.mount(OPEN)
  expect(await pane.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · 1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'shop' })).toBeDefined()
  await pane.input({ key: 'add-text', text: 'Логи на сервере', kind: 'submit' })
  expect((disk.get(KEY) as Backlog).items.map(item => `${item.id} ${item.by}`)).toEqual(['b1 claude', 'b2 person'])

  // "в работу" hands it over and keeps it until Claude marks it done.
  await pane.press({ key: 'take-b2' })
  expect(submitted).toEqual(['Сделай пункт бэклога [b2]: Логи на сервере. Когда закончишь, отметь его сделанным.'])
  expect(await pane.find({ type: 'Button', key: 'take-b2' })).toBeDefined()
  await $.tool.call({ tool: TOOL, done: ['b2'] })
  expect(await pane.find({ type: 'Button', key: 'take-b2' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '✓ Логи на сервере' })).toBeDefined()

  await pane.press({ key: 'drop-b1' })
  expect(await pane.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · пусто' })).toBeDefined()
  await pane.press({ key: 'reopen-b1' })
  expect(await pane.find({ type: 'Text', text: 'Подключить оплату' })).toBeDefined()

  // "Очистить всё" asks once more.
  await pane.press({ key: 'clear' })
  await pane.press({ key: 'clear-no' })
  expect(await pane.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · 1' })).toBeDefined()
  await pane.press({ key: 'clear' })
  await pane.press({ key: 'clear-yes' })
  expect(await pane.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · пусто' })).toBeDefined()
})

test('an item another chat of the project added shows here within seconds, and stays when this one adds', async ($, on) => {
  const { clock, disk } = world(on)
  await start($)
  const pane = await $.ui.mount(OPEN)
  disk.set(KEY, { items: [{ id: 'b1', text: 'Обновить зависимости', at: NOW, by: 'person' }], closed: [], next: 2 })
  await clock.advance(5_000)
  expect(await pane.find({ type: 'Text', text: 'Обновить зависимости' })).toBeDefined()
  await pane.input({ key: 'add-text', text: 'Проверить мобильную версию', kind: 'submit' })
  expect((disk.get(KEY) as Backlog).items.map(item => item.text)).toEqual(['Обновить зависимости', 'Проверить мобильную версию'])
})
