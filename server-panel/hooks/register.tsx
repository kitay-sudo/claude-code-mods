// server-panel: the project's servers in one place, always in view, and
// commands on them run by the model itself instead of «дай команды, я вобью и
// пришлю вывод».
//
// The shared row above the prompt shows the server, whether it answers and
// the last deploy, with «Деплой» and «Пульт». The /server pane adds a server from a
// form and connects it by itself: it makes a key of its own, opens a window
// where ssh asks the server's password once (hidden; neither the plugin nor
// the model ever sees it) and turns green once the key gets in. A deploy runs
// on a press (pressed twice) or, switched on, after every successful git push.
//
// The model calls `run`; the person confirms its commands in the engine's
// question dialog ($.ui.ask, whatever the permission mode), every command or,
// switched in the pane, only the risky ones. `save_server` saves a server the
// same way and starts the connect assistant. No password is asked or kept.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Draft, Health, PanelSettings, Run, Server, Vitals } from '../types'
import {
  address,
  checkServer,
  connectHint,
  connectScript,
  dangers,
  encodePowerShell,
  formatOutput,
  isPush,
  keygenArgs,
  parseAddress,
  probeArgs,
  sshArgs,
  tailOf,
} from './ssh'
import { joinRow } from './status-row'
import { alerts, isUp, logSources, logsCommand, machineLines, parseVitals, runtimeName, shownServices, stateWord, vitalsArgs } from './vitals'

const PANE = 'server-panel'
const PANE_TITLE = 'Сервер-пульт'
const RUN_TOOL = 'mcp__server-panel__run'
const SAVE_TOOL = 'mcp__server-panel__save_server'
const MAX_RUNS = 20
const SHOWN_RUNS = 5
const DEFAULT_TIMEOUT_SEC = 120
const DEPLOY_TIMEOUT_SEC = 600
const COMMAND_SHOWN = 800
const NOTE_LIMIT = 3_000
const HEALTH_MS = 5 * 60_000
const SETUP_POLL_MS = 4_000
const SETUP_POLL_TRIES = 45
const KEY_NAME = 'server_panel_ed25519'
const CHECK_COMMAND = 'echo "связь есть: $(hostname)" && uptime'
const LOG_LINES_SHOWN = 60
const ERRORS_SHOWN = 3

const DEFAULT_SETTINGS: PanelSettings = { confirm: 'every', band: true }
const EMPTY_DRAFT: Draft = { address: '', dir: '', deploy: '', error: '' }

const servers = atom({ plugin: 'server-panel', key: 'servers' } as const, [])
const settings = atom({ plugin: 'server-panel', key: 'settings' } as const, DEFAULT_SETTINGS)
const runs = atom({ plugin: 'server-panel', key: 'runs' } as const, [])
const health = atom({ plugin: 'server-panel', key: 'health' } as const, {})
const setup = atom({ plugin: 'server-panel', key: 'setup' } as const, null)
const draft = atom({ plugin: 'server-panel', key: 'draft' } as const, EMPTY_DRAFT)
const confirming = atom({ plugin: 'server-panel', key: 'confirming' } as const, null)
const adding = atom({ plugin: 'server-panel', key: 'adding' } as const, false)

// The connect assistant's poll; a reload drops it, and «Подключить» starts it again.
let setupTimer: Timer | undefined

const RUN_DESCRIPTION =
  "Runs a shell command on one of this project's servers over SSH and returns its exit code and output. " +
  'The user confirms commands in a dialog before they run (every one, or only risky ones, as they set it). ' +
  'Use it instead of asking the user to type commands on the server and paste the output back. One ' +
  "purpose per call; say why in `why`, in the user's language. The project's servers are listed in the context."

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    server: { type: 'string', description: 'The saved server name, e.g. prod.' },
    command: { type: 'string', description: 'The shell command, run in the server folder when one is saved.' },
    why: { type: 'string', description: 'What it is for, one short line in the user’s language: shown in the confirm dialog.' },
    timeoutSec: { type: 'number', description: 'How long it may run, 5 to 600 seconds; 120 when left out.' },
  },
  required: ['server', 'command', 'why'],
}

const SAVE_DESCRIPTION =
  'Saves a server for this project and connects it: its name, address, user, port, the folder the project ' +
  'lives in there and the command line that deploys it. After the user confirms, the plugin makes an SSH key ' +
  'and opens a window where the server asks its password once, which neither you nor the plugin see. Never ' +
  'ask for, pass or store a password yourself. Saving a name again replaces it.'

const SAVE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name: prod, stage.' },
    host: { type: 'string', description: 'Hostname or IP address.' },
    user: { type: 'string', description: 'User on the server, e.g. root.' },
    port: { type: 'number', description: 'SSH port; 22 when left out.' },
    dir: { type: 'string', description: 'Folder on the server the project lives in, e.g. ~/app.' },
    deploy: { type: 'string', description: 'One command line that deploys the project, steps joined with &&.' },
    deployMode: { type: 'string', enum: ['manual', 'after-push'], description: 'after-push: deploy after every git push.' },
  },
  required: ['name', 'host', 'user'],
}

