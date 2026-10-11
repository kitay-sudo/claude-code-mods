import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const RUN = 'mcp__server-panel__run'
const SAVE = 'mcp__server-panel__save_server'
const STORE_KEY = 'servers:c:/proj'
const KEY = 'C:\\Users\\me\\.ssh\\server_panel_ed25519'
const PROD = { name: 'prod', host: '1.2.3.4', user: 'root', port: 22, dir: '~/app', deploy: 'git pull && docker compose up -d --build' }

const PANE: RenderPropsOf['Pane'] = {
  title: 'Сервер-пульт',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}
const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const result = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// The engine beneath the plugin: a store, a question dialog that answers what
// the test sets, and a server that lets in the default key or the plugin's own
// once the connect window has put it there.
function world(on: On, kept: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 11, 9, 30) })
  mock.store(on, kept)
  const asked: string[] = []
  const ran: (readonly string[])[] = []
  const sim = { reply: 'Выполнить', defaultKey: true, pluginKey: false, keyExists: false, vitals: '' }
  const submitted: string[] = []
  const toasts: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.exists', () => ({ value: sim.keyExists }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__server-panel__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  // $.ui.ask asks through the AskUserQuestion tool's call.
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: sim.reply } } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } as never }))
  on('process.run', ($, e) => {
    const argv = e.argv
    ran.push(argv)
    if (argv[0] === 'ssh-keygen') {
      sim.keyExists = true
      return result(0, '')
    }
    // The connect window: the person typed the password there and the key went in.
    if (argv[0] === 'powershell') {
      sim.pluginKey = true
      return result(0, '')
    }
    const isIn = argv.includes('-i') ? sim.pluginKey : sim.defaultKey
    if (!isIn) return result(255, '', 'root@1.2.3.4: Permission denied (publickey,password).')
    // The read-only health check answers with what the test set.
    if (isVitals(argv)) return result(0, sim.vitals)
    return result(0, argv.at(-1) === 'true' ? '' : 'ok\n')
  })
  return { clock, asked, ran, sim, submitted, toasts }
}

const isVitals = (argv: readonly string[]) => String(argv.at(-1)).startsWith('sh -c ')

// The commands run on a server, the connection and health checks left out.
const commands = (ran: (readonly string[])[]) =>
  ran.filter(argv => argv[0] === 'ssh' && argv.at(-1) !== 'true' && !isVitals(argv)).map(argv => argv.at(-1))

test('a server is saved after «Сохранить», then the model runs commands on it after «Выполнить»', async ($, on) => {
  const { clock, asked, ran, sim } = world(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })

  sim.reply = 'Сохранить'
  const saved = await $.tool.call({ tool: SAVE, name: 'prod', host: '1.2.3.4', user: 'root', dir: '~/app', deploy: PROD.deploy })
  expect(saved.result).toContain('сохранён')
  expect(asked[0]).toContain('Сервер «prod»: root@1.2.3.4 · папка ~/app · деплой: git pull && docker compose up -d --build.')
  await clock.settle()

  const context = await $.prompt.context({ blocks: [] })
  const brief = context.blocks.find(block => block.name === 'projectServers')?.text ?? ''
  expect(brief).toContain('- prod: root@1.2.3.4, folder ~/app')
  expect(brief).toContain('go to the server on your own initiative')

  sim.reply = 'Выполнить'
  const answer = await $.tool.call({ tool: RUN, server: 'prod', command: 'docker compose ps', why: 'посмотреть контейнеры' })
  expect(answer.result).toBe('exit code: 0\n--- stdout ---\nok')
  expect(asked[1]).toBe('Сервер «prod» (root@1.2.3.4), папка ~/app. Зачем: посмотреть контейнеры. Команда: docker compose ps — выполнить?')
  expect(commands(ran)).toEqual(["cd ~/'app' && docker compose ps"])
})

test('«Отмена» runs nothing and tells the model so', async ($, on) => {
  const { ran, sim } = world(on, { [STORE_KEY]: [PROD] })
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  sim.reply = 'Отмена'
  const answer = await $.tool.call({ tool: RUN, server: 'prod', command: 'rm -rf /var/www/old', why: 'убрать старую версию' })
  expect(answer.result).toBe('Команда не выполнена: пользователь нажал «Отмена».')
  expect(commands(ran)).toEqual([])
})

test('an unknown server or a bad address is refused before anything is asked', async ($, on) => {
  const { asked } = world(on, { [STORE_KEY]: [PROD] })
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  expect((await $.tool.call({ tool: RUN, server: 'stage', command: 'ls', why: 'x' })).deny).toContain('Сохранены: prod')
  expect((await $.tool.call({ tool: SAVE, name: 'evil', host: '-oProxyCommand=calc', user: 'root' })).deny).toContain('host')
  expect(asked).toEqual([])
})

