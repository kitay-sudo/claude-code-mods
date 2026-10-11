import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const NBSP = '\u00a0'
const STORE_KEY = 'spend:c:/work/acme-sync'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const PANE: RenderPropsOf['Pane'] = {
  title: 'Расход',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
}

// The engine beneath the plugin: a session whose run, cost and windows the
// test sets, what lies beneath the block, and the toasts it was handed.
function world(on: On, kept: Record<string, unknown> = {}, beneath: unknown = { type: 'Box' }) {
  const clock = mock.clock(on, { now: new Date(2026, 9, 11, 12, 0).getTime() })
  mock.store(on, kept)
  const toasts: string[] = []
  const sim = { usd: 0, startedAt: 0, limits: [] as { kind: string; percentUsed: number; resetsAt?: string }[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\work\\acme-sync' }))
  on('session.usage', () => ({
    value: { startedAt: sim.startedAt, context: { window: 200_000 }, rateLimits: sim.limits, cost: { usd: sim.usd } },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => beneath as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { clock, sim, toasts }
}

const turn = ($: { turn: { complete: (input: { answer: string; durationMs: number; isAborted: boolean; turnId: string; reason: 'answer' }) => Promise<unknown> } }) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

test('a chat counts whole, the part before the meter was installed too, at 87 ₽ a dollar', async ($, on) => {
  const { clock, sim } = world(on)
  sim.usd = 40 // the meter installed in the middle of a chat that had cost $40
  await $.session.start({ cwd: 'C:\\work\\acme-sync', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'spend-meter', surface, component: 'AbovePrompt', props: BAND })
    const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts).toContain(`сессия 3${NBSP}480${NBSP}₽`)
    expect(texts).toContain(`· проект 3${NBSP}480${NBSP}₽ · сегодня 3${NBSP}480${NBSP}₽`)
    expect(await band.findAll({ type: 'Button' })).toEqual([])
    await band.unmount()
  }

  sim.usd = 42
  await turn($)
  const band = await $.ui.mount({ plugin: 'spend-meter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: `· проект 3${NBSP}654${NBSP}₽ · сегодня 3${NBSP}654${NBSP}₽` })).toBeDefined()
})

test('a resumed chat adds only what is new, a /clear starts afresh, and nothing counts twice', async ($, on) => {
  const kept = { [STORE_KEY]: { usd: 10, days: { '2026-10-10': 10 }, since: '2026-10-01', counted: { '0': 5 } } }
  const { clock, sim } = world(on, kept)
  sim.usd = 5
  await $.session.start({ cwd: 'C:\\work\\acme-sync', surface: 'terminal', isInteractive: true })
  await clock.settle()
  sim.usd = 7 // the resumed run: +2
  await turn($)
  sim.startedAt = 1_000 // a /clear that dropped the cost: a run of its own, +0.5 then +1
  sim.usd = 0.5
  await turn($)
  sim.usd = 1.5
  await turn($)
  sim.startedAt = 2_000 // a new start with the cost kept: the same run going on, +0.5
  sim.usd = 2
  await turn($)

  const pane = await $.ui.mount({ plugin: 'spend-meter', surface: 'desktop', component: 'Pane', requestId: 'spend-meter', props: PANE })
  expect(await pane.find({ type: 'Text', text: `1${NBSP}218${NBSP}₽` })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /всего с 01\.10 · \$14$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Курс: 87 ₽ за доллар/ })).toBeDefined()
})

test('the subscription windows stay in the pane, and warn once at 80 % and 95 %', async ($, on) => {
  const { clock, sim, toasts } = world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-sync', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const percent of [70, 85, 90, 96]) {
    sim.limits = [
      { kind: 'five_hour', percentUsed: percent, resetsAt: '2026-10-11T15:40:00.000Z' },
      { kind: 'seven_day', percentUsed: 38 },
    ]
    await turn($)
  }
  expect(toasts.filter(text => text.startsWith('Лимит «5 часов»'))).toEqual([
    expect.stringContaining('на 85%'),
    expect.stringContaining('на 96%'),
  ])
  // The block above the prompt leaves the windows out; the pane shows them.
  const band = await $.ui.mount({ plugin: 'spend-meter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /лимит|неделя/ })).toBeUndefined()
  const pane = await $.ui.mount({ plugin: 'spend-meter', surface: 'terminal', component: 'Pane', requestId: 'spend-meter', props: PANE })
  expect(await pane.find({ type: 'Text', text: 'ЛИМИТЫ ПОДПИСКИ' })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /^▰+▱* 96%$/ }))?.props.color).toBe('error')
})

test('the rate comes from the option, and a budget warns as it fills', { options: { rubPerUsd: 100 } }, async ($, on) => {
  const { clock, sim, toasts } = world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-sync', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'spend-meter', surface: 'desktop', component: 'Pane', requestId: 'spend-meter', props: PANE })
  await pane.input({ key: 'sm-budget', text: '1000', kind: 'submit' })
  sim.usd = 9
  await turn($)
  expect(toasts.some(text => text.startsWith('Бюджет проекта: потрачено 90%'))).toBe(true)
  expect(await pane.find({ type: 'Text', text: new RegExp(`^бюджет 1${NBSP}000${NBSP}₽ ▰+▱+ 90%$`) })).toBeDefined()
  await pane.input({ key: 'sm-budget', text: 'много', kind: 'submit' })
  expect(await pane.find({ type: 'Text', text: /Бюджет: число рублей/ })).toBeDefined()
})

test('the spend sits at the right of the first line, the server below, the suggestions last', async ($, on) => {
  const segment = (key: string, text: string) => ({ type: 'Box', props: { key }, children: [{ type: 'Text', props: {}, children: [text] }] })
  const line = (name: string, children: unknown[]) => ({ type: 'Box', props: { key: `line-${name}`, flexWrap: 'wrap', columnGap: 4 }, children })
  const shared = {
    type: 'Box',
    props: { key: 'status-band', flexDirection: 'column' },
    children: [
      { type: 'Box', props: {}, children: [] },
      line('next', [segment('seg-4-steps', '→ дальше')]),
      line('server', [segment('seg-2-server', '○ сервер')]),
      line('status', [segment('seg-1-cache', '⏱ кэш')]),
    ],
  }
  const { clock, sim } = world(on, {}, shared)
  sim.limits = [{ kind: 'five_hour', percentUsed: 13 }]
  await $.session.start({ cwd: 'C:\work\acme-sync', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'spend-meter', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  type Node = { props: { key?: string; justifyContent?: string; marginTop?: number }; children?: Node[] }
  const drawn = (await band.drawn()) as unknown as Node
  expect(drawn.children?.map(child => child.props.key)).toEqual([undefined, 'line-status', 'line-server', 'line-next'])
  expect(drawn.children?.[1]?.children?.map(child => child.props.key)).toEqual(['seg-1-cache', 'seg-3-spend'])
  // The cache on the left and the spend on the right; blank rows above the server and the suggestions.
  expect(drawn.children?.[1]?.props.justifyContent).toBe('space-between')
  expect(drawn.children?.[2]?.props.marginTop).toBe(1)
  expect(drawn.children?.[3]?.props.marginTop).toBe(1)
})

test('time on the project: Claude at work and short pauses count, a break does not', async ($, on) => {
  const MINUTE = 60_000
  const { clock } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  await $.session.start({ cwd: 'C:\\work\\acme-sync', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const say = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

  await say('Сделай форму заявки')
  await $.turn.start({ text: 'Сделай форму заявки', turnId: 't1' })
  await clock.advance(20 * MINUTE) // Claude works
  await turn($)
  await clock.advance(5 * MINUTE) // the person reads and thinks
  await say('Теперь кнопку звонка')
  await $.turn.start({ text: 'Теперь кнопку звонка', turnId: 't2' })
  await clock.advance(10 * MINUTE)
  await turn($)
  await clock.advance(60 * MINUTE) // lunch: not work
  await say('Ещё поправь отступы')

  const band = await $.ui.mount({ plugin: 'spend-meter', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: / · 🕐 35 мин$/ })).toBeDefined()
  const pane = await $.ui.mount({ plugin: 'spend-meter', surface: 'desktop', component: 'Pane', requestId: 'spend-meter', props: PANE })
  expect(await pane.find({ type: 'Text', text: '🕐 сегодня 35 мин · 7 дней 35 мин' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /· 🕐 35 мин$/ })).toBeDefined()
  const context = (await $.prompt.context({ blocks: [] })).blocks.find(block => block.name === 'projectTime')?.text ?? ''
  expect(context).toContain('today 35 мин, last 7 days 35 мин')
  // Nothing on the pane is bold.
  expect((await pane.findAll({ type: 'Text' })).filter(found => found.props.bold === true)).toEqual([])
})
