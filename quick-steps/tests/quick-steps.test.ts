import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptOrigin, RenderPropsOf } from 'claude-code'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

const LONG_ANSWER = 'Готово. '.repeat(20)

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Three prompts, the last too long to show whole.
const REPLY = JSON.stringify(['Прогони тесты модуля auth', 'Закоммить изменения', 'x'.repeat(200)])

type Row = { role: 'user' | 'assistant'; text: string; toolUses: never[] }
type CompleteResult =
  | { isAnswered: true; text: string; usage: typeof USAGE }
  | { isAnswered: false; reason: 'api-error'; status: number | null; error: string; usage: typeof USAGE }

// The engine beneath the plugin: a cheap model and a fork that both suggest the
// same three prompts (the cheap one can be made to fail), a transcript, an
// editor that types what it is given, and records of what was asked, suggested
// and sent.
function world(on: On, options: { transcript?: Row[]; complete?: CompleteResult } = {}) {
  const clock = mock.clock(on, { now: 0 })
  const sent: { text: string; origin: PromptOrigin }[] = []
  const forks: string[] = []
  const logs: string[] = []
  const completes: { model: string; system?: unknown; prompt: unknown }[] = []
  on('command.list', () => ({ value: [] }))
  on('session.messages', () => ({ value: options.transcript ?? [] }))
  on('model.complete', ($, e) => {
    completes.push({ model: e.model, system: e.system, prompt: e.prompt })
    return { value: options.complete ?? { isAnswered: true as const, text: REPLY, usage: USAGE } }
  })
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true as const, text: REPLY, usage: USAGE } }
  })
  on('prompt.edit', ($, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  return { clock, sent, forks, completes, logs }
}

test('a press sends the suggestion at once', async ($, on) => {
  const { clock, sent } = world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    sent.length = 0
    await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: `t-${surface}`, reason: 'answer' })
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'quick-steps', surface, component: 'AbovePrompt', props: BAND })
    const labels = (await ui.findAll({ type: 'Button' })).map(button => button.text)
    expect(labels).toEqual(['Прогони тесты модуля auth', 'Закоммить изменения', 'скрыть'])
    // One under another, not side by side.
    expect((await ui.find({ key: 'seg-4-steps' }))?.props.flexDirection).toBe('column')

    await ui.press({ key: 's1' })
    // The kit hands the text alone; a session stamps the plugin's origin, asUser.
    expect(sent.map(one => one.text)).toEqual(['Закоммить изменения'])
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  }
})

test('the first suggestion is the recommended one, and the model is told to mark its own', async ($, on) => {
  const { clock, sent, completes } = world(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(String(completes[0]?.prompt)).toContain('Order them best first: the first one is the step you recommend.')

  const ui = await $.ui.mount({ plugin: 'quick-steps', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const marks = await ui.findAll({ type: 'Text', text: '(Рекомендую)' })
  expect(marks).toHaveLength(1)
  expect(marks[0]?.props.color).toBe('success')
  // The mark is shown beside the first, not sent with it.
  await ui.press({ key: 's0' })
  expect(sent.map(one => one.text)).toEqual(['Прогони тесты модуля auth'])

  const rule = (await $.prompt.context({ blocks: [] })).blocks.find(block => block.name === 'nextSteps')?.text ?? ''
  expect(rule).toContain('"(Рекомендую)"')
})

test('a suggested slash command runs as a command, not as a message', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: string[] = []
  const commands: { command: string; args: string }[] = []
  on('command.list', () => ({ value: [{ name: 'report', description: 'Отчёт клиенту', source: 'plugin' as const }] }))
  on('command.run', ($, e) => {
    commands.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({
    value: { isAnswered: true as const, text: JSON.stringify(['/report за неделю', 'Закоммить изменения']), usage: USAGE },
  }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))

  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'quick-steps', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 's0' })
  expect(commands).toEqual([{ command: 'report', args: 'за неделю' }])
  expect(sent).toEqual([])
})

test('0 hides the suggestions without sending anything', async ($, on) => {
  const { clock, sent } = world(on)
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'quick-steps', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'dismiss' })
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  expect(sent).toEqual([])
})

test('a short answer gets no suggestions', async ($, on) => {
  const { clock, forks, completes } = world(on)
  await $.turn.complete({ answer: 'Ок.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(forks).toEqual([])
  expect(completes).toEqual([])
})

test('the cheap model is asked by default, with the conversation, and the fork stays unused', async ($, on) => {
  const { clock, forks, completes, logs } = world(on, {
    transcript: [
      { role: 'user', text: 'Почини цифры в подсказках', toolUses: [] },
      { role: 'assistant', text: 'Нашёл причину: цифры работают только в фокусе панели.', toolUses: [] },
    ],
  })
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(logs).toEqual([])
  expect(forks).toEqual([])
  expect(completes).toHaveLength(1)
  expect(completes[0]?.model).toBe('haiku')
  const prompt = String(completes[0]?.prompt)
  expect(prompt).toContain('Почини цифры в подсказках')
  expect(prompt).toContain('Нашёл причину')
  expect(prompt).toContain('[assistant, the answer just given]')
  expect(prompt).toContain('Готово.')
})

test('when the cheap model cannot answer, the session model is asked instead', async ($, on) => {
  const { clock, forks } = world(on, {
    complete: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
  })
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(forks).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'quick-steps', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const labels = (await ui.findAll({ type: 'Button' })).map(button => button.text)
  expect(labels).toEqual(['Прогони тесты модуля auth', 'Закоммить изменения', 'скрыть'])
})

// What the editor tells a prompt.edit hook for one typed key.
function typed(key: string, text = '') {
  return {
    origin: { kind: 'composer' as const },
    key: { key },
    text,
    cursor: text.length,
    start: text.length,
    end: text.length,
    inputText: key,
  }
}

test('a digit typed into the empty box sends that suggestion and is not typed', async ($, on) => {
  const { clock, sent } = world(on)
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const box = await $.prompt.edit(typed('2'))
  expect(box.text).toBe('')
  expect(sent.map(one => one.text)).toEqual(['Закоммить изменения'])
  // They are gone once one is taken: the next digit is an ordinary key.
  const again = await $.prompt.edit(typed('1'))
  expect(again.text).toBe('1')
  expect(sent).toHaveLength(1)
})

test('0 typed into the empty box hides the suggestions and sends nothing', async ($, on) => {
  const { clock, sent } = world(on)
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect((await $.prompt.edit(typed('0'))).text).toBe('')
  expect(sent).toEqual([])
  expect((await $.prompt.edit(typed('1'))).text).toBe('1')
})

test('a digit is an ordinary key after other text, with no suggestion behind it, or as a paste', async ($, on) => {
  const { clock, sent } = world(on)
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect((await $.prompt.edit(typed('1', 'версия '))).text).toBe('версия 1')
  // Two are on offer: a 3 still types.
  expect((await $.prompt.edit(typed('3'))).text).toBe('3')
  // A paste carries no key.
  const { key: _key, ...paste } = typed('1')
  expect((await $.prompt.edit(paste)).text).toBe('1')
  expect(sent).toEqual([])
})
