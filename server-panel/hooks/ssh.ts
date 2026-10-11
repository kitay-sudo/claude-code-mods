// What a server record may hold and how a command reaches it over SSH, as
// plain data: no `$`, so tests read it directly.
//
// Every field that lands on ssh's command line is checked first, so nothing a
// model or a typo writes there can be read as an ssh option (`-oProxyCommand=`).

import type { Server } from '../types'

const NAME = /^[A-Za-z0-9_-]{1,32}$/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[?[0-9A-Fa-f:]{2,39}\]?)$/
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/
const OUTPUT_LIMIT = 16_000
const OUTPUT_HEAD = 4_000
const TAIL_LINES = 12

export function checkServer(input: unknown): { server: Server } | { error: string } {
  const raw = (input ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : undefined)
  const name = text('name')
  const host = text('host')
  const user = text('user')
  const port = raw.port === undefined ? 22 : Number(raw.port)
  if (name === undefined || !NAME.test(name)) return { error: 'name: латиница, цифры, - и _, до 32 символов (например prod)' }
  if (host === undefined || !HOST.test(host)) return { error: 'host: имя хоста или IP-адрес' }
  if (user === undefined || !USER.test(user)) return { error: 'user: имя пользователя на сервере (например root)' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'port: число от 1 до 65535' }
  const server: Server = { name, host, user, port }
  const dir = text('dir')
  const key = text('key')
  const deploy = text('deploy')
  if (dir !== undefined && dir !== '') {
    if (/[\n\r]/.test(dir)) return { error: 'dir: одна строка' }
    server.dir = dir
  }
  if (key !== undefined && key !== '') {
    if (key.startsWith('-') || /[\n\r]/.test(key)) return { error: 'key: путь к файлу ключа' }
    server.key = key
  }
  if (deploy !== undefined && deploy !== '') {
    if (/[\n\r]/.test(deploy)) return { error: 'deploy: одна строка, шаги через &&' }
    server.deploy = deploy
  }
  if (raw.deployMode === 'after-push' || raw.deployMode === 'manual') server.deployMode = raw.deployMode
  return { server }
}

/** `root@1.2.3.4`, `root@1.2.3.4:2222` or `ssh root@host -p 2222`, as the form takes it. */
export function parseAddress(text: string): { user: string; host: string; port: number } | { error: string } {
  const words = text.trim().replace(/^ssh\s+/, '').split(/\s+/)
  let port = 22
  const portAt = words.indexOf('-p')
  if (portAt !== -1) {
    port = Number(words[portAt + 1])
    words.splice(portAt, 2)
  }
  const target = words.find(word => word.includes('@'))
  const match = target === undefined ? null : /^([^@]+)@(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(target)
  if (match === null) return { error: 'Адрес пишется так: root@1.2.3.4 или root@1.2.3.4:2222' }
  const checked = checkServer({ name: 'x', user: match[1], host: match[2], port: match[3] === undefined ? port : Number(match[3]) })
  if ('error' in checked) return { error: checked.error }
  return { user: checked.server.user, host: checked.server.host, port: checked.server.port }
}

/** A word for a POSIX shell: single-quoted, any single quote closed and escaped. */
export function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function cdInto(dir: string): string {
  if (dir === '~') return 'cd ~'
  // The home part stays bare so the remote shell expands it.
  if (dir.startsWith('~/')) return `cd ~/${quote(dir.slice(2))}`
  return `cd ${quote(dir)}`
}

export function remoteCommand(server: Server, command: string): string {
  return server.dir === undefined ? command : `${cdInto(server.dir)} && ${command}`
}

export function address(server: Server): string {
  return `${server.user}@${server.host}${server.port === 22 ? '' : `:${server.port}`}`
}

export function sshArgs(server: Server, command: string, connectTimeoutSec = 10): string[] {
  return [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-p', String(server.port),
    ...(server.key === undefined ? [] : ['-i', server.key]),
    '--',
    `${server.user}@${server.host}`,
    remoteCommand(server, command),
  ]
}

/** A login that only proves the key gets in: no folder, nothing run. */
export function probeArgs(server: Server): string[] {
  return sshArgs({ ...server, dir: undefined }, 'true', 5)
}

export function keygenArgs(path: string): string[] {
  return ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'server-panel', '-f', path]
}

// The remote side of putting the key on the server: appended once, the file
// kept private, a key already there not doubled.
const INSTALL_KEY = 'umask 077 && mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys'

/**
 * A PowerShell script for a window of its own, where ssh asks the server's
 * password itself, hidden, once: the plugin never sees it.
 */
