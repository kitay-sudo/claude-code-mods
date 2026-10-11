// A server's health from one SSH call that changes nothing: the machine
// (processor, memory, disk), what runs the project and the last error lines of
// its logs. The same check works on any project and any stack: what runs it is
// found, not configured.
//
// What runs it, in this order: Docker Compose in the project folder, Docker,
// pm2, systemd services started from the project folder, else nothing (a PHP
// site under nginx and php-fpm, a static one). On top of that the project's
// own log files, wherever its framework keeps them (Laravel, Symfony,
// WordPress, logs/), and nginx's errors when nothing else runs it.
//
// Plain data: no `$`, so tests read it directly.

import type { Runtime, Server, Service, Vitals } from '../types'
import { cdInto, quote, sshArgs } from './ssh'

const ERROR_WORDS = 'error|exception|fatal|panic|traceback|critical|unhandled|refused|segfault|out of memory|oom|killed'
const LOG_LINES = 300
const FILE_LINES = 200
const ERRORS_KEPT = 5
const LINE_MAX = 220
const UNITS_KEPT = 5
const NGINX_ERRORS = '/var/log/nginx/error.log'

// Where frameworks keep their logs, relative to the project folder.
const PROJECT_LOGS = 'storage/logs/*.log var/log/*.log wp-content/debug.log logs/*.log log/*.log *.log'
// The project's three newest log files, one path a line.
const NEWEST_LOGS = `ls -t ${PROJECT_LOGS} 2>/dev/null | head -n 3`

// pm2 knows its processes as JSON with their whole environment; only the name,
// state and restarts leave the server.
const PM2_LIST =
  'pm2 jlist 2>/dev/null | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const p of JSON.parse(s))' +
  'console.log("svc="+p.name+"|"+p.pm2_env.status+"|"+p.pm2_env.restart_time)}catch(e){}})\''

// systemd units whose start command or working folder is the project folder ($D).
const PROJECT_UNITS =
  `U=$(for p in $(grep -lsE "^(WorkingDirectory|ExecStart)=.*$D(/|[[:space:]]|\\$)" /etc/systemd/system/*.service 2>/dev/null | head -n ${UNITS_KEPT}); ` +
  'do basename "$p" .service; done)'

/** The logs of what runs the project; null when that leaves none to read. */
function runtimeLogs(runtime: Runtime, lines: number, units: readonly string[]): string | null {
  if (runtime === 'compose') return `docker compose logs --tail ${lines} --no-color 2>&1`
  if (runtime === 'docker') {
    return `for c in $(docker ps --format '{{.Names}}'); do echo "== $c"; docker logs --tail ${Math.max(10, Math.ceil(lines / 4))} "$c" 2>&1; done`
  }
  if (runtime === 'pm2') return `pm2 logs --nostream --raw --lines ${lines} 2>&1`
  if (runtime === 'systemd') {
    return units.length === 0 ? null : `journalctl -n ${lines} --no-pager ${units.map(unit => `-u ${quote(`${unit}.service`)}`).join(' ')} 2>&1`
  }
  // Nothing found that runs it: a site behind nginx, whose errors say a 502 or a dead php-fpm.
  return `tail -n ${lines} ${NGINX_ERRORS} 2>/dev/null`
}

/** What the "Логи" button runs, in the project folder: what runs it, then the project's own log files. */
export function logsCommand(runtime: Runtime, lines: number, units: readonly string[] = []): string {
  const own = `for f in $(${NEWEST_LOGS}); do echo "== $f"; tail -n ${lines} "$f"; done`
  const run = runtimeLogs(runtime, lines, units)
  return run === null ? own : `${run}; ${own}`
}

