import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const TOOL = 'mcp__project-passport__passport_update'
const STORE_KEY = 'passport:c:/work/acme-crm'

const PANE: RenderPropsOf['Pane'] = {
  title: 'Паспорт проекта',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
}

// The engine beneath the plugin: a store, a question dialog that answers what
// the test sets, and records of what was opened, asked and submitted.
function world(on: On, kept: Record<string, unknown> = {}) {
  mock.clock(on, { now: Date.UTC(2026, 9, 11, 9, 30) })
  mock.store(on, kept)
  const asked: string[] = []
  const opened: string[] = []
  const submitted: string[] = []
  const dialog = { reply: 'Записать' }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\work\\acme-crm' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__project-passport__${e.name}` } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: dialog.reply } } }
  })
  return { asked, opened, submitted, dialog }
}

const brief = async ($: { prompt: { context: (input: { blocks: [] }) => Promise<{ blocks: readonly { name: string; text: string }[] }> } }) =>
  (await $.prompt.context({ blocks: [] })).blocks.find(block => block.name === 'projectPassport')?.text ?? ''

test('the model writes to the passport after «Записать», and reads it back', async ($, on) => {
  const { asked, opened } = world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  // Open beside the task panel even while empty, so it is always at hand.
  expect(opened).toEqual(['project-passport'])

  const written = await $.tool.call({
    tool: TOOL,
    add: [
      { section: 'client', text: 'Клиенты: Fatima (менеджер) и Dent1st (владелец), визы в Индонезии' },
      { section: 'rules', text: 'Суммы показываем в рупиях (IDR)' },
    ],
    replyLanguage: 'ru',
  })
  expect(written.result).toContain('Записано в паспорт')
  expect(asked[0]).toBe(
    'Записать в паспорт проекта: + Клиент и общение: Клиенты: Fatima (менеджер) и Dent1st (владелец), визы в Индонезии · ' +
      '+ Правила и тонкости: Суммы показываем в рупиях (IDR) · клиенту пишем по-русски?',
  )
  const text = await brief($)
  expect(text).toContain('Messages and reports for the client are written in Russian.')
  expect(text).toContain('- [n2] Суммы показываем в рупиях (IDR)')
})

test('«Отмена» changes nothing, and a secret is refused before anything is asked', async ($, on) => {
  const { asked, dialog } = world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'terminal', isInteractive: true })
  dialog.reply = 'Отмена'
  const cancelled = await $.tool.call({ tool: TOOL, add: [{ section: 'rules', text: 'Тёмная тема по умолчанию' }] })
  expect(cancelled.result).toBe('Паспорт не изменён: пользователь нажал «Отмена».')
  const refused = await $.tool.call({ tool: TOOL, add: [{ section: 'places', text: 'пароль: admin123' }] })
  expect(refused.deny).toContain('похоже на пароль')
  expect(asked).toHaveLength(1)
  expect(await brief($)).toContain('This project has no passport yet')
})

test('the pane opens by itself where there is a passport, and edits it', async ($, on) => {
  const kept = {
    [STORE_KEY]: { replyLanguage: 'en', next: 2, notes: [{ id: 'n1', section: 'client', text: 'Клиент: Денис', at: 1, by: 'person' }] },
  }
  const { opened, submitted } = world(on, kept)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['project-passport'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'project-passport', surface, component: 'Pane', requestId: 'project-passport', props: PANE })
    expect(await pane.find({ type: 'Text', text: 'acme-crm' })).toBeDefined()
    expect((await pane.find({ key: 'lang-en' }))?.props.variant).toBe('primary')
    expect(await pane.find({ type: 'Text', text: /^Клиент: Денис/ })).toBeDefined()
    // Numbered, not bulleted.
    expect(await pane.find({ type: 'Text', text: '1.' })).toBeDefined()
    await pane.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'project-passport', surface: 'desktop', component: 'Pane', requestId: 'project-passport', props: PANE })
  await pane.select({ key: 'pp-section', value: 'rules' })
  await pane.input({ key: 'pp-text', text: 'Логотип не трогать', kind: 'submit' })
  expect(await pane.find({ type: 'Text', text: /^Логотип не трогать/ })).toBeDefined()
  expect(await brief($)).toContain('- [n2] Логотип не трогать')

  await pane.press({ key: 'lang-ru' })
  expect(await brief($)).toContain('written in Russian')

  await pane.press({ key: 'del-n1' })
  expect(await pane.find({ type: 'Text', text: /Убрать "Клиент: Денис"/ })).toBeDefined()
  await pane.press({ key: 'yes-n1' })
  expect(await pane.find({ type: 'Text', text: /^Клиент: Денис/ })).toBeUndefined()

  await pane.press({ key: 'pp-fill' })
  expect(submitted[0]).toContain('Заполни паспорт этого проекта')
})