test('the row above the prompt shows the server and deploys on a second press', async ($, on) => {
  const { clock, ran } = world(on, { [STORE_KEY]: { servers: [PROD], settings: { confirm: 'every', band: true } } })
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'server-panel', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.findAll({ type: 'Text' })).map(found => found.text)).toEqual(
      expect.arrayContaining(['●', 'prod', expect.stringMatching(/^на связи · \d+ мс$/)]),
    )
    expect((await band.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Деплой', 'Пульт'])
    await band.unmount()
  }
  const band = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'sp-band-deploy' })
  expect(commands(ran)).toEqual([])
  await band.press({ key: 'sp-band-yes' })
  expect(commands(ran)).toEqual(["cd ~/'app' && git pull && docker compose up -d --build"])
  expect(await band.find({ type: 'Text', text: /деплой \d\d:\d\d ✓/ })).toBeDefined()
})

test('a project without a server offers to connect one', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'server-panel', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: '○ сервер не подключён' })).toBeDefined()
  expect((await band.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Подключить'])
})

test('the form connects a new server by itself: own key, a password window, then green', async ($, on) => {
  const { clock, ran, sim } = world(on)
  sim.defaultKey = false
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'Pane', requestId: 'server-panel', props: PANE })
  await pane.input({ key: 'sp-address', text: 'root@1.2.3.4', kind: 'change' })
  await pane.input({ key: 'sp-dir', text: '~/app', kind: 'change' })
  await pane.input({ key: 'sp-deploy', text: PROD.deploy, kind: 'change' })
  await pane.press({ key: 'sp-save' })

  expect(ran.some(argv => argv[0] === 'ssh-keygen' && argv.includes(KEY))).toBe(true)
  const window = ran.find(argv => argv[0] === 'powershell')
  expect(window?.join(' ')).toContain('-EncodedCommand')
  expect(await pane.find({ type: 'Text', text: /Введи там пароль сервера один раз/ })).toBeDefined()

  await clock.advance(4_000)
  expect(await pane.find({ type: 'Text', text: '✓ prod подключён: root@1.2.3.4' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^на связи/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /ключ пульта/ })).toBeDefined()
})

test('set to deploy after a push, a git push deploys by itself', async ($, on) => {
  const { clock, ran } = world(on, { [STORE_KEY]: { servers: [PROD], settings: { confirm: 'every', band: true } } })
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'server-panel', surface: 'terminal', component: 'Pane', requestId: 'server-panel', props: PANE })

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await clock.settle()
  expect(commands(ran)).toEqual([])

  await pane.press({ key: 'mode-prod' })
  expect(await pane.find({ type: 'Button', text: 'Деплой: сам после пуша' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "fix" && git push' })
  await clock.settle()
  expect(commands(ran)).toEqual(["cd ~/'app' && git pull && docker compose up -d --build"])
  expect(await pane.find({ type: 'Text', text: /· авто$/ })).toBeDefined()
})

test('asking only for risky commands runs the safe ones straight away', async ($, on) => {
  const { asked, ran, sim } = world(on, { [STORE_KEY]: { servers: [PROD], settings: { confirm: 'risky', band: true } } })
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: RUN, server: 'prod', command: 'docker compose ps', why: 'посмотреть' })
  expect(asked).toEqual([])
  sim.reply = 'Отмена'
  await $.tool.call({ tool: RUN, server: 'prod', command: 'docker system prune -af', why: 'почистить' })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('⚠ удаляет контейнеры, образы или тома Docker')
  expect(commands(ran)).toEqual(["cd ~/'app' && docker compose ps"])
})

test('the pane forgets a server only on a second press', async ($, on) => {
  const { clock } = world(on, { [STORE_KEY]: [PROD] })
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'Pane', requestId: 'server-panel', props: PANE })
  await pane.press({ key: 'forget-prod' })
  expect(await pane.find({ type: 'Text', text: /Убрать prod из пульта/ })).toBeDefined()
  await pane.press({ key: 'yes-forget-prod' })
  expect(await pane.find({ type: 'Text', text: /^Пока нет/ })).toBeDefined()
})

test('with no server yet the form is open, each label above its field', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'Pane', requestId: 'server-panel', props: PANE })
  const shown = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  for (const one of ['СЕРВЕР ПРОЕКТА', 'Адрес для ssh', 'Папка проекта на сервере', 'Команда деплоя', 'можно оставить пустым']) expect(shown).toContain(one)
  expect(shown.indexOf('Адрес для ssh')).toBeLessThan(shown.indexOf('Папка проекта на сервере'))
  expect((await pane.find({ type: 'Input', key: 'sp-address' }))?.props.label).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'sp-cancel' })).toBeUndefined()
})

