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

// The engine beneath the plugin: a fork that suggests three prompts (one too
// long to show whole), and records of what was suggested and sent.
function world(on: On) {
  const clock = mock.clock(on, { now: 0 })
  const sent: { text: string; origin: PromptOrigin }[] = []
  const forks: string[] = []
  on('command.list', () => ({ value: [] }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return {
      value: {
        isAnswered: true as const,
        text: JSON.stringify(['Прогони тесты модуля auth', 'Закоммить изменения', 'x'.repeat(200)]),
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return { clock, sent, forks }
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
  const { clock, sent, forks } = world(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  await $.turn.complete({ answer: LONG_ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(forks[0]).toContain('Order them best first: the first one is the step you recommend.')

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
  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: JSON.stringify(['/report за неделю', 'Закоммить изменения']),
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
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
  const { clock, forks } = world(on)
  await $.turn.complete({ answer: 'Ок.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(forks).toEqual([])
})