export function connectScript(server: Server, publicKeyPath: string): string {
  const target = `${server.user}@${server.host}`
  const literal = (text: string) => `'${text.replace(/'/g, "''")}'`
  return [
    `$Host.UI.RawUI.WindowTitle = ${literal(`Сервер-пульт: подключение ${server.name}`)}`,
    `Write-Host ${literal(`Сервер-пульт отправляет ключ на ${target}.`)}`,
    `Write-Host ${literal('Сервер один раз спросит пароль. Пароль видишь только ты: пульт и Claude его не получают.')}`,
    'Write-Host',
    `Get-Content -Raw ${literal(publicKeyPath)} | ssh -o StrictHostKeyChecking=accept-new -p ${server.port} ${target} ${literal(INSTALL_KEY)}`,
    'if ($LASTEXITCODE -eq 0) {',
    `  Write-Host ${literal('Готово, ключ на сервере. Окно закроется само.')}`,
    '  Start-Sleep -Seconds 3',
    '} else {',
    `  Write-Host ${literal('Не получилось. Нажми Enter, чтобы закрыть, и снова нажми «Подключить» в пульте.')}`,
    '  Read-Host | Out-Null',
    '}',
  ].join('\n')
}

/** Base64 of the script's UTF-16LE bytes, as PowerShell's -EncodedCommand takes it. */
export function encodePowerShell(script: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes.push(code & 0xff, code >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const chunk = (a << 16) | (b << 8) | c
    out += alphabet[(chunk >> 18) & 63]! + alphabet[(chunk >> 12) & 63]!
    out += i + 1 < bytes.length ? alphabet[(chunk >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? alphabet[chunk & 63]! : '='
  }
  return out
}

/** Whether a shell command pushes with git, for deploying after it. */
export function isPush(command: string): boolean {
  return /(^|[\s;&|(])git(\s+-C\s+\S+)?\s+push\b/.test(command) && !/--dry-run|\s-n\b/.test(command)
}

const DANGERS: [RegExp, string][] = [
  [/(^|[\s;&|(])rm\s/, 'удаляет файлы'],
  [/\bmkfs|\bdd\s[^|;]*\bof=|>\s*\/dev\/(sd|nvme|vd)/, 'пишет прямо на диск'],
  [/\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b/, 'перезагружает или выключает сервер'],
  [/drop\s+(database|table|schema)|truncate\s+table|\bflushall\b|\bflushdb\b/i, 'удаляет данные в базе'],
  [/docker\s+(system|volume|image|container|builder)\s+prune|docker\s+(rm|rmi)\b|compose\s+down\b[^;&|]*\s-v\b/, 'удаляет контейнеры, образы или тома Docker'],
  [/git\s+(reset\s+--hard|clean\s+-[A-Za-z]*f|push\s[^;&|]*(--force|\s-f\b))/, 'безвозвратно меняет git'],
  [/chmod\s+-R\s+777|chown\s+-R\s+\S+\s+\/(\s|$)/, 'меняет права на всё подряд'],
  [/systemctl\s+(stop|disable|mask)\b|\bkill\s+-9\b|\bpkill\b|\bkillall\b/, 'останавливает службы или процессы'],
  [/\biptables\b|\bufw\s+(deny|reset|disable)\b|\bfirewall-cmd\b/, 'меняет фаервол: можно потерять доступ'],
  [/\bpasswd\b|\busermod\b|\buserdel\b|authorized_keys|sshd_config/, 'меняет пользователей или вход на сервер'],
]

/** What in a command can break or lose something, for the confirmation dialog. */
export function dangers(command: string): string[] {
  return DANGERS.filter(([test]) => test.test(command)).map(([, why]) => why)
}

function cut(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  const tail = OUTPUT_LIMIT - OUTPUT_HEAD
  return `${text.slice(0, OUTPUT_HEAD)}\n… пропущено ${text.length - OUTPUT_LIMIT} символов …\n${text.slice(-tail)}`
}

/** A run's result as the model reads it. */
export function formatOutput(exitCode: number, stdout: string, stderr: string): string {
  const parts = [`exit code: ${exitCode}`]
  if (stdout.trim() !== '') parts.push(`--- stdout ---\n${cut(stdout.trimEnd())}`)
  if (stderr.trim() !== '') parts.push(`--- stderr ---\n${cut(stderr.trimEnd())}`)
  if (parts.length === 1) parts.push('(вывода нет)')
  return parts.join('\n')
}

export function tailOf(text: string, lines = TAIL_LINES): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

/** What to do when ssh could not get in, by what it said; undefined when it got in. */
export function connectHint(server: Server, stderr: string): string | undefined {
  const target = `${server.user}@${server.host}`
  const port = server.port === 22 ? '' : ` -p ${server.port}`
  if (/Permission denied \((publickey|.*publickey)/i.test(stderr)) {
    return (
      `Сервер не пустил по ключу. Один раз настрой вход по ключу в своём терминале (PowerShell):\n` +
      `ssh-keygen -t ed25519   (если ключа ещё нет; на вопросы можно жать Enter)\n` +
      `Get-Content $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh${port} ${target} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"\n` +
      'Сервер спросит пароль один раз, дальше пульт будет входить сам.'
    )
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) {
    return 'Ключ сервера изменился с прошлого входа. Если сервер переустанавливали, убери старую запись: ssh-keygen -R ' + server.host
  }
  if (/Could not resolve hostname|Connection timed out|Connection refused|No route to host|Network is unreachable/i.test(stderr)) {
    return 'До сервера не достучаться: проверь адрес, порт и что сервер включён.'
  }
  return undefined
}