/** The check itself: POSIX sh, one line, `key=value` out, exit 0 whatever it finds. */
export function vitalsScript(dir: string | undefined): string {
  const parts = [
    // $D: the project folder, empty when there is none to look into.
    dir === undefined ? 'D=' : `D=; ${cdInto(dir)} 2>/dev/null && D=$(pwd) || echo dir=missing`,
    `echo "load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"`,
    `echo "cpus=$(nproc 2>/dev/null)"`,
    `free -m 2>/dev/null | awk '/^Mem:/{print "mem="$3"/"$2}'`,
    `df -Pk . 2>/dev/null | awk 'NR==2{sub("%","",$5); print "disk="$5"/"int($4/1024)}'`,
    [
      `if docker compose ps >/dev/null 2>&1 && [ -n "$(docker compose ps -a -q 2>/dev/null)" ]; then`,
      `echo kind=compose; docker compose ps -a --format '{{.Service}}|{{.State}}|' 2>/dev/null | sed 's/^/svc=/'; L=${quote(runtimeLogs('compose', LOG_LINES, []) ?? '')};`,
      `elif command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -a -q 2>/dev/null)" ]; then`,
      `echo kind=docker; docker ps -a --format '{{.Names}}|{{.State}}|' 2>/dev/null | head -n 20 | sed 's/^/svc=/'; L=${quote(runtimeLogs('docker', LOG_LINES, []) ?? '')};`,
      `elif command -v pm2 >/dev/null 2>&1; then`,
      `echo kind=pm2; ${PM2_LIST}; L=${quote(runtimeLogs('pm2', LOG_LINES, []) ?? '')};`,
      `elif [ -n "$D" ] && ${PROJECT_UNITS} && [ -n "$U" ]; then`,
      `echo kind=systemd; for u in $U; do echo "svc=$u|$(systemctl is-active "$u" 2>/dev/null)|"; done;`,
      `L="journalctl -n ${LOG_LINES} --no-pager"; for u in $U; do L="$L -u $u"; done;`,
      `else echo kind=none; L=${quote(runtimeLogs('none', LOG_LINES, []) ?? '')}; fi`,
    ].join(' '),
    // The project's own log files, whatever the framework.
    `F=; [ -n "$D" ] && F=$(${NEWEST_LOGS}); for f in $F; do echo "logfile=$f"; done`,
    `{ eval "$L"; for f in $F; do tail -n ${FILE_LINES} "$f" 2>/dev/null; done; } 2>&1 | tail -n ${LOG_LINES * 2} | grep -iE ${quote(ERROR_WORDS)} | tail -n ${ERRORS_KEPT} | cut -c1-${LINE_MAX} | sed 's/^/err=/'`,
    'true',
  ]
  // The login shell may not be sh (fish, zsh): the check runs in sh whatever it is.
  return `sh -c ${quote(parts.join('; '))}`
}

/** ssh's arguments for the check: the folder is entered inside it, so a missing one is reported, not fatal. */
export function vitalsArgs(server: Server): string[] {
  return sshArgs({ ...server, dir: undefined }, vitalsScript(server.dir), 8)
}

function numberOf(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '') return null
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : null
}

function plainLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim()
}

const RUNTIMES: readonly Runtime[] = ['compose', 'docker', 'pm2', 'systemd', 'none']

export function parseVitals(stdout: string): Vitals {
  const values = new Map<string, string>()
  const services: Service[] = []
  const errors: string[] = []
  const logFiles: string[] = []
  let isDirMissing = false
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const at = line.indexOf('=')
    if (at < 1) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1)
    if (key === 'svc') {
      const [name = '', state = '', restarts] = value.split('|')
      if (name.trim() !== '') services.push({ name: name.trim(), state: state.trim().toLowerCase(), restarts: numberOf(restarts) })
    } else if (key === 'err') {
      const text = plainLine(value)
      if (text !== '') errors.push(text)
    } else if (key === 'logfile') {
      if (value.trim() !== '') logFiles.push(value.trim())
    } else if (key === 'dir' && value === 'missing') {
      isDirMissing = true
    } else {
      values.set(key, value)
    }
  }
  const load = numberOf(values.get('load'))
  const cpus = numberOf(values.get('cpus'))
  const [memUsed, memTotal] = (values.get('mem') ?? '').split('/')
  const [diskPercent, diskFree] = (values.get('disk') ?? '').split('/')
  const kind = RUNTIMES.find(one => one === values.get('kind')) ?? 'none'
  return {
    cpu: load === null ? null : Math.round((load / Math.max(1, cpus ?? 1)) * 100),
    memUsedMb: numberOf(memUsed),
    memTotalMb: numberOf(memTotal),
    diskPercent: numberOf(diskPercent),
    diskFreeMb: numberOf(diskFree),
    runtime: kind,
    services,
    errors,
    logFiles,
    isDirMissing,
  }
}

