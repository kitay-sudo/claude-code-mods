import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const MINUTE = 60_000

const PANE: RenderPropsOf['Pane'] = {
  title: 'Пульт задачи',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const todo = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status, activeForm: content })

// The engine beneath the plugin: a clock, panes that always place, and tools
// that answer as the real ones do.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  let ids = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__task-panel__${e.name}` } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.run', ($, e) => ({ text: `ran /${e.command}` }))
  on('tool.call', ($, e) => {
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: e.todos } }
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++ids), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    return { result: {} as never }
  })
  return { clock, opened }
}

function mountPane($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'task-panel', surface, component: 'Pane', requestId: 'task-panel', props: PANE })
}

test('a request opens the panel, the todo list fills it, and all done turns it green', async ($, on) => {
  const { clock, opened } = world(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Почини падающие тесты в auth', wait: false, origin: { kind: 'composer' } })
  expect(opened).toEqual(['task-panel'])

  await $.turn.start({ text: 'Почини падающие тесты в auth', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [todo('Найти падающий тест', 'completed'), todo('Исправить', 'in_progress'), todo('Прогнать тесты', 'pending')],
  })
  await clock.advance(12 * MINUTE)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    for (const shown of [
      'ЗАДАЧА',
      '«Почини падающие тесты в auth»',
      'ГОТОВНОСТЬ',
      '33 %',
      `${'▰'.repeat(8)}${'▱'.repeat(16)}`,
      'ЭТАП II ИЗ III',
      '⏱ 12 мин',
      'I.',
      'Найти падающий тест',
      'II.',
      'Исправить',
      '←',
      'III.',
      'Прогнать тесты',
      'РЕЖИМ: РАБОТАЮ',
    ]) {
      expect(texts).toContain(shown)
    }
    expect(texts.filter(text => text.includes('─'))).toEqual([])
    expect((await ui.find({ type: 'Text', text: '33 %' }))?.props.color).toBeUndefined()
    await ui.unmount()
  }

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [todo('Найти падающий тест', 'completed'), todo('Исправить', 'completed'), todo('Прогнать тесты', 'completed')],
  })
  await clock.advance(5 * MINUTE)
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ type: 'Text', text: '100 %' }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: '✓ ВСЁ ГОТОВО ЗА 12 МИН' }))?.props.color).toBe('success')
  expect(await ui.find({ type: 'Text', text: 'ВСЕ ЭТАПЫ ВЫПОЛНЕНЫ · III' })).toBeDefined()
})

test('the plan tool lays out the steps where the model has no todo list', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Переделай пульт в инженерном стиле', wait: false, origin: { kind: 'sdk' } })

  const ran = await $.tool.call({
    tool: 'mcp__task-panel__plan',
    steps: [
      { title: 'Новый вид', status: 'completed' },
      { title: 'Инструмент плана', status: 'in_progress' },
      { title: 'Тесты', status: 'pending' },
      { title: 'Установка', status: 'pending' },
    ],
  })
  expect(ran.deny).toBeUndefined()
  expect(ran.result).toBe('План на пульте: готово 1 из 4.')
  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: '25 %' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ЭТАП II ИЗ IV' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'IV.' })).toBeDefined()

  const refused = await $.tool.call({ tool: 'mcp__task-panel__plan', steps: [{ title: 'x', status: 'done' }] })
  expect(refused.deny).toContain('steps')
})

test('/goal names the task, and the task tools fill its plan', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.command.run({
    command: 'goal',
    args: 'все тесты в test/auth проходят',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Найти причину', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Лишний шаг', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: 'ЦЕЛЬ · /goal' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '«все тесты в test/auth проходят»' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '50 %' })).toBeDefined()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' })
  expect(await ui.find({ type: 'Text', text: '100 %' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ ВСЁ ГОТОВО/ })).toBeDefined()
})

test('without a plan the gauge reads 0 % while working and 100 % once answered', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal')
  const turn = async (turnId: string) => {
    await $.turn.start({ text: '', turnId })
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  }

  await $.prompt.submit({ text: 'Объясни, как работает кэш промптов', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: 'ПЛАН НЕ СОСТАВЛЕН' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '0 %' })).toBeDefined()
  await turn('t1')
  expect((await ui.find({ type: 'Text', text: '100 %' }))?.props.color).toBe('success')
  expect(await ui.find({ type: 'Text', text: '✓ ВСЁ ГОТОВО ЗА МЕНЬШЕ МИНУТЫ' })).toBeDefined()

  await $.prompt.submit({ text: 'да', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: 'РЕЖИМ: ЖДУ ТЕБЯ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '«Объясни, как работает кэш промптов»' })).toBeDefined()
  await turn('t2')

  await $.prompt.submit({ text: 'Теперь сделай мод для строки статуса', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: '«Теперь сделай мод для строки статуса»' })).toBeDefined()

  await $.prompt.submit({ text: 'Ещё одна большая задача про тесты', wait: false, origin: { kind: 'task-notification' } })
  expect(await ui.find({ type: 'Text', text: '«Теперь сделай мод для строки статуса»' })).toBeDefined()

  // A suggestion the person pressed comes as a plugin's prompt in their words.
  await turn('t3')
  await $.prompt.submit({
    text: 'Прогони тесты модуля auth',
    wait: false,
    origin: { kind: 'plugin', name: 'quick-steps', asUser: true },
  })
  expect(await ui.find({ type: 'Text', text: '«Прогони тесты модуля auth»' })).toBeDefined()
})
