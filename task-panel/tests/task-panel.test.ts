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
  // The slash commands run, a plugin's among them.
  const ran: string[] = []
  on('command.run', ($, e) => {
    ran.push(e.command)
    return { text: `ran /${e.command}` }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: e.todos } }
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++ids), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    return { result: {} as never }
  })
  return { clock, opened, ran }
}

function mountPane($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'task-panel', surface, component: 'Pane', requestId: 'task-panel', props: PANE })
}

test('a request opens the panel, the todo list fills it, and all done turns it green', async ($, on) => {
  const { clock, opened } = world(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  // Open from the chat's first moment, before any request.
  expect(opened).toEqual(['task-panel'])
  await $.prompt.submit({ text: 'Почини падающие тесты в auth', wait: false, origin: { kind: 'composer' } })

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
  expect((await ui.find({ type: 'Text', text: '🪴 ВСЁ ГОТОВО ЗА 12 МИН' }))?.props.color).toBe('success')
  expect(await ui.find({ type: 'Text', text: 'ВСЕ ЭТАПЫ ВЫПОЛНЕНЫ · III' })).toBeDefined()
  // Done steps go grey, their ticks stay green.
  expect((await ui.find({ type: 'Text', text: 'Исправить' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'II.' }))?.props.dimColor).toBe(true)
  expect((await ui.findAll({ type: 'Text', text: '✓' })).map(found => found.props.color)).toEqual(['success', 'success', 'success'])
  // Nothing on the panel is bold.
  expect((await ui.findAll({ type: 'Text' })).filter(found => found.props.bold === true)).toEqual([])
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
  expect(await ui.find({ type: 'Text', text: /^🪴 ВСЁ ГОТОВО/ })).toBeDefined()
})

test('without a plan the gauge reads — while working and 100 % once answered', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($, 'terminal')
  const turn = async (turnId: string) => {
    await $.turn.start({ text: '', turnId })
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  }

  await $.prompt.submit({ text: 'Объясни, как работает кэш промптов', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: 'ПЛАН НЕ СОСТАВЛЕН' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()
  await turn('t1')
  expect((await ui.find({ type: 'Text', text: '100 %' }))?.props.color).toBe('success')
  expect(await ui.find({ type: 'Text', text: '🪴 ВСЁ ГОТОВО ЗА МЕНЬШЕ МИНУТЫ' })).toBeDefined()

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

test('prompts typed while Claude works wait in a queue at the top, and leave it once read', async ($, on) => {
  const { clock } = world(on)
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const ui = await mountPane($, 'desktop')
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(found => found.text)

  await $.prompt.submit({ text: 'Собери отчёт по продажам за месяц', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Собери отчёт по продажам за месяц', turnId: 't1' })
  expect(await texts()).not.toContain('ОЧЕРЕДЬ')

  await $.prompt.submit({ text: 'Добавь  ещё график\nпо месяцам', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'Потом обнови README проекта', wait: true, turnId: 't1', origin: { kind: 'composer' } })
  await $.prompt.submit({ text: '/compact', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  let shown = await texts()
  // The queue comes first, above the task.
  expect(shown.indexOf('ОЧЕРЕДЬ')).toBeLessThan(shown.indexOf('ЗАДАЧА'))
  for (const one of ['2', '1.', 'Добавь ещё график по месяцам', '2.', 'Потом обнови README проекта · после задачи']) expect(shown).toContain(one)
  expect(shown).toContain('Прочитаю после текущего шага. Отмеченные "после задачи" начну, когда закончу эту.')
  // The task stays the one being worked on.
  expect(shown).toContain('«Собери отчёт по продажам за месяц»')

  // Read after a step: it joins this task and leaves the queue.
  await $.prompt.attachment({
    type: 'queued_command',
    text: 'The user sent a new message while you were working:\nДобавь ещё график\nпо месяцам',
    origin: { kind: 'engine' },
  })
  shown = await texts()
  expect(shown).not.toContain('Добавь ещё график по месяцам')
  expect(shown).toContain('Начну, когда закончу эту задачу.')

  // The one that waited starts the next turn, and a task of its own.
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'Потом обнови README проекта', turnId: 't2' })
  shown = await texts()
  expect(shown).not.toContain('ОЧЕРЕДЬ')
  expect(shown).toContain('«Потом обнови README проекта»')

  // A prompt taken back from the queue (Esc, the up arrow) does not hang there.
  await $.prompt.submit({ text: 'И проверь ссылки в README', wait: false, turnId: 't2', origin: { kind: 'composer' } })
  expect(await texts()).toContain('И проверь ссылки в README')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: true, turnId: 't2', reason: 'answer' })
  await clock.advance(40_000)
  expect(await texts()).not.toContain('ОЧЕРЕДЬ')
})

test('a long run without a plan counts its actions and reminds the model to plan, once', async ($, on) => {
  world(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('classic.PostToolUse', () => ({}))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const context = await $.prompt.context({ blocks: [] })
  expect(context.blocks.find(block => block.name === 'taskPanel')?.text).toContain('call mcp__task-panel__plan with the intent and every step')

  await $.prompt.submit({ text: 'Подключи провайдера claude к серверу', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Подключи провайдера claude к серверу', turnId: 't1' })
  const base = { session_id: 's', transcript_path: '/t', cwd: '/w', hook_event_name: 'PostToolUse' as const, tool_input: {}, tool_response: {}, tool_use_id: 'u' }
  const notes: (readonly string[] | undefined)[] = []
  const act = async (tool: string, agentId?: string) => {
    const result = await $.classic.PostToolUse({ ...base, tool_name: tool, ...(agentId === undefined ? {} : { agent_id: agentId }) })
    notes.push(result.additionalContext)
  }
  await act('Read')
  await act('Grep', 'sub-1') // a subagent's action is not the task's
  await act('TodoWrite') // keeping a plan is not an action
  await act('Edit')
  await act('Bash')
  await act('Bash')
  await act('Bash')
  expect(notes.map(note => note?.length ?? 0)).toEqual([0, 0, 0, 0, 0, 1, 0])
  expect(notes[5]?.[0]).toContain('call mcp__task-panel__plan now')

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: 'БЕЗ ПЛАНА · ДЕЙСТВИЙ: 5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()

  await $.tool.call({ tool: 'mcp__task-panel__plan', steps: [{ title: 'Провайдер', status: 'completed' }, { title: 'Прогрев', status: 'in_progress' }] })
  expect(await ui.find({ type: 'Text', text: '50 %' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ЭТАП II ИЗ II' })).toBeDefined()
})

test('the project backlog outlives the chat: Claude and the person add to it, "в работу" hands an item to Claude', async ($, on) => {
  const { opened } = world(on)
  const kept: Record<string, unknown> = {
    'backlog:c:/work/shop': { items: [{ id: 'b1', text: 'Экспорт заказов в Excel', at: 1, by: 'person' }], next: 2 },
  }
  mock.store(on, kept)
  const toasts: string[] = []
  on('session.cwd', () => ({ value: 'C:\\work\\shop' }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: 'C:\\work\\shop', surface: 'desktop', isInteractive: true })

  // The panel is open from the start, and the model reads the list.
  expect(opened).toEqual(['task-panel'])
  const context = (await $.prompt.context({ blocks: [] })).blocks.find(block => block.name === 'taskPanel')?.text ?? ''
  expect(context).toContain('- [b1] Экспорт заказов в Excel')
  expect(context).toContain('add it with mcp__task-panel__backlog')

  const added = await $.tool.call({ tool: 'mcp__task-panel__backlog', add: ['Починить  вёрстку на телефоне', 'экспорт заказов в excel'] })
  expect(added.result).toBe('Бэклог проекта: пунктов 2. Добавлено: [b2] Починить вёрстку на телефоне.')
  expect(toasts).toEqual(['Бэклог: +1'])
  expect((await $.tool.call({ tool: 'mcp__task-panel__backlog', done: ['b9'] })).deny).toContain('нет пункта b9')

  const ui = await mountPane($, 'desktop')
  const shown = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  for (const one of ['БЭКЛОГ ПРОЕКТА · 2', 'Экспорт заказов в Excel', 'Починить вёрстку на телефоне', 'Enter, чтобы добавить']) expect(shown).toContain(one)
  // The field is not the pane's last row, so it is never cut at the bottom.
  expect(shown.at(-1)).toBe('Enter, чтобы добавить')

  await ui.input({ key: 'backlog-add', text: 'Подключить оплату картой', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: 'Подключить оплату картой' })).toBeDefined()

  // "в работу": the item leaves the list and becomes the task.
  await ui.press({ key: 'take-b2' })
  expect(await ui.find({ type: 'Text', text: '«Починить вёрстку на телефоне»' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · 2' })).toBeDefined()

  await ui.press({ key: 'drop-b1' })
  await $.tool.call({ tool: 'mcp__task-panel__backlog', done: ['b3'] })
  expect(await ui.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · пусто' })).toBeDefined()
  // Kept for the project: a new chat reads the empty list.
  await $.session.start({ cwd: 'C:\\work\\shop', surface: 'desktop', isInteractive: true })
  const fresh = (await $.prompt.context({ blocks: [] })).blocks.find(block => block.name === 'taskPanel')?.text ?? ''
  expect(fresh).toContain("The project's backlog in the Task panel is empty.")
})

test('backlog items show their age, close as done or not needed with real buttons, and come back', async ($, on) => {
  world(on)
  const DAY = 24 * 60 * 60 * 1000
  mock.store(on, {
    'backlog:c:/work/shop': {
      items: [
        { id: 'b1', text: 'Перевести письма на Zoho', at: 1_000_000, by: 'claude' },
        { id: 'b2', text: 'Старая идея про баннер', at: 1_000_000 - 20 * DAY, by: 'person' },
        { id: 'b3', text: 'Проверить версию 1.5.0 на сервере', at: 1_000_000, by: 'claude' },
      ],
      next: 4,
    },
  })
  on('session.cwd', () => ({ value: 'C:\\work\\shop' }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: 'C:\\work\\shop', surface: 'desktop', isInteractive: true })
  const ui = await mountPane($, 'desktop')
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(found => found.text)

  let shown = await texts()
  expect(shown).toContain('Claude · сегодня')
  // An old item asks whether it is still needed.
  expect(shown).toContain('ты · 20 дн. назад · давно, ещё нужно?')
  expect((await ui.find({ type: 'Text', text: 'ты · 20 дн. назад · давно, ещё нужно?' }))?.props.color).toBe('warning')
  // Real buttons, not plain text.
  for (const key of ['take-b1', 'done-b1', 'drop-b1', 'backlog-check', 'backlog-clear']) {
    expect((await ui.find({ type: 'Button', key }))?.props.plain).toBeUndefined()
  }
  expect((await ui.find({ type: 'Button', key: 'drop-b2' }))?.text).toBe('✕ не актуально')

  await ui.press({ key: 'done-b3' })
  await ui.press({ key: 'drop-b2' })
  shown = await texts()
  expect(shown).toContain('БЭКЛОГ ПРОЕКТА · 1')
  expect(shown).toContain('ЗАКРЫТО НЕДАВНО')
  // Newest closed first.
  expect(shown.indexOf('✕ Старая идея про баннер')).toBeLessThan(shown.indexOf('✓ Проверить версию 1.5.0 на сервере'))

  // Closed by mistake: back where it was.
  await ui.press({ key: 'reopen-b3' })
  expect(await ui.find({ type: 'Text', text: 'Проверить версию 1.5.0 на сервере' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · 2' })).toBeDefined()

  // "Очистить всё" takes a second press, and what it clears can still come back.
  await ui.press({ key: 'backlog-clear' })
  expect(await ui.find({ type: 'Text', text: /^Убрать все пункты \(2\)/ })).toBeDefined()
  await ui.press({ key: 'backlog-clear-yes' })
  expect(await ui.find({ type: 'Text', text: 'БЭКЛОГ ПРОЕКТА · пусто' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'reopen-b1' })).toBeDefined()

  // Claude marks the ones no longer needed with drop.
  await ui.press({ key: 'reopen-b1' })
  const dropped = await $.tool.call({ tool: 'mcp__task-panel__backlog', drop: ['b1'] })
  expect(dropped.deny).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '✕ Перевести письма на Zoho' })).toBeDefined()
})

test('"Проверить, что актуально" hands Claude the check as a task of its own', async ($, on) => {
  world(on)
  mock.store(on, { 'backlog:c:/work/shop': { items: [{ id: 'b1', text: 'Перевести письма на Zoho', at: 1_000_000, by: 'claude' }], next: 2 } })
  on('session.cwd', () => ({ value: 'C:\\work\\shop' }))
  await $.session.start({ cwd: 'C:\\work\\shop', surface: 'desktop', isInteractive: true })
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'backlog-check' })
  expect(await ui.find({ type: 'Text', text: '«Проверка бэклога: что ещё актуально»' })).toBeDefined()
  // The list stays until Claude closes what it finds done.
  expect(await ui.find({ type: 'Text', text: 'Перевести письма на Zoho' })).toBeDefined()
})

test('the panel starts with the task: the app shows its own tabs above it', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Button', key: 'tab-task' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'tab-passport' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('ЗАДАЧА')

  // Opened by another plugin, the panel leaves no line in the chat.
  const quiet = await $.command.run({ command: 'task-panel', args: '', origin: { kind: 'plugin', name: 'project-passport' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(quiet.text).toBeUndefined()
})

test('the intent sits above the plan, and the task is done only once its checks hold', async ($, on) => {
  world(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Сделай форму заявки с отправкой на почту', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Сделай форму заявки с отправкой на почту', turnId: 't1' })
  const intent = {
    goal: 'Клиенты оставляют заявку, и она приходит на почту менеджеру',
    criteria: [{ text: 'Форма отправляется без ошибок' }, { text: 'Письмо приходит на info@' }],
  }
  const planned = await $.tool.call({
    tool: 'mcp__task-panel__plan',
    intent,
    steps: [
      { title: 'Форма', status: 'in_progress' },
      { title: 'Отправка писем', status: 'pending' },
    ],
  })
  expect(planned.result).toBe('План на пульте: готово 0 из 2. Критерии: выполнено 0 из 2.')

  const ui = await mountPane($, 'desktop')
  let shown = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  for (const one of ['ЧТО ХОТИМ', intent.goal, 'ГОТОВО, КОГДА', 'Форма отправляется без ошибок', 'Письмо приходит на info@']) expect(shown).toContain(one)
  // Above the plan.
  expect(shown.indexOf('ГОТОВО, КОГДА')).toBeLessThan(shown.indexOf('ГОТОВНОСТЬ'))

  // Steps done, checks not yet: not done, and the model is told to check.
  const stepsDone = await $.tool.call({
    tool: 'mcp__task-panel__plan',
    steps: [
      { title: 'Форма', status: 'completed' },
      { title: 'Отправка писем', status: 'completed' },
    ],
  })
  expect(stepsDone.result).toContain('Шаги готовы, но не все критерии отмечены')
  expect(await ui.find({ type: 'Text', text: 'ШАГИ ГОТОВЫ · СВЕРЯЮ С ЦЕЛЬЮ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '50 %' })).toBeDefined()

  // Every check holds: done, 🪴.
  await $.tool.call({
    tool: 'mcp__task-panel__plan',
    intent: { ...intent, criteria: intent.criteria.map(one => ({ ...one, met: true })) },
    steps: [
      { title: 'Форма', status: 'completed' },
      { title: 'Отправка писем', status: 'completed' },
    ],
  })
  shown = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(shown.some(text => text.startsWith('🪴 ВСЁ ГОТОВО'))).toBe(true)
  expect(shown).toContain('100 %')
  expect((await ui.findAll({ type: 'Text', text: '✓' })).length).toBe(4)

  // A malformed intent is refused with the reason.
  const refused = await $.tool.call({ tool: 'mcp__task-panel__plan', intent: { goal: 'x', criteria: [] }, steps: [{ title: 'a', status: 'pending' }] })
  expect(refused.deny).toContain('intent.criteria')
})