export function isUp(service: Service): boolean {
  return service.state === 'running' || service.state === 'online' || service.state === 'active'
}

/** A service's state in a word the person reads. */
export function stateWord(service: Service): string {
  const words: Record<string, string> = {
    running: 'работает',
    online: 'работает',
    active: 'работает',
    exited: 'остановлен',
    stopped: 'остановлен',
    inactive: 'остановлен',
    dead: 'упал',
    errored: 'упал',
    failed: 'упал',
    restarting: 'перезапускается',
    launching: 'запускается',
    activating: 'запускается',
    created: 'создан, не запущен',
    paused: 'на паузе',
  }
  const word = words[service.state] ?? service.state
  return service.restarts !== null && service.restarts > 0 ? `${word} · перезапусков ${service.restarts}` : word
}

function gigabytes(mb: number): string {
  return `${(mb / 1024).toFixed(1).replace('.', ',')} ГБ`
}

/** The machine in two short lines. */
export function machineLines(vitals: Vitals): string[] {
  const first = [
    vitals.cpu === null ? '' : `процессор ${vitals.cpu}%`,
    vitals.memUsedMb === null || vitals.memTotalMb === null ? '' : `память ${gigabytes(vitals.memUsedMb)} из ${gigabytes(vitals.memTotalMb)}`,
  ].filter(part => part !== '')
  const second =
    vitals.diskPercent === null ? '' : `диск ${vitals.diskPercent}%${vitals.diskFreeMb === null ? '' : ` · свободно ${gigabytes(vitals.diskFreeMb)}`}`
  return [first.join(' · '), second].filter(line => line !== '')
}

// Without a Compose project the check sees every container of the machine,
// other projects' and ones stopped on purpose among them: only the ones that
// run, or fall over, are the project's business.
function isOwnTrouble(vitals: Vitals, service: Service): boolean {
  if (isUp(service)) return false
  return vitals.runtime !== 'docker' || service.state === 'restarting' || service.state === 'dead'
}

/** The services the card lists. */
export function shownServices(vitals: Vitals): Service[] {
  return vitals.runtime === 'docker' ? vitals.services.filter(service => isUp(service) || isOwnTrouble(vitals, service)) : vitals.services
}

/** What needs the person's eye, worst first: a service down, the disk or memory nearly full, no project folder. */
export function alerts(vitals: Vitals): string[] {
  const out: string[] = []
  if (vitals.isDirMissing) out.push('папки проекта нет на сервере')
  for (const service of vitals.services) if (isOwnTrouble(vitals, service)) out.push(`${service.name}: ${stateWord(service)}`)
  if (vitals.diskPercent !== null && vitals.diskPercent >= 90) out.push(`диск заполнен на ${vitals.diskPercent}%`)
  if (vitals.memUsedMb !== null && vitals.memTotalMb !== null && vitals.memTotalMb > 0 && vitals.memUsedMb / vitals.memTotalMb >= 0.95) {
    out.push('память почти закончилась')
  }
  return out
}

export function runtimeName(runtime: Runtime): string {
  if (runtime === 'compose') return 'Docker Compose'
  if (runtime === 'docker') return 'Docker'
  if (runtime === 'pm2') return 'pm2'
  if (runtime === 'systemd') return 'systemd'
  return 'без Docker, pm2 и systemd'
}

/** Where the errors are read from, for the card: what runs the project, then its log files. */
export function logSources(vitals: Vitals): string {
  const run =
    vitals.runtime === 'none'
      ? 'nginx'
      : vitals.runtime === 'systemd'
        ? `journalctl ${vitals.services.map(service => service.name).join(', ')}`
        : runtimeName(vitals.runtime)
  return [run, ...vitals.logFiles].join(', ')
}