function briefing(list: readonly Server[], mode: PanelSettings): string {
  const saving =
    `When the user gives a server that is not listed (user@host), save it with ${SAVE_TOOL}: it connects itself. ` +
    'Logins are by SSH key only: never ask for or store a password.'
  if (list.length === 0) {
    return (
      'No servers are saved for this project yet (server-panel). Once one is, you run commands on it yourself ' +
      `with ${RUN_TOOL} instead of asking the user to type them and paste the output. ${saving}`
    )
  }
  const rules =
    `You are connected to these servers: run shell commands on them yourself with ${RUN_TOOL} and read the output. ` +
    'Whenever a request touches the live project (the site is down, an error on the server, logs, what is deployed, ' +
    'data in the database, disk, services, containers), go to the server on your own initiative and check, ' +
    'instead of guessing or asking the user to run commands and paste the output. ' +
    'Logs by what runs the project: docker compose logs --tail 200 (Docker Compose, in the project folder), ' +
    'docker logs --tail 200 <container> (Docker), pm2 logs --nostream --lines 200 (pm2), journalctl -u <service> -n 200 (systemd), ' +
    "and the framework's own files in the project folder (storage/logs for Laravel, var/log for Symfony, wp-content/debug.log for WordPress, logs/), " +
    '/var/log/nginx/error.log for a site behind nginx. ' +
    `${mode.confirm === 'every' ? 'The user confirms each command with a button.' : 'Safe commands run at once; the user confirms only risky ones (deleting, restarts, database changes, firewall).'} ` +
    saving
  const lines = list.map(
    server =>
      `- ${server.name}: ${address(server)}${server.dir === undefined ? '' : `, folder ${server.dir}`}` +
      `${server.deploy === undefined ? '' : `, deploy: ${server.deploy}`}` +
      `${server.deployMode === 'after-push' ? ' (deploys by itself after every git push: do not deploy again)' : ''}`,
  )
  return `Servers saved for this project (server-panel):\n${lines.join('\n')}\n${rules}`
}