test('a kept server is a card, the form folds behind one button, the journal takes two lines a command', async ($, on) => {
  const { clock } = world(on, { [STORE_KEY]: { servers: [PROD], settings: { confirm: 'risky', band: true } } })
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: RUN, server: 'prod', command: 'docker compose ps', why: 'посмотреть' })
  const pane = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'Pane', requestId: 'server-panel', props: PANE })
  const texts = async () => (await pane.findAll({ type: 'Text' })).map(found => found.text)

  const shown = await texts()
  for (const one of ['prod', 'ДЕПЛОЙ', PROD.deploy, 'вручную', 'НАСТРОЙКИ', 'Подтверждать команды Claude', 'Строка над полем ввода', 'ЖУРНАЛ', 'docker compose ps']) {
    expect(shown).toContain(one)
  }
  expect(shown.some(text => /^на связи/.test(text))).toBe(true)
  expect(shown.some(text => /^✓ \d\d:\d\d prod · exit 0 · Claude$/.test(text))).toBe(true)
  expect((await pane.find({ type: 'Button', key: 'sp-confirm' }))?.text).toBe('только опасные')
  expect((await pane.find({ type: 'Button', key: 'sp-band' }))?.text).toBe('видна')
  expect((await pane.find({ type: 'Button', key: 'deploy-prod' }))?.props.variant).toBe('primary')
  expect(await pane.find({ type: 'Input', key: 'sp-address' })).toBeUndefined()

  await pane.press({ key: 'sp-add' })
  expect(await pane.find({ type: 'Input', key: 'sp-address' })).toBeDefined()
  expect(await texts()).toContain('НОВЫЙ СЕРВЕР')
  await pane.press({ key: 'sp-cancel' })
  expect(await pane.find({ type: 'Input', key: 'sp-address' })).toBeUndefined()

  // Nothing on the pane is bold.
  expect((await pane.findAll({ type: 'Text' })).filter(found => found.props.bold === true)).toEqual([])
})

test('nothing sticks together: a blank row under headings and labels, settings one row apart', async ($, on) => {
  world(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'Pane', requestId: 'server-panel', props: PANE })
  type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const textOf = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as Node)?.children ?? []).map(textOf).join('')
  // The Box that holds a Text with this text among its own children.
  const boxAround = (node: unknown, text: string): Node | undefined => {
    const box = node as Node
    if (typeof node !== 'object' || node === null) return undefined
    if (box.type === 'Box' && (box.children ?? []).some(child => (child as Node)?.type === 'Text' && textOf(child) === text)) return box
    for (const child of box.children ?? []) {
      const found = boxAround(child, text)
      if (found !== undefined) return found
    }
    return undefined
  }
  const tree = await pane.drawn()
  expect(boxAround(tree, 'СЕРВЕР ПРОЕКТА')?.props?.marginBottom).toBe(1)
  expect(boxAround(tree, 'НАСТРОЙКИ')?.props?.marginBottom).toBe(1)
  expect(boxAround(tree, 'Строка над полем ввода')?.props?.marginTop).toBe(1)
  // The field sits a row under its label; the next label two rows under the hint.
  expect(boxAround(tree, 'пользователь@адрес, порт через двоеточие: root@1.2.3.4:2222')?.props?.marginTop).toBe(1)
  expect(boxAround(tree, 'Папка проекта на сервере')?.props?.marginTop).toBe(2)
})

test('the card shows the server\'s health, the band its worst problem, and the errors go to Claude in one press', async ($, on) => {
  const { clock, ran, sim, submitted, toasts } = world(on, { [STORE_KEY]: { servers: [PROD], settings: { confirm: 'every', band: true } } })
  sim.vitals = 'load=0.5\ncpus=2\nmem=1229/3891\ndisk=41/12000\nkind=compose\nsvc=web|running|\nsvc=worker|running|\nerr=ERROR connection refused to db:5432\n'
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'Pane', requestId: 'server-panel', props: PANE })
  let shown = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  for (const one of ['СОСТОЯНИЕ · Docker Compose', 'процессор 25% · память 1,2 ГБ из 3,8 ГБ', 'web', 'работает', 'ОШИБКИ В ЛОГАХ · 1', 'ERROR connection refused to db:5432']) {
    expect(shown).toContain(one)
  }

  // A service that stops between checks: a toast once, red in the card and in the band.
  sim.vitals = sim.vitals.replace('svc=worker|running|', 'svc=worker|exited|')
  await pane.press({ key: 'refresh-prod' })
  expect(toasts).toContain('prod: worker: остановлен')
  shown = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(shown).toContain('⚠ worker: остановлен')
  const band = await $.ui.mount({ plugin: 'server-panel', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: '⚠ worker: остановлен' })).toBeDefined()

  // The logs land in the journal; the errors reach Claude as the person's request.
  await pane.press({ key: 'logs-prod' })
  expect(commands(ran)).toContain("cd ~/'app' && docker compose logs --tail 60 --no-color 2>&1")
  await pane.press({ key: 'analyze-prod' })
  expect(submitted[0]).toContain('Разбери ошибки на сервере prod')
  expect(submitted[0]).toContain('ERROR connection refused to db:5432')
})
