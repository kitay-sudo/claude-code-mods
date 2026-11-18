import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { addItems, ageText, backlogBriefing, closeItems, dateLabel, emptyBacklog, isStale, reopenItem, restoreBacklog, rowMeta, rowsOf, tabCounts } from '../hooks/backlog'
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
  // The project's name is not on the pane.
  expect(await pane.find({ type: 'Text', text: 'shop' })).toBeUndefined()
  await pane.input({ key: 'add-text', text: 'Логи на сервере', kind: 'submit' })
  expect((disk.get(KEY) as Backlog).items.map(item => `${item.id} ${item.by}`)).toEqual(['b1 claude', 'b2 person'])

  // "в работу" hands it over and keeps it until Claude marks it done.
  await pane.press({ key: 'take-b2' })
  expect(submitted).toEqual(['Сделай пункт бэклога [b2]: Логи на сервере. Когда закончишь, отметь его сделанным.'])
  expect(await pane.find({ type: 'Button', key: 'take-b2' })).toBeDefined()
  await $.tool.call({ tool: TOOL, done: ['b2'] })
  expect(await pane.find({ type: 'Button', key: 'take-b2' })).toBeUndefined()
  // A done item leaves the current tab and stands on the done one.
  await pane.press({ key: 'tab-done' })
  expect(await pane.find({ type: 'Text', text: 'Логи на сервере' })).toBeDefined()
  await pane.press({ key: 'tab-open' })

  await pane.press({ key: 'drop-b1' })
  expect(await pane.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · пусто' })).toBeDefined()
  // A dropped one is only in "Все", with its way back.
  await pane.press({ key: 'tab-all' })
  await pane.press({ key: 'reopen-b1' })
  await pane.press({ key: 'tab-open' })
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

test('a finished task has an "отчёт" button that hands Claude the report request; a dropped one has none', async ($, on) => {
  const { submitted } = world(on)
  await start($)
  await $.tool.call({ tool: TOOL, add: ['Поправить письма клиентам', 'Старый эксперимент'] })
  await $.tool.call({ tool: TOOL, done: ['b1'] })
  await $.tool.call({ tool: TOOL, drop: ['b2'] })

  const pane = await $.ui.mount(OPEN)
  await pane.press({ key: 'tab-done' })
  expect(await pane.find({ type: 'Button', key: 'reopen-b2' })).toBeUndefined()
  await pane.press({ key: 'report-b1' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('[b1]: Поправить письма клиентам')
  expect(submitted[0]).toContain('🪴')
  // The task stays done: a report is only asked for.
  expect(await pane.find({ type: 'Text', text: 'Поправить письма клиентам' })).toBeDefined()
  // The dropped one is in "Все" with its way back, and no report.
  await pane.press({ key: 'tab-all' })
  expect(await pane.find({ type: 'Button', key: 'report-b2' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'reopen-b2' })).toBeDefined()
})

// Two current items (one a week old), a done one and a dropped one.
function sample(): Backlog {
  return {
    items: [
      { id: 'b3', text: 'Старая задача', at: NOW - 8 * DAY, by: 'claude' },
      { id: 'b4', text: 'Свежая задача', at: NOW - DAY, by: 'person' },
    ],
    closed: [
      { id: 'b1', text: 'Сделанная задача', at: NOW - 5 * DAY, by: 'person', closedAt: NOW - 2 * DAY, how: 'done' },
      { id: 'b2', text: 'Ненужная задача', at: NOW - 3 * DAY, by: 'person', closedAt: NOW - 3 * DAY, how: 'dropped' },
    ],
    next: 5,
  }
}

test('each tab lists the freshest first, by the date it shows', () => {
  const backlog = sample()
  expect(tabCounts(backlog)).toEqual({ open: 2, done: 1, all: 4 })
  expect(rowsOf(backlog, 'open').map(row => row.id)).toEqual(['b4', 'b3'])
  expect(rowsOf(backlog, 'done').map(row => row.id)).toEqual(['b1'])
  // Everything together: the day a current one was added, the day a closed one was closed.
  expect(rowsOf(backlog, 'all').map(row => `${row.id} ${row.state}`)).toEqual(['b4 open', 'b1 done', 'b2 dropped', 'b3 open'])
})

test('a date reads dd.mm, with the year only when it is not this one, and each line says what it is', () => {
  expect(dateLabel(NOW - DAY, NOW)).toBe('14.10')
  expect(dateLabel(new Date(2025, 11, 31, 10, 0).getTime(), NOW)).toBe('31.12.2025')
  expect(dateLabel(0, NOW)).toBe('')
  const [fresh, old] = rowsOf(sample(), 'open')
  expect(rowMeta(fresh!, NOW)).toBe('14.10 · ты')
  expect(rowMeta(old!, NOW)).toBe('07.10 · Claude · давно, ещё нужно?')
  const [done, dropped] = rowsOf(sample(), 'all').filter(row => row.state !== 'open')
  expect(rowMeta(done!, NOW)).toBe('сделано 13.10 · добавлено 10.10')
  // Added and dropped on one day: said once.
  expect(rowMeta(dropped!, NOW)).toBe('не актуально 12.10')
})

test('the pane has three tabs with their counts, the freshest on top and a date on every item', async ($, on) => {
  const disk = new Map<string, unknown>([[KEY, sample()]])
  world(on, disk)
  await start($)
  const pane = await $.ui.mount(OPEN)
  const labels = (await pane.findAll({ type: 'Button' })).map(button => button.text)
  expect(labels).toEqual(expect.arrayContaining(['Текущие 2', 'Выполненные 1', 'Все 4']))

  const order = async () => (await pane.findAll({ type: 'Text' })).map(found => String(found.text))
  let texts = await order()
  expect(texts.indexOf('Свежая задача')).toBeGreaterThan(-1)
  expect(texts.indexOf('Свежая задача')).toBeLessThan(texts.indexOf('Старая задача'))
  expect(texts).toContain('14.10 · ты')
  expect(texts).toContain('07.10 · Claude · давно, ещё нужно?')
  expect(texts).toContain('Давно висят: 1. Возможно, уже сделаны.')

  await pane.press({ key: 'tab-all' })
  texts = await order()
  expect(texts).toContain('сделано 13.10 · добавлено 10.10')
  expect(texts).toContain('не актуально 12.10')
  await pane.press({ key: 'tab-done' })
  texts = await order()
  expect(texts).toContain('Сделанная задача')
  expect(texts).not.toContain('Свежая задача')
})

test('the done tab is a long history: far more than ten closed items are kept', () => {
  let backlog: Backlog = emptyBacklog()
  for (let one = 1; one <= 40; one++) {
    backlog = addItems(backlog, [`Задача ${one}`], one, 'person')
    backlog = closeItems(backlog, [`b${one}`], 'done', one + 1)
  }
  expect(restoreBacklog(JSON.parse(JSON.stringify(backlog))).closed).toHaveLength(40)
  expect(tabCounts(backlog).done).toBe(40)
})

test('the pane is one tight column: the field on top, no project name, no dot, one row of buttons with an icon for "не актуально"', async ($, on) => {
  const disk = new Map<string, unknown>([[KEY, sample()]])
  world(on, disk)
  await start($)
  const pane = await $.ui.mount(OPEN)
  const texts = (await pane.findAll({ type: 'Text' })).map(found => String(found.text))
  // The field comes before the list, and its button is the first button of the pane.
  expect(texts.indexOf('ДОБАВИТЬ НА ПОТОМ')).toBeGreaterThan(-1)
  expect(texts.indexOf('ДОБАВИТЬ НА ПОТОМ')).toBeLessThan(texts.indexOf('Свежая задача'))
  expect(await pane.find({ type: 'Input', key: 'add-text' })).toBeDefined()
  const buttons = (await pane.findAll({ type: 'Button' })).map(button => button.key)
  expect(buttons[0]).toBe('add')
  // No dot before current items; an item's three buttons stand together, "не актуально" last.
  expect(texts).not.toContain('○')
  expect(buttons.filter(key => String(key).endsWith('-b4'))).toEqual(['take-b4', 'done-b4', 'drop-b4'])

  // "Все" marks only what is closed; "Выполненные" has no field to add to.
  await pane.press({ key: 'tab-all' })
  const all = (await pane.findAll({ type: 'Text' })).map(found => String(found.text))
  expect(all).toContain('✓')
  expect(all).toContain('✕')
  expect(all).not.toContain('○')
  await pane.press({ key: 'tab-done' })
  expect(await pane.find({ type: 'Input', key: 'add-text' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'ДОБАВИТЬ НА ПОТОМ' })).toBeUndefined()
})