function clock(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function short(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function nextName(list: readonly Server[]): string {
  if (!list.some(one => one.name === 'prod')) return 'prod'
  let n = 2
  while (list.some(one => one.name === `server${n}`)) n++
  return `server${n}`
}

async function storeKey($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  return `servers:${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

async function loadProject($: EngineInterface): Promise<void> {
  const kept = await $.store.get(await storeKey($))
  // Kept as a bare list before settings came, as { servers, settings } since.
  const raw = Array.isArray(kept) ? { servers: kept } : ((kept ?? {}) as { servers?: unknown; settings?: Partial<PanelSettings> })
  const list = Array.isArray(raw.servers)
    ? raw.servers.flatMap(one => {
        const checked = checkServer(one)
        return 'server' in checked ? [checked.server] : []
      })
    : []
  const mode: PanelSettings = {
    confirm: raw.settings?.confirm === 'risky' ? 'risky' : 'every',
    band: raw.settings?.band !== false,
  }
  await update($, servers, () => list)
  await update($, settings, () => mode)
}

async function keepProject($: EngineInterface, list: Server[], mode: PanelSettings): Promise<void> {
  await $.store.set(await storeKey($), { servers: list, settings: mode })
  await update($, servers, () => list)
  await update($, settings, () => mode)
}

async function keepServers($: EngineInterface, list: Server[]): Promise<void> {
  await keepProject($, list, await read($, settings))
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// So the model knows what happened on the servers without anyone pasting it.
// A build without $.session.append (2.1.284) leaves the row and the pane to say it.
async function tell($: EngineInterface, text: string): Promise<void> {
  const note = text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}\n…` : text
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[server-panel] ${note}` }] } })
  } catch {
    // Nothing to do: the run is in the panel.
  }
}

// The person's own answer, through the engine's question dialog: a button
// press, never the permission mode's decision. Everything to be confirmed is in
// the question itself, since the dialog shows nothing else.
async function confirm($: EngineInterface, question: string, yes: string): Promise<{ isYes: boolean; note: string }> {
  try {
    const picked = await $.ui.ask(question, { options: [yes, 'Отмена'], header: 'Сервер' })
    if (picked === yes) return { isYes: true, note: '' }
    if (picked === 'Отмена') return { isYes: false, note: 'пользователь нажал «Отмена»' }
    return { isYes: false, note: `пользователь ответил: ${picked}` }
  } catch (error) {
    return { isYes: false, note: `пользователь не ответил (${String(error)})` }
  }
}

async function addRun($: EngineInterface, run: Omit<Run, 'id'>): Promise<number> {
  let id = 1
  await update($, runs, list => {
    id = (list.at(-1)?.id ?? 0) + 1
    return [...list, { ...run, id }].slice(-MAX_RUNS)
  })
  return id
}

async function patchRun($: EngineInterface, id: number, change: Partial<Run>): Promise<void> {
  await update($, runs, list => list.map(run => (run.id === id ? { ...run, ...change } : run)))
}

async function setHealth($: EngineInterface, name: string, value: Health): Promise<void> {
  await update($, health, all => ({ ...all, [name]: value }))
}

async function execute($: EngineInterface, server: Server, command: string, by: Run['by'], timeoutSec: number): Promise<string> {
  const at = await $.clock.now()
  const id = await addRun($, { server: server.name, command, by, at, status: 'running', exitCode: null, tail: '' })
  try {
    const ran = await $.process.run(sshArgs(server, command), { timeoutMs: timeoutSec * 1000 })
    const hint = ran.exitCode === 255 ? connectHint(server, ran.stderr) : undefined
    await patchRun($, id, {
      status: ran.exitCode === 0 ? 'done' : 'failed',
      exitCode: ran.exitCode,
      tail: hint ?? tailOf(`${ran.stdout}\n${ran.stderr}`),
    })
    const now = await $.clock.now()
    // A command says whether ssh got in; what the last check read stays.
    const before = (await read($, health))[server.name]
    const kept = before?.vitals === undefined ? {} : { vitals: before.vitals }
    if (ran.exitCode !== 255) await setHealth($, server.name, { state: 'ok', at: now, ms: before?.ms ?? null, note: '', ...kept })
    else await setHealth($, server.name, { state: 'fail', at: now, ms: null, note: hint ?? tailOf(ran.stderr, 2), ...kept })
    const output = formatOutput(ran.exitCode, ran.stdout, ran.stderr)
    return hint === undefined ? output : `${output}\n\n${hint}`
  } catch (error) {
    await patchRun($, id, { status: 'failed', tail: String(error) })
    return `Команда не завершилась: ${String(error)}`
  }
}

async function probe($: EngineInterface, server: Server): Promise<{ isOk: boolean; ms: number; note: string }> {
  const started = await $.clock.now()
  try {
    const ran = await $.process.run(probeArgs(server), { timeoutMs: 15_000 })
    const ms = (await $.clock.now()) - started
    if (ran.exitCode === 0) return { isOk: true, ms, note: '' }
    return { isOk: false, ms, note: connectHint(server, ran.stderr) ?? (tailOf(ran.stderr, 2) || `ssh вернул ${ran.exitCode}`) }
  } catch (error) {
    return { isOk: false, ms: (await $.clock.now()) - started, note: String(error) }
  }
}

async function checkHealth($: EngineInterface, server: Server): Promise<void> {
  const before = (await read($, health))[server.name]
  const kept = before?.vitals === undefined ? {} : { vitals: before.vitals }
  await setHealth($, server.name, { state: 'checking', at: before?.at ?? null, ms: before?.ms ?? null, note: '', ...kept })
  const result = await probe($, server)
  const at = await $.clock.now()
  if (!result.isOk) {
    await setHealth($, server.name, { state: 'fail', at, ms: result.ms, note: result.note, ...kept })
    return
  }
  const vitals = await readVitals($, server)
  await setHealth($, server.name, { state: 'ok', at, ms: result.ms, note: '', ...(vitals === null ? kept : { vitals }) })
  // A problem new since the last check reaches the person once.
  if (vitals !== null && before?.vitals !== undefined) {
    const known = new Set(alerts(before.vitals))
    for (const alert of alerts(vitals)) if (!known.has(alert)) $.ui.toast(`${server.name}: ${alert}`)
  }
}

/** The machine, the services and the log errors, in one read-only call; null when it did not get through. */
async function readVitals($: EngineInterface, server: Server): Promise<Vitals | null> {
  try {
    const ran = await $.process.run(vitalsArgs(server), { timeoutMs: 30_000 })
    return ran.exitCode === 0 ? parseVitals(ran.stdout) : null
  } catch {
    return null
  }
}

async function personRefresh($: EngineInterface, name: string): Promise<void> {
  const server = (await read($, servers)).find(one => one.name === name)
  if (server !== undefined) await checkHealth($, server)
}

/** The project's recent logs, run as the person's command so they land in the journal and reach the model. */
async function personLogs($: EngineInterface, name: string): Promise<void> {
  const server = (await read($, servers)).find(one => one.name === name)
  if (server === undefined) return
  const vitals = (await read($, health))[name]?.vitals
  const units = vitals?.runtime === 'systemd' ? vitals.services.map(service => service.name) : []
  const output = await execute($, server, logsCommand(vitals?.runtime ?? 'none', LOG_LINES_SHOWN, units), 'person', 60)
  await tell($, `Пользователь открыл логи ${server.name}.\n${output}`)
}

/** The errors handed to Claude as the person's own request. */
async function analyzeErrors($: EngineInterface, name: string): Promise<void> {
  const vitals = (await read($, health))[name]?.vitals
  if (vitals === undefined) return
  const text =
    `Разбери ошибки на сервере ${name}. Зайди на сервер сам, посмотри логи (${runtimeName(vitals.runtime)}) и скажи, ` +
    `что сломалось и как починить. Последние строки с ошибками:\n${vitals.errors.join('\n')}`
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (error) {
    $.ui.toast(`Не удалось передать Claude: ${String(error)}`)
  }
}

async function checkAll($: EngineInterface): Promise<void> {
  for (const server of await read($, servers)) await checkHealth($, server)
}

async function deployNow($: EngineInterface, server: Server, by: Run['by']): Promise<void> {
  if (server.deploy === undefined) return
  await update($, confirming, () => null)
  const output = await execute($, server, server.deploy, by, DEPLOY_TIMEOUT_SEC)
  const last = (await read($, runs)).at(-1)
  const isOk = last?.status === 'done'
  $.ui.toast(`${server.name}: ${isOk ? 'деплой прошёл' : 'деплой упал, подробности в пульте'}`)
  const who = by === 'auto' ? 'Автодеплой после git push' : 'Пользователь нажал «Деплой»'
  await tell($, `${who} на ${server.name} (${address(server)}).\n${output}`)
}

async function personCheck($: EngineInterface, name: string): Promise<void> {
  const server = (await read($, servers)).find(one => one.name === name)
  if (server === undefined) return
  const output = await execute($, server, CHECK_COMMAND, 'person', 30)
  const last = (await read($, runs)).at(-1)
  $.ui.toast(`${server.name}: ${last?.status === 'done' ? 'связь есть' : 'нет связи, подробности в пульте'}`)
  await tell($, `Пользователь нажал «Проверить связь» для ${server.name}.\n${output}`)
}

async function personDeploy($: EngineInterface, name: string): Promise<void> {
  const server = (await read($, servers)).find(one => one.name === name)
  if (server !== undefined) await deployNow($, server, 'person')
}

async function afterPush($: EngineInterface): Promise<void> {
  for (const server of await read($, servers)) {
    if (server.deployMode === 'after-push' && server.deploy !== undefined) await deployNow($, server, 'auto')
  }
}

async function forgetServer($: EngineInterface, name: string): Promise<void> {
  await update($, confirming, () => null)
  await keepServers($, (await read($, servers)).filter(one => one.name !== name))
  await update($, health, all => Object.fromEntries(Object.entries(all).filter(([key]) => key !== name)))
  $.ui.toast(`Сервер ${name} убран из пульта`)
}

async function toggleDeployMode($: EngineInterface, name: string): Promise<void> {
  const list = (await read($, servers)).map(one =>
    one.name === name ? { ...one, deployMode: one.deployMode === 'after-push' ? ('manual' as const) : ('after-push' as const) } : one,
  )
  await keepServers($, list)
}

async function toggleConfirm($: EngineInterface): Promise<void> {
  const mode = await read($, settings)
  await keepProject($, await read($, servers), { ...mode, confirm: mode.confirm === 'every' ? 'risky' : 'every' })
}

async function toggleBand($: EngineInterface): Promise<void> {
  const mode = await read($, settings)
  await keepProject($, await read($, servers), { ...mode, band: !mode.band })
}

async function editDraft($: EngineInterface, field: 'address' | 'dir' | 'deploy', value: string): Promise<void> {
  await update($, draft, one => ({ ...one, [field]: value, error: '' }))
}

async function saveFromForm($: EngineInterface): Promise<void> {
  const form = await read($, draft)
  const parsed = parseAddress(form.address)
  if ('error' in parsed) {
    await update($, draft, one => ({ ...one, error: parsed.error }))
    return
  }
  const list = await read($, servers)
  const checked = checkServer({ name: nextName(list), ...parsed, dir: form.dir, deploy: form.deploy })
  if ('error' in checked) {
    await update($, draft, one => ({ ...one, error: checked.error }))
    return
  }
  await keepServers($, [...list, checked.server])
  await update($, draft, () => EMPTY_DRAFT)
  await update($, adding, () => false)
  await connect($, checked.server.name)
}

async function stopAdding($: EngineInterface): Promise<void> {
  await update($, draft, () => EMPTY_DRAFT)
  await update($, adding, () => false)
}

async function homeFolder($: EngineInterface): Promise<{ home: string; isWindows: boolean } | null> {
  const [profile, home] = await Promise.all([$.env.get('USERPROFILE'), $.env.get('HOME')])
  if (profile !== undefined && profile !== '') return { home: profile, isWindows: true }
  if (home !== undefined && home !== '') return { home, isWindows: false }
  return null
}

async function stopSetupPoll(): Promise<void> {
  setupTimer?.cancel()
  setupTimer = undefined
}

async function connected($: EngineInterface, server: Server, ms: number): Promise<void> {
  await stopSetupPoll()
  await setHealth($, server.name, { state: 'ok', at: await $.clock.now(), ms, note: '' })
  await update($, setup, () => ({ server: server.name, step: 'done', note: `${server.name} подключён: ${address(server)}` }))
  $.ui.toast(`Сервер ${server.name} подключён`)
  await tell($, `Сервер ${server.name} (${address(server)}) подключён по ключу: команды на нём можно запускать через ${RUN_TOOL}.`)
}

// Gets the server to take a key: the one in use if it already does, else the
// plugin's own, made here and put on the server from a window where ssh asks
// the password itself.
async function connect($: EngineInterface, name: string): Promise<void> {
  await stopSetupPoll()
  const found = (await read($, servers)).find(one => one.name === name)
  if (found === undefined) return
  void openPane($).catch(() => undefined)
  await update($, setup, () => ({ server: name, step: 'key', note: 'Проверяю, пускает ли сервер по ключу…' }))

  const first = await probe($, found)
  if (first.isOk) return connected($, found, first.ms)

  const place = await homeFolder($)
  if (place === null) {
    await update($, setup, () => ({ server: name, step: 'failed', note: 'Не нашёл домашнюю папку, чтобы положить ключ.' }))
    return
  }
  const sep = place.isWindows ? '\\' : '/'
  const keyPath = `${place.home}${sep}.ssh${sep}${KEY_NAME}`
  if (!(await $.fs.exists(keyPath))) {
    await update($, setup, () => ({ server: name, step: 'key', note: 'Создаю ключ пульта…' }))
    const made = await $.process.run(keygenArgs(keyPath), { timeoutMs: 30_000 }).catch(error => ({ exitCode: 1, stderr: String(error) }))
    if (made.exitCode !== 0) {
      await update($, setup, () => ({ server: name, step: 'failed', note: `Ключ не создался: ${tailOf(made.stderr, 2)}` }))
      return
    }
  }
  const server: Server = { ...found, key: keyPath }
  await keepServers($, (await read($, servers)).map(one => (one.name === name ? server : one)))

  const second = await probe($, server)
  if (second.isOk) return connected($, server, second.ms)

  if (!place.isWindows) {
    await update($, setup, () => ({
      server: name,
      step: 'failed',
      note: `Отправь ключ одной командой в терминале: ssh-copy-id -i ${keyPath}.pub -p ${server.port} ${server.user}@${server.host}, затем нажми «Подключить».`,
    }))
    return
  }
  const encoded = encodePowerShell(connectScript(server, `${keyPath}.pub`))
  const opened = await $.process
    .run(['powershell', '-NoProfile', '-Command', `Start-Process powershell -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`], {
      timeoutMs: 20_000,
    })
    .catch(error => ({ exitCode: 1, stderr: String(error) }))
  if (opened.exitCode !== 0) {
    await update($, setup, () => ({ server: name, step: 'failed', note: `Окно не открылось: ${tailOf(opened.stderr, 2)}` }))
    return
  }
  await update($, setup, () => ({
    server: name,
    step: 'window',
    note: 'Открылось окно «Сервер-пульт: подключение». Введи там пароль сервера один раз, дальше пульт сам.',
  }))
  let tries = 0
  setupTimer = $.clock.every(SETUP_POLL_MS, () => {
    tries++
    pollSetup($, name, tries).catch(() => undefined)
  })
}

async function pollSetup($: EngineInterface, name: string, tries: number): Promise<void> {
  const server = (await read($, servers)).find(one => one.name === name)
  const current = await read($, setup)
  if (server === undefined || current === null || current.server !== name || current.step !== 'window') {
    await stopSetupPoll()
    return
  }
  const result = await probe($, server)
  if (result.isOk) {
    await connected($, server, result.ms)
    return
  }
  if (tries >= SETUP_POLL_TRIES) {
    await stopSetupPoll()
    await update($, setup, () => ({
      server: name,
      step: 'failed',
      note: 'Сервер так и не пустил по ключу. Если окно закрылось с ошибкой, нажми «Подключить» ещё раз.',
    }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadProject($)
    await update($, confirming, () => null)
    await update($, setup, () => null)
    await $.command.register({ name: 'server', description: 'Открыть сервер-пульт: подключение, статус, деплой, настройки' })
    await $.tool.register({ name: 'run', description: RUN_DESCRIPTION, inputSchema: RUN_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'save_server', description: SAVE_DESCRIPTION, inputSchema: SAVE_SCHEMA, isDeferred: false })
    $.clock.every(HEALTH_MS, () => {
      checkAll($).catch(() => undefined)
    })
    checkAll($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'server' }, async $ => {
    await openPane($)
    return { text: 'Сервер-пульт открыт.' }
  })

  // The conversation's opening context names the servers, so the model runs
  // commands itself rather than handing them over to be typed.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const text = briefing(await read($, servers), await read($, settings))
    return { ...context, blocks: [...context.blocks, { name: 'projectServers', text }] }
  })

  on('tool.call', { tool: RUN_TOOL }, async ($, e) => {
    const input = e as unknown as { server?: unknown; command?: unknown; why?: unknown; timeoutSec?: unknown }
    const list = await read($, servers)
    const server = list.find(one => one.name === input.server)
    if (server === undefined) {
      return {
        deny:
          list.length === 0
            ? `У проекта нет сохранённых серверов: сначала сохрани сервер через ${SAVE_TOOL}.`
            : `Нет сервера «${String(input.server)}». Сохранены: ${list.map(one => one.name).join(', ')}.`,
      }
    }
    if (typeof input.command !== 'string' || input.command.trim() === '') return { deny: 'command: пустая команда' }
    const command = input.command.trim()
    if (command.length > COMMAND_SHOWN) {
      return { deny: `Команда длиннее ${COMMAND_SHOWN} символов: в окне подтверждения её не показать целиком. Разбей на части.` }
    }
    const why = typeof input.why === 'string' && input.why.trim() !== '' ? input.why.trim() : 'Запустить эту команду на сервере'
    const asked = Number(input.timeoutSec ?? DEFAULT_TIMEOUT_SEC)
    const timeoutSec = Number.isFinite(asked) ? Math.min(600, Math.max(5, Math.round(asked))) : DEFAULT_TIMEOUT_SEC
    const warnings = dangers(command)
    const mode = await read($, settings)

    if (mode.confirm === 'every' || warnings.length > 0) {
      const question =
        `Сервер «${server.name}» (${address(server)})${server.dir === undefined ? '' : `, папка ${server.dir}`}. ` +
        `Зачем: ${why}. ${warnings.length > 0 ? `⚠ ${warnings.join('; ')}. ` : ''}Команда: ${command} — выполнить?`
      const answer = await confirm($, question, 'Выполнить')
      if (!answer.isYes) {
        const at = await $.clock.now()
        await addRun($, { server: server.name, command, by: 'claude', at, status: 'cancelled', exitCode: null, tail: answer.note })
        return { result: `Команда не выполнена: ${answer.note}.` }
      }
    }
    return { result: await execute($, server, command, 'claude', timeoutSec) }
  })

  on('tool.call', { tool: SAVE_TOOL }, async ($, e) => {
    const checked = checkServer(e)
    if ('error' in checked) return { deny: checked.error }
    const server = checked.server
    const list = await read($, servers)
    const isReplacing = list.some(one => one.name === server.name)
    const parts = [
      address(server),
      server.dir === undefined ? '' : `папка ${server.dir}`,
      server.deploy === undefined ? '' : `деплой: ${server.deploy}${server.deployMode === 'after-push' ? ' (сам после git push)' : ''}`,
    ]
    const answer = await confirm(
      $,
      `Сервер «${server.name}»: ${parts.filter(Boolean).join(' · ')}. Пульт подключит его по SSH-ключу: создаст ключ и ` +
        `откроет окно, где сервер один раз спросит пароль. ${isReplacing ? 'Заменить им сохранённый' : 'Сохранить и подключить'}?`,
      'Сохранить',
    )
    if (!answer.isYes) return { result: `Сервер не сохранён: ${answer.note}.` }
    const kept = list.find(one => one.name === server.name)
    await keepServers($, [...list.filter(one => one.name !== server.name), { ...server, key: server.key ?? kept?.key }])
    void connect($, server.name).catch(() => undefined)
    return {
      result:
        `Сервер «${server.name}» (${address(server)}) сохранён. Пульт подключает его: если сервер ещё не пускает по ключу, ` +
        'у пользователя откроется окно, где он один раз введёт пароль. Статус виден в строке над полем ввода.',
    }
  })

  // A push the model made deploys the servers that are set to deploy after one.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true && isPush(e.command)) {
      afterPush($).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true && isPush(e.command)) {
      afterPush($).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Its segment of the shared row: the server, whether it answers, the last deploy.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next): Promise<RenderElement> => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return below
    const mode = await read($, settings)
    if (!mode.band) return below
    const list = await read($, servers)
    const { Box, Text, Button } = $.ui.resolve(e)

    if (list.length === 0) {
      return joinRow(
        below,
        <Box key="seg-2-server" gap={1}>
          <Text dimColor>○ сервер не подключён</Text>
          <Button key="sp-band-open" label="Подключить" onPress={() => void openPane($)} />
        </Box>,
        Box,
        'server',
      )
    }

    const server = list[0]!
    const state = (await read($, health))[server.name]
    const history = await read($, runs)
    const waiting = await read($, confirming)
    const assistant = await read($, setup)
    const lastDeploy = [...history].reverse().find(run => run.server === server.name && run.command === server.deploy)
    const dot =
      state?.state === 'ok'
        ? { mark: '●', look: { color: 'success' } }
        : state?.state === 'fail'
          ? { mark: '●', look: { color: 'error' } }
          : state?.state === 'checking'
            ? { mark: '◌', look: { color: 'claude' } }
            : { mark: '○', look: { dimColor: true } }
    const status =
      assistant !== null && assistant.server === server.name && (assistant.step === 'key' || assistant.step === 'window')
        ? 'подключаю…'
        : state?.state === 'ok'
          ? `на связи${state.ms === null ? '' : ` · ${state.ms} мс`}`
          : state?.state === 'fail'
            ? 'нет связи'
            : state?.state === 'checking'
              ? 'проверяю…'
              : 'не проверен'
    const deployText =
      lastDeploy === undefined
        ? ''
        : lastDeploy.status === 'running'
          ? ' · деплой идёт…'
          : ` · деплой ${clock(lastDeploy.at)} ${lastDeploy.status === 'done' ? '✓' : lastDeploy.status === 'failed' ? '✗' : '–'}`
    const isDeploying = lastDeploy?.status === 'running'
    const problems = state?.vitals === undefined ? [] : alerts(state.vitals)

    // In the shared row the address stays in the pane: name, state, last deploy.
    return joinRow(
      below,
      <Box key="seg-2-server" gap={1}>
        <Text {...dot.look}>{dot.mark}</Text>
        <Text>{server.name}</Text>
        <Text dimColor>
          {status}
          {deployText}
          {server.deployMode === 'after-push' ? ' · авто-деплой' : ''}
          {list.length > 1 ? ` · ещё ${list.length - 1}` : ''}
        </Text>
        {problems.length > 0 && (
          <Text color="error">
            ⚠ {problems[0]}
            {problems.length > 1 ? ` · ещё ${problems.length - 1}` : ''}
          </Text>
        )}
        {waiting === `${server.name}:deploy` ? (
          <Box gap={1}>
            <Text color="warning">Деплой на {server.name}?</Text>
            <Button key="sp-band-yes" variant="primary" label="Да" onPress={() => void personDeploy($, server.name)} />
            <Button key="sp-band-no" label="Нет" onPress={() => void update($, confirming, () => null)} />
          </Box>
        ) : (
          <Box gap={1}>
            {server.deploy !== undefined && !isDeploying && (
              <Button key="sp-band-deploy" label="Деплой" onPress={() => void update($, confirming, () => `${server.name}:deploy`)} />
            )}
            {state?.state === 'fail' && <Button key="sp-band-connect" label="Подключить" onPress={() => void connect($, server.name)} />}
            <Button key="sp-band-open" label="Пульт" onPress={() => void openPane($)} />
          </Box>
        )}
      </Box>,
      Box,
      'server',
    )
  })

  // The pane in blocks with air between them: each server a card (state on the
  // right, address under it, the deploy apart, actions last), the form with its
  // labels above the fields, settings as label and value, the journal two lines
  // a command.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // A surface without text fields (mobile) adds servers through the chat.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, servers)
    const mode = await read($, settings)
    const states = await read($, health)
    const history = await read($, runs)
    const waiting = await read($, confirming)
    const assistant = await read($, setup)
    const form = await read($, draft)
    const isAdding = (await read($, adding)) || list.length === 0
    const recent = history.slice(-SHOWN_RUNS).reverse()
    const latest = history.at(-1)
    const width = Math.max(24, e.props.bodyColumns - 4)

    // A field: its label, a blank row, the field with its hint under it; two rows to the next.
    const field = (key: 'address' | 'dir' | 'deploy', title: string, placeholder: string, hint: string, onSubmit: (value: string) => void) =>
      Input === undefined ? null : (
        <Box key={`field-${key}`} flexDirection="column" {...(key === 'address' ? {} : { marginTop: 2 })}>
          <Text>{title}</Text>
          <Box marginTop={1} flexDirection="column">
            <Input
              key={`sp-${key}`}
              placeholder={placeholder}
              value={form[key]}
              onInput={value => void editDraft($, key, value)}
              onSubmit={value => onSubmit(value)}
            />
            <Box marginTop={1}>
              <Text dimColor wrap="wrap">
                {hint}
              </Text>
            </Box>
          </Box>
        </Box>
      )

    // A section's heading with a blank row under it.
    const heading = (key: string, text: string) => (
      <Box key={key} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {assistant !== null && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>ПОДКЛЮЧЕНИЕ · {assistant.server}</Text>
            <Text
              wrap="wrap"
              {...(assistant.step === 'done' ? { color: 'success' } : assistant.step === 'failed' ? { color: 'error' } : { color: 'claude' })}
            >
              {assistant.step === 'done' ? '✓ ' : assistant.step === 'failed' ? '✗ ' : '… '}
              {assistant.note}
            </Text>
          </Box>
        )}

        {heading('h-servers', list.length > 1 ? 'СЕРВЕРЫ ПРОЕКТА' : 'СЕРВЕР ПРОЕКТА')}
        {list.length === 0 && (
          <Box>
            <Text wrap="wrap">
              Пока нет ни одного. Добавь сервер, и Claude сможет сам заходить на него, проверять и деплоить. Пароль спросят один раз в отдельном окне, его не видит ни пульт, ни Claude.
            </Text>
          </Box>
        )}

        {list.map((server, index) => {
          const state = states[server.name]
          const isBusy = history.some(run => run.server === server.name && run.status === 'running')
          const look = state?.state === 'ok' ? { color: 'success' } : state?.state === 'fail' ? { color: 'error' } : { dimColor: true }
          const status =
            state?.state === 'ok'
              ? `на связи${state.ms === null ? '' : ` · ${state.ms} мс`}`
              : state?.state === 'fail'
                ? 'нет связи'
                : state?.state === 'checking'
                  ? 'проверяю…'
                  : 'не проверен'
          const lastDeploy = [...history].reverse().find(run => run.server === server.name && run.command === server.deploy)
          const deployState = [
            server.deployMode === 'after-push' ? 'сам после git push' : 'вручную',
            lastDeploy === undefined
              ? ''
              : lastDeploy.status === 'running'
                ? 'идёт сейчас'
                : `последний ${clock(lastDeploy.at)} ${lastDeploy.status === 'done' ? '✓' : lastDeploy.status === 'failed' ? '✗' : '–'}`,
          ]
            .filter(part => part !== '')
            .join(' · ')
          return (
            <Box key={`srv-${server.name}`} flexDirection="column" {...(index > 0 ? { marginTop: 2 } : {})}>
              <Box justifyContent="space-between">
                <Box gap={1}>
                  <Text {...look}>●</Text>
                  <Text>{server.name}</Text>
                </Box>
                <Text {...(state?.state === 'ok' ? { color: 'success' } : state?.state === 'fail' ? { color: 'error' } : { dimColor: true })}>{status}</Text>
              </Box>
              <Text dimColor wrap="wrap">
                {address(server)}
                {server.dir === undefined ? '' : ` · ${server.dir}`}
                {server.key === undefined ? '' : ' · ключ пульта'}
              </Text>
              {state?.state === 'fail' && state.note !== '' && (
                <Text color="error" wrap="wrap">
                  {state.note}
                </Text>
              )}

              {state?.vitals !== undefined && (
                <Box marginTop={2} flexDirection="column">
                  {heading(`h-state-${server.name}`, `СОСТОЯНИЕ · ${runtimeName(state.vitals.runtime)}`)}
                  {machineLines(state.vitals).map(line => (
                    <Text key={`m-${line}`}>{line}</Text>
                  ))}
                  {shownServices(state.vitals).length > 0 && (
                    <Box marginTop={1} flexDirection="column">
                      {shownServices(state.vitals).map(service => (
                        <Box key={`svc-${server.name}-${service.name}`} gap={1}>
                          <Text {...(isUp(service) ? { color: 'success' } : { color: 'error' })}>●</Text>
                          <Text>{service.name}</Text>
                          <Text dimColor>{stateWord(service)}</Text>
                        </Box>
                      ))}
                    </Box>
                  )}
                  {alerts(state.vitals).length > 0 && (
                    <Box marginTop={1} flexDirection="column">
                      {alerts(state.vitals).map(alert => (
                        <Text key={`a-${alert}`} color="error" wrap="wrap">
                          ⚠ {alert}
                        </Text>
                      ))}
                    </Box>
                  )}
                  <Box marginTop={2} flexDirection="column">
                    {heading(`h-errors-${server.name}`, state.vitals.errors.length === 0 ? 'ОШИБКИ В ЛОГАХ · нет' : `ОШИБКИ В ЛОГАХ · ${state.vitals.errors.length}`)}
                    <Box marginBottom={1}>
                      <Text dimColor wrap="wrap">
                        откуда: {logSources(state.vitals)}
                      </Text>
                    </Box>
                    {state.vitals.errors.slice(-ERRORS_SHOWN).map((line, index) => (
                      <Box key={`e-${server.name}-${index}`} {...(index > 0 ? { marginTop: 1 } : {})}>
                        <Text dimColor wrap="wrap">
                          {line}
                        </Text>
                      </Box>
                    ))}
                    <Box marginTop={1} gap={1} flexWrap="wrap">
                      {state.vitals.errors.length > 0 && (
                        <Button key={`analyze-${server.name}`} label="Разобрать ошибки" onPress={() => void analyzeErrors($, server.name)} />
                      )}
                      <Button key={`logs-${server.name}`} label="Логи" onPress={() => void personLogs($, server.name)} />
                      <Button key={`refresh-${server.name}`} label="Обновить" onPress={() => void personRefresh($, server.name)} />
                    </Box>
                  </Box>
                </Box>
              )}

              {server.deploy !== undefined && (
                <Box marginTop={2} flexDirection="column">
                  {heading(`h-deploy-${server.name}`, 'ДЕПЛОЙ')}
                  <Text wrap="wrap">{server.deploy}</Text>
                  <Text dimColor>{deployState}</Text>
                </Box>
              )}

              <Box marginTop={2} flexDirection="column">
                {isBusy ? (
                  <Text color="claude">выполняется…</Text>
                ) : waiting === `${server.name}:deploy` ? (
                  <Box flexDirection="column">
                    <Text color="warning">Задеплоить на {server.name}?</Text>
                    <Box gap={1} flexWrap="wrap">
                      <Button key={`yes-deploy-${server.name}`} variant="primary" label="Да, деплой" onPress={() => void personDeploy($, server.name)} />
                      <Button key={`no-deploy-${server.name}`} label="Отмена" onPress={() => void update($, confirming, () => null)} />
                    </Box>
                  </Box>
                ) : waiting === `${server.name}:forget` ? (
                  <Box flexDirection="column">
                    <Text color="warning" wrap="wrap">
                      Убрать {server.name} из пульта? На сервере ничего не изменится.
                    </Text>
                    <Box gap={1} flexWrap="wrap">
                      <Button key={`yes-forget-${server.name}`} label="Да, убрать" onPress={() => void forgetServer($, server.name)} />
                      <Button key={`no-forget-${server.name}`} label="Отмена" onPress={() => void update($, confirming, () => null)} />
                    </Box>
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    <Box gap={1} flexWrap="wrap">
                      {state?.state !== 'ok' && (
                        <Button key={`connect-${server.name}`} variant="primary" label="Подключить" onPress={() => void connect($, server.name)} />
                      )}
                      {server.deploy !== undefined && (
                        <Button
                          key={`deploy-${server.name}`}
                          {...(state?.state === 'ok' ? { variant: 'primary' as const } : {})}
                          label="Задеплоить"
                          onPress={() => void update($, confirming, () => `${server.name}:deploy`)}
                        />
                      )}
                      <Button key={`check-${server.name}`} label="Проверить связь" onPress={() => void personCheck($, server.name)} />
                    </Box>
                    <Box marginTop={1} gap={2} flexWrap="wrap">
                      {server.deploy !== undefined && (
                        <Button
                          key={`mode-${server.name}`}
                          plain
                          label={server.deployMode === 'after-push' ? 'Деплой: сам после пуша' : 'Деплой: вручную'}
                          onPress={() => void toggleDeployMode($, server.name)}
                        />
                      )}
                      <Button key={`forget-${server.name}`} plain label="Забыть сервер" onPress={() => void update($, confirming, () => `${server.name}:forget`)} />
                    </Box>
                  </Box>
                )}
              </Box>
            </Box>
          )
        })}

        {Input !== undefined && isAdding && (
          <Box marginTop={2} flexDirection="column">
            {list.length > 0 && heading('h-new', 'НОВЫЙ СЕРВЕР')}
            {field('address', 'Адрес для ssh', 'root@1.2.3.4', 'пользователь@адрес, порт через двоеточие: root@1.2.3.4:2222', value =>
              void editDraft($, 'address', value).then(() => saveFromForm($)),
            )}
            {field('dir', 'Папка проекта на сервере', '~/app', 'можно оставить пустым', value => void editDraft($, 'dir', value))}
            {field('deploy', 'Команда деплоя', 'git pull && docker compose up -d --build', 'можно оставить пустым и добавить потом', value =>
              void editDraft($, 'deploy', value),
            )}
            {form.error !== '' && (
              <Box marginTop={1}>
                <Text color="error" wrap="wrap">
                  {form.error}
                </Text>
              </Box>
            )}
            <Box marginTop={2} gap={1}>
              <Button key="sp-save" variant="primary" label="Сохранить и подключить" onPress={() => void saveFromForm($)} />
              {list.length > 0 && <Button key="sp-cancel" label="Отмена" onPress={() => void stopAdding($)} />}
            </Box>
          </Box>
        )}
        {Input !== undefined && !isAdding && (
          <Box marginTop={2}>
            <Button key="sp-add" plain label="+ Добавить сервер" onPress={() => void update($, adding, () => true)} />
          </Box>
        )}

        <Box marginTop={2} flexDirection="column">
          {heading('h-settings', 'НАСТРОЙКИ')}
          <Box justifyContent="space-between">
            <Text>Подтверждать команды Claude</Text>
            <Button key="sp-confirm" label={mode.confirm === 'every' ? 'каждую' : 'только опасные'} onPress={() => void toggleConfirm($)} />
          </Box>
          <Box marginTop={1} justifyContent="space-between">
            <Text>Строка над полем ввода</Text>
            <Button key="sp-band" label={mode.band ? 'видна' : 'скрыта'} onPress={() => void toggleBand($)} />
          </Box>
        </Box>

        {recent.length > 0 && (
          <Box marginTop={2} flexDirection="column">
            {heading('h-journal', 'ЖУРНАЛ')}
            {recent.map((run, index) => {
              const look =
                run.status === 'done'
                  ? { color: 'success' }
                  : run.status === 'failed'
                    ? { color: 'error' }
                    : run.status === 'running'
                      ? { color: 'claude' }
                      : { dimColor: true }
              const mark = run.status === 'done' ? '✓' : run.status === 'failed' ? '✗' : run.status === 'running' ? '…' : '–'
              const exit = run.exitCode === null ? (run.status === 'cancelled' ? ' · отменена' : '') : ` · exit ${run.exitCode}`
              const who = run.by === 'auto' ? ' · авто' : run.by === 'person' ? ' · ты' : ' · Claude'
              return (
                <Box key={`run-${run.id}`} flexDirection="column" {...(index > 0 ? { marginTop: 1 } : {})}>
                  <Text {...look}>
                    {mark} {clock(run.at)} {run.server}
                    {exit}
                    {who}
                  </Text>
                  <Box marginLeft={2}>
                    <Text dimColor wrap="truncate">
                      {short(run.command, width - 2)}
                    </Text>
                  </Box>
                </Box>
              )
            })}
            {latest !== undefined && latest.tail !== '' && (
              <Box marginTop={2} flexDirection="column">
                {heading('h-output', 'ВЫВОД ПОСЛЕДНЕЙ КОМАНДЫ')}
                <Text dimColor wrap="wrap">
                  {latest.tail}
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
