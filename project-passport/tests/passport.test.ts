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
  expect(opened).toEqual([])

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
    expect(await pane.find({ type: 'Text', text: /• Клиент: Денис/ })).toBeDefined()
    await pane.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'project-passport', surface: 'desktop', component: 'Pane', requestId: 'project-passport', props: PANE })
  await pane.select({ key: 'pp-section', value: 'rules' })
  await pane.input({ key: 'pp-text', text: 'Логотип не трогать', kind: 'submit' })
  expect(await pane.find({ type: 'Text', text: /• Логотип не трогать/ })).toBeDefined()
  expect(await brief($)).toContain('- [n2] Логотип не трогать')

  await pane.press({ key: 'lang-ru' })
  expect(await brief($)).toContain('written in Russian')

  await pane.press({ key: 'del-n1' })
  expect(await pane.find({ type: 'Text', text: /Убрать «Клиент: Денис»/ })).toBeDefined()
  await pane.press({ key: 'yes-n1' })
  expect(await pane.find({ type: 'Text', text: /• Клиент: Денис/ })).toBeUndefined()

  await pane.press({ key: 'pp-fill' })
  expect(submitted[0]).toContain('Заполни паспорт этого проекта')
})
