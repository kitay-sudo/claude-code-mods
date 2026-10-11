import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const STORE_KEY = 'report:c:/work/acme-crm'
const NOW = new Date(2026, 9, 11, 20, 0).getTime()
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const PANE: RenderPropsOf['Pane'] = {
  title: 'Отчёт клиенту',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
}

const FORKED = 'Вот отчёт:\n\n🪴 Форма «Заявка» снова работает — письма доходят.\n\nЧто готово:\n— Починил отправку писем\n— Проверил форму на телефоне'

// The engine beneath the plugin: a conversation to fork (or none yet), a git
// log, a clipboard that takes the text or not, and records of each call.
function world(on: On, kept: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, kept)
  const sim = { hasTurns: true, commits: '2026-10-10 fix: form mail', isCopied: true, completed: '🪴 Short.' }
  const forks: string[] = []
  const completes: string[] = []
  const copied: string[] = []
  const ran: (readonly string[])[] = []
  const opened: string[] = []
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('session.cwd', () => ({ value: 'C:\\work\\acme-crm' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('env.get', ($, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    if (!sim.hasTurns) return { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
    return { value: { isAnswered: true as const, text: FORKED, usage: USAGE } }
  })
  on('model.complete', ($, e) => {
    completes.push(typeof e.prompt === 'string' ? e.prompt : '')
    return { value: { isAnswered: true as const, text: sim.completed, usage: USAGE } }
  })
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: sim.isCopied ? { isCopied: true as const } : { isCopied: false as const, reason: 'no-clipboard' as const } }
  })
  on('process.run', ($, e) => {
    ran.push(e.argv)
    const stdout = e.argv[0] === 'git' ? sim.commits : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as never }
  })
  return { clock, sim, forks, completes, copied, ran, opened, toasts }
}

const report = ($: { command: { run: (input: { command: string; args: string; origin: { kind: 'composer' }; presentation: { isFullscreen: boolean; columns: number } }) => Promise<{ text?: string }> } }, args: string) =>
  $.command.run({ command: 'report', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('/report writes from the conversation and the commits, cleans it up, and copies in one press', async ($, on) => {
  const { forks, copied, ran, opened, toasts } = world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })

  const answer = await report($, 'en без цифр')
  const text = '🪴 Форма "Заявка" снова работает - письма доходят.\n\nЧто готово:\n\n1. Починил отправку писем\n\n2. Проверил форму на телефоне'
  expect(answer.text).toBe(text)
  expect(opened).toEqual(['client-report'])
  expect(forks[0]).toContain('за последние 7 дней')
  expect(forks[0]).toContain('Коммиты за этот период:\n2026-10-10 fix: form mail')
  expect(forks[0]).toContain('Пиши по-английски.')
  expect(forks[0]).toContain('Пожелание к отчёту: без цифр')
  expect(ran[0]?.slice(0, 3)).toEqual(['git', 'log', `--since=${new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString()}`])

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'client-report', surface, component: 'Pane', requestId: 'client-report', props: PANE })
    expect(await pane.find({ type: 'Text', text })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'за последние 7 дней · написан 11.10 в 20:00' })).toBeDefined()
    expect((await pane.find({ type: 'Button', key: 'cr-copy' }))?.props.label).toBe('Скопировать')
    await pane.press({ key: 'cr-copy' })
    await pane.unmount()
  }
  expect(copied).toEqual([text, text])
  expect(toasts).toEqual(['Отчёт скопирован', 'Отчёт скопирован'])
  // The surface took it: PowerShell was not needed.
  expect(ran.filter(argv => argv[0] === 'powershell')).toEqual([])
})

test('where the surface cannot copy, PowerShell puts the text on the Windows clipboard', async ($, on) => {
  const { sim, ran, toasts } = world(on)
  sim.isCopied = false
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  await report($, '')
  const pane = await $.ui.mount({ plugin: 'client-report', surface: 'desktop', component: 'Pane', requestId: 'client-report', props: PANE })
  await pane.press({ key: 'cr-copy' })
  const shell = ran.find(argv => argv[0] === 'powershell')
  expect(shell?.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(shell?.[4]).toMatch(/^Set-Clipboard -Value \(\[Text\.Encoding\]::Unicode\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/]+=*'\)\)\)$/)
  expect(toasts).toEqual(['Отчёт скопирован'])
})

test('a fresh chat reports from the commits alone, and says so when there is nothing', async ($, on) => {
  const { sim, completes } = world(on)
  sim.hasTurns = false
  sim.completed = '🪴 За неделю починили почту.'
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  expect((await report($, '')).text).toBe('🪴 За неделю починили почту.')
  expect(completes[0]).toContain('2026-10-10 fix: form mail')

  sim.commits = ''
  const answer = await report($, '')
  expect(answer.text).toMatch(/^Пока не о чем писать/)
  const pane = await $.ui.mount({ plugin: 'client-report', surface: 'desktop', component: 'Pane', requestId: 'client-report', props: PANE })
  expect(await pane.find({ type: 'Text', text: /^Пока не о чем писать/ })).toBeDefined()
  // The last good report stays in the pane.
  expect(await pane.find({ type: 'Text', text: '🪴 За неделю починили почту.' })).toBeDefined()
})

test('the next report starts where the last one ended; «Заново» keeps its period, «Короче» rewrites it', async ($, on) => {
  const last = new Date(2026, 9, 9, 18, 30).getTime()
  const kept = { [STORE_KEY]: { text: '🪴 Старый отчёт.', at: last, since: last - 1000, period: 'за последние 7 дней', isEnglish: false } }
  const { forks, completes, ran } = world(on, kept)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ plugin: 'client-report', surface: 'desktop', component: 'Pane', requestId: 'client-report', props: PANE })
  expect(await pane.find({ type: 'Text', text: '🪴 Старый отчёт.' })).toBeDefined()

  await report($, '')
  expect(forks[0]).toContain('с прошлого отчёта (09.10)')
  expect(ran[0]?.[2]).toBe(`--since=${new Date(last).toISOString()}`)

  await pane.press({ key: 'cr-again' })
  expect(forks[1]).toContain('с прошлого отчёта (09.10)')
  expect(ran.filter(argv => argv[0] === 'git')[1]?.[2]).toBe(`--since=${new Date(last).toISOString()}`)

  await pane.press({ key: 'cr-shorter' })
  expect(completes[0]).toMatch(/^Не продолжай работу\. Сократи/)
  expect(await pane.find({ type: 'Text', text: '🪴 Short.' })).toBeDefined()
  // English now: the language button turns back to Russian.
  expect((await pane.find({ type: 'Button', key: 'cr-language' }))?.props.label).toBe('По-русски')
})

test('the same rules reach the model for any client message in the chat', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:\\work\\acme-crm', surface: 'desktop', isInteractive: true })
  const blocks = (await $.prompt.context({ blocks: [] })).blocks
  const rules = blocks.find(block => block.name === 'clientWriting')?.text ?? ''
  expect(rules).toContain('```text')
  expect(rules).toContain('Никаких длинных тире')
  expect(rules).toContain('начинается с 🪴')
})