test('the pane reads in sections: no long dashes, labels above the fields, settings as rows, nothing bold', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'project-passport', surface: 'desktop', component: 'Pane', requestId: 'project-passport', props: PANE })
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts.filter(text => /[—–]/.test(text))).toEqual([])
  for (const one of ['Кто клиент, как и на каком языке с ним общаться, договорённости и деньги.', 'Не выбран. Нажми нужный.', 'Раздел', 'Заметка', 'Открывать при старте чата', 'Записи Claude']) {
    expect(texts).toContain(one)
  }
  // The fields carry no labels of their own: theirs stand above them.
  expect((await pane.find({ type: 'Select', key: 'pp-section' }))?.props.label).toBeUndefined()
  expect((await pane.find({ type: 'Input', key: 'pp-text' }))?.props.label).toBeUndefined()
  // "Добавить" stands at the right of the note field, on its row.
  type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const holds = (node: unknown, type: string, key: string): boolean => {
    const one = node as Node
    if (typeof node !== 'object' || node === null) return false
    if (one.type === type && one.props?.key === key) return true
    return (one.children ?? []).some(child => holds(child, type, key))
  }
  // The innermost Box that holds both, each in a child of its own.
  const rowOf = (node: unknown): Node | undefined => {
    const one = node as Node
    if (typeof node !== 'object' || node === null) return undefined
    const children = one.children ?? []
    for (const child of children) {
      const found = rowOf(child)
      if (found !== undefined) return found
    }
    const field = children.findIndex(child => holds(child, 'Input', 'pp-text'))
    const button = children.findIndex(child => holds(child, 'Button', 'pp-add'))
    return one.type === 'Box' && field !== -1 && button !== -1 && field !== button ? one : undefined
  }
  const row = rowOf(await pane.drawn())
  expect(row).toBeDefined()
  expect(row?.props?.flexDirection).toBeUndefined()
  expect((await pane.find({ type: 'Button', key: 'pp-autoopen' }))?.text).toBe('да')
  expect((await pane.find({ type: 'Button', key: 'pp-ask' }))?.text).toBe('с вопросом')
  expect((await pane.findAll({ type: 'Text' })).filter(found => found.props.bold === true)).toEqual([])
})

test('the passport starts with its heading: the app shows its own tabs above it', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'project-passport', surface: 'desktop', component: 'Pane', requestId: 'project-passport', props: PANE })
  expect(await pane.find({ type: 'Button', key: 'tab-task' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'tab-passport' })).toBeUndefined()
  expect((await pane.findAll({ type: 'Text' }))[0]?.text).toBe('ПАСПОРТ ПРОЕКТА')
})

test('"Очистить" empties one section on the second press, and leaves the others', async ($, on) => {
  const kept = {
    [STORE_KEY]: {
      replyLanguage: null,
      next: 4,
      notes: [
        { id: 'n1', section: 'project', text: 'Acme-sync Sync: панель синхронизации цен', at: 1, by: 'claude' },
        { id: 'n2', section: 'project', text: 'Стек: Next.js и 1С-Битрикс', at: 1, by: 'claude' },
        { id: 'n3', section: 'rules', text: 'Логотип не трогать', at: 1, by: 'person' },
      ],
    },
  }
  world(on, kept)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'project-passport', surface: 'desktop', component: 'Pane', requestId: 'project-passport', props: PANE })

  // Only a section with notes offers it.
  expect((await pane.find({ type: 'Button', key: 'clear-project' }))?.text).toBe('Очистить')
  expect(await pane.find({ type: 'Button', key: 'clear-client' })).toBeUndefined()

  await pane.press({ key: 'clear-project' })
  expect(await pane.find({ type: 'Text', text: 'Убрать все заметки раздела (2)?' })).toBeDefined()
  await pane.press({ key: 'clear-yes-project' })
  expect(await pane.find({ type: 'Text', text: /^Acme-sync Sync/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Одной строкой, что это за проект для клиента. Стек и устройство живут в CLAUDE.md.' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Логотип не трогать/ })).toBeDefined()

  // "Отмена" keeps everything.
  await pane.press({ key: 'clear-rules' })
  await pane.press({ key: 'clear-no-rules' })
  expect(await pane.find({ type: 'Text', text: /^Логотип не трогать/ })).toBeDefined()
})

test('the client in the passport, the code in CLAUDE.md: the model is told, and "Разобрать" sorts both', async ($, on) => {
  const { submitted } = world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  // Told in every chat, with an empty passport too.
  const told = await brief($)
  expect(told).toContain("belong in the project's CLAUDE.md, which is in git")
  expect(told).toContain('never in CLAUDE.md, README or any other file of the repository')

  const pane = await $.ui.mount({ plugin: 'project-passport', surface: 'desktop', component: 'Pane', requestId: 'project-passport', props: PANE })
  await pane.press({ key: 'pp-fill' })
  expect(submitted[0]).toContain('Стек, команды и правила по коду не переписывай')
  await pane.press({ key: 'pp-sort' })
  expect(submitted[1]).toContain('Разбери паспорт проекта и CLAUDE.md')
  expect(submitted[1]).toContain('Сначала покажи мне списком, что куда переносишь')

  // A passport with notes tells it as well.
  await $.tool.call({ tool: TOOL, add: [{ section: 'client', text: 'Клиент: Денис' }] })
  expect(await brief($)).toContain('Do not copy into the passport what README or CLAUDE.md already say.')
})
