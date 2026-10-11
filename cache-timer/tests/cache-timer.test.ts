import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const MINUTE = 60_000

const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

// The engine beneath the plugin: a clock, the context figures, a model that
// answers every step, and records of the toasts and commands it was handed.
function world(on: On, beneath: unknown = { type: 'Box' }) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const toasts: string[] = []
  const commands: string[] = []
  let tokens: number | undefined

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 200_000 }, rateLimits: [] } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, () => beneath as never)
  on('command.run', ($, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('session.compact', () => {
    tokens = undefined
    return { messages: [SUMMARY] }
  })
  on('turn.step', async function* ($, e) {
    tokens = 85_000
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 84_990,
        cache_creation_input_tokens: 0,
        model: e.model,
      },
    }
  })

  return { clock, toasts, commands }
}

test('counts down and warns once, five minutes before the cache cools', async ($, on) => {
  const { clock, toasts } = world(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ type: 'Text', text: /кэш/ }))?.text).toContain('кэш: — · контекст: —')
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
    await ui.unmount()
  }

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const chunk of stream) void chunk
  await stream.result

  const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ type: 'Text', text: /кэш/ }))?.text).toContain('кэш: 60 мин · контекст: 85k из 200k (43%)')
  expect(await ui.find({ key: 'compact' })).toBeDefined()

  await clock.advance(54 * MINUTE)
  expect(toasts).toHaveLength(0)
  await clock.advance(MINUTE)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('через 5 мин')
  expect((await ui.find({ type: 'Text', text: /кэш/ }))?.text).toContain('кэш: 5 мин')

  await clock.advance(5 * MINUTE)
  expect((await ui.find({ type: 'Text', text: /кэш/ }))?.text).toContain('кэш остыл')
  expect(toasts).toHaveLength(1)
})

test('«Сжать» runs /compact, and a compaction empties the gauge', async ($, on) => {
  const { commands } = world(on)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const chunk of stream) void chunk
  await stream.result

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface, component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'compact' })
    await ui.unmount()
  }
  expect(commands).toEqual(['compact', 'compact'])

  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ type: 'Text', text: /кэш/ }))?.text).toContain('кэш: — · контекст: —')
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
})

test('with a 5-minute cache it warns one minute before', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const { clock, toasts } = world(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const chunk of stream) void chunk
  await stream.result

  const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ type: 'Text', text: /кэш/ }))?.text).toContain('кэш: 5 мин')
  await clock.advance(3 * MINUTE)
  expect(toasts).toHaveLength(0)
  await clock.advance(MINUTE)
  expect(toasts).toEqual([expect.stringContaining('через 1 мин')])
})

// What another plugin of the shared block has drawn beneath: its server line.
const SHARED = {
  type: 'Box',
  props: { key: 'status-band', flexDirection: 'column' },
  children: [
    { type: 'Box', props: {}, children: [] },
    {
      type: 'Box',
      props: { key: 'line-server', flexWrap: 'wrap', columnGap: 4 },
      children: [{ type: 'Box', props: { key: 'seg-2-server' }, children: [{ type: 'Text', props: {}, children: ['○ сервер'] }] }],
    },
  ],
}

test('the gauge joins the shared block on the first line, above the server', async ($, on) => {
  world(on, SHARED)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  type Node = { props: { key?: string }; children?: Node[] }
  const drawn = (await ui.drawn()) as unknown as Node
  expect(drawn.props.key).toBe('status-band')
  expect(drawn.children?.map(child => child.props.key)).toEqual([undefined, 'line-status', 'line-server'])
  expect(drawn.children?.[1]?.children?.map(child => child.props.key)).toEqual(['seg-1-cache'])
  expect(await ui.find({ type: 'Text', text: /^⏱ кэш: — · контекст: —$/ })).toBeDefined()
})
