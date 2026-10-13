// A server's health from one SSH call that changes nothing: the machine
// (processor, memory, disk), what runs the project and the last error lines of
// its logs. The same check works on any project and any stack: what runs it is
// found, not configured.
//
// One machine often holds several projects, so everything is sorted by the
// project folder: a container is the project's when Docker Compose started it
// from that folder (its com.docker.compose.project.working_dir label), a pm2
// process when it runs from there, a systemd service when its unit starts it
// there. The rest of the machine is only counted, apart. nginx, the front of
// most sites, is shown when it runs or has fallen over. The errors come from
// the project's own processes and log files (Laravel, Symfony, WordPress,
// logs/), and from nginx when nothing else runs it.
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
const CONTAINERS_KEPT = 60
const NGINX_ERRORS = '/var/log/nginx/error.log'
const COMPOSE_DIR = 'com.docker.compose.project.working_dir'

// Where frameworks keep their logs, relative to the project folder.
const PROJECT_LOGS = 'storage/logs/*.log var/log/*.log wp-content/debug.log logs/*.log log/*.log *.log'
// The project's three newest log files, one path a line.
const NEWEST_LOGS = `ls -t ${PROJECT_LOGS} 2>/dev/null | head -n 3`

// Every container with its state and the folder Compose started it from; `1`
// last when that is the project folder ($D, or $P with links resolved) or under it.
const CONTAINERS =
  `CO=$(docker ps -a --format '{{.Names}}|{{.State}}|{{.Label "${COMPOSE_DIR}"}}' 2>/dev/null | head -n ${CONTAINERS_KEPT} | ` +
  `while IFS='|' read -r n s w; do o=0; if [ -n "$D" ]; then case "$w" in "$D"|"$D"/*|"$P"|"$P"/*) o=1;; esac; fi; echo "ctr=$n|$s|$o"; done); ` +
  `printf '%s\\n' "$CO"; OC=$(printf '%s\\n' "$CO" | awk -F'|' '$3==1{sub("^ctr=","",$1); print $1}')`

// pm2 knows its processes as JSON with their whole environment; only the name,
// state, restarts, version and whether it runs from the project folder leave the server.
const PM2_LIST =
  'PL=$(pm2 jlist 2>/dev/null | D="$D" P="$P" node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{' +
  'const ds=[process.env.D,process.env.P].filter(Boolean);const under=p=>typeof p==="string"&&ds.some(d=>p===d||p.startsWith(d+"/"));' +
  'for(const p of JSON.parse(s)){const e=p.pm2_env||{};' +
  'console.log("pm2="+p.name+"|"+e.status+"|"+e.restart_time+"|"+(e.version||"")+"|"+(under(e.pm_cwd)||under(e.pm_exec_path)?1:0))}}catch(x){}})\'); ' +
  `printf '%s\\n' "$PL"; PM=$(printf '%s\\n' "$PL" | awk -F'|' '$5==1{sub("^pm2=","",$1); print $1}')`

// systemd units whose start command or working folder is the project folder ($D).
const PROJECT_UNITS =
  `U=$(for p in $(grep -lsE "^(WorkingDirectory|ExecStart)=.*$D(/|[[:space:]]|\\$)" /etc/systemd/system/*.service 2>/dev/null | head -n ${UNITS_KEPT}); ` +
  'do basename "$p" .service; done)'

/** The check itself: POSIX sh, one line, `key=value` out, exit 0 whatever it finds. */
export function vitalsScript(dir: string | undefined): string {
  const parts = [
    // $D: the project folder, empty when there is none to look into; $P: the same with links resolved.
    dir === undefined ? 'D=' : `D=; ${cdInto(dir)} 2>/dev/null && D=$(pwd) || echo dir=missing`,
    'P=; [ -n "$D" ] && P=$(pwd -P)',
    `echo "load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"`,
    `echo "cpus=$(nproc 2>/dev/null)"`,
    `free -m 2>/dev/null | awk '/^Mem:/{print "mem="$3"/"$2}'`,
    `df -Pk . 2>/dev/null | awk 'NR==2{sub("%","",$5); print "disk="$5"/"int($4/1024)}'`,
    `OC=; PM=; U=`,
    `if command -v docker >/dev/null 2>&1; then echo docker=1; ${CONTAINERS}; fi`,
    `if command -v pm2 >/dev/null 2>&1; then ${PM2_LIST}; fi`,
    `if [ -n "$D" ]; then ${PROJECT_UNITS}; fi; for u in $U; do echo "unit=$u|$(systemctl is-active "$u" 2>/dev/null)"; done`,
    `if command -v nginx >/dev/null 2>&1; then echo "nginx=$(systemctl is-active nginx 2>/dev/null)"; fi`,
    // The logs of the project's own processes; nginx's errors when it has none.
    `L=; for c in $OC; do L="$L docker logs --tail 80 $c 2>&1;"; done; for p in $PM; do L="$L pm2 logs $p --nostream --raw --lines 150 2>&1;"; done; ` +
      `for u in $U; do L="$L journalctl -n ${LOG_LINES} --no-pager -u $u 2>&1;"; done; [ -n "$L" ] || L="tail -n ${LOG_LINES} ${NGINX_ERRORS} 2>/dev/null"`,
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

/** What the "Логи" button runs, in the project folder: the project's own processes, then its log files. */
export function logsCommand(vitals: Vitals | undefined, lines: number): string {
  const own = vitals?.services ?? []
  const named = (kind: Service['kind']) => own.filter(service => service.kind === kind).map(service => quote(service.name))
  const run = [
    ...named('container').map(name => `docker logs --tail ${lines} ${name} 2>&1`),
    ...named('pm2').map(name => `pm2 logs ${name} --nostream --raw --lines ${lines} 2>&1`),
    ...(named('systemd').length === 0 ? [] : [`journalctl -n ${lines} --no-pager ${named('systemd').map(name => `-u ${name}`).join(' ')} 2>&1`]),
  ]
  // Nothing of its own runs it: a site behind nginx, whose errors say a 502 or a dead php-fpm.
  if (run.length === 0) run.push(`tail -n ${lines} ${NGINX_ERRORS} 2>/dev/null`)
  return [...run, `for f in $(${NEWEST_LOGS}); do echo "== $f"; tail -n ${lines} "$f"; done`].join('; ')
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

function service(kind: Service['kind'], name: string, state: string, restarts: string | undefined, version: string | undefined): Service {
  const shown = version?.trim() ?? ''
  return { kind, name: name.trim(), state: state.trim().toLowerCase(), restarts: numberOf(restarts), version: shown === '' || shown === 'N/A' ? null : shown }
}

export function parseVitals(stdout: string): Vitals {
  const values = new Map<string, string>()
  const services: Service[] = []
  const others: Service[] = []
  const errors: string[] = []
  const logFiles: string[] = []
  let isDirMissing = false
  let hasDocker = false
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const at = line.indexOf('=')
    if (at < 1) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1)
    const [name = '', state = '', third, fourth, fifth] = value.split('|')
    if (key === 'ctr' && name.trim() !== '') {
      ;(third === '1' ? services : others).push(service('container', name, state, undefined, undefined))
    } else if (key === 'pm2' && name.trim() !== '') {
      ;(fifth === '1' ? services : others).push(service('pm2', name, state, third, fourth))
    } else if (key === 'unit' && name.trim() !== '') {
      services.push(service('systemd', name, state, undefined, undefined))
    } else if (key === 'nginx') {
      // Shown while it runs the sites or has fallen over; one switched off on purpose is not the project's.
      if (value === 'active' || value === 'failed') services.push(service('nginx', 'nginx', value, undefined, undefined))
    } else if (key === 'docker') {
      hasDocker = true
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
  const runtime: Runtime = services.some(one => one.kind === 'container')
    ? 'compose'
    : services.some(one => one.kind === 'pm2')
      ? 'pm2'
      : services.some(one => one.kind === 'systemd')
        ? 'systemd'
        : 'none'
  return {
    cpu: load === null ? null : Math.round((load / Math.max(1, cpus ?? 1)) * 100),
    memUsedMb: numberOf(memUsed),
    memTotalMb: numberOf(memTotal),
    diskPercent: numberOf(diskPercent),
    diskFreeMb: numberOf(diskFree),
    runtime,
    services,
    others,
    hasDocker,
    errors,
    logFiles,
    isDirMissing,
  }
}

export function isUp(service: Service): boolean {
  return service.state === 'running' || service.state === 'online' || service.state === 'active'
}

/** A service's state in a word the person reads, with its version and restarts when known. */
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
  return [
    words[service.state] ?? service.state,
    service.version === null || service.version === undefined ? '' : `v${service.version.replace(/^v/, '')}`,
    service.restarts !== null && service.restarts > 0 ? `перезапусков ${service.restarts}` : '',
  ]
    .filter(part => part !== '')
    .join(' · ')
}

/** What a service is, then its state: "pm2 · работает · v1.4.0 · перезапусков 3". */
export function serviceLine(service: Service): string {
  const kinds: Record<string, string> = { container: 'контейнер', pm2: 'pm2', systemd: 'systemd' }
  const kind = service.kind === undefined ? '' : (kinds[service.kind] ?? '')
  return [kind, stateWord(service)].filter(part => part !== '').join(' · ')
}

function gigabytes(mb: number): string {
  return `${(mb / 1024).toFixed(1).replace('.', ',')} ГБ`
}

/** The machine in two short lines; the disk is the whole server's, not the project's. */
export function machineLines(vitals: Vitals): string[] {
  const first = [
    vitals.cpu === null ? '' : `процессор ${vitals.cpu}%`,
    vitals.memUsedMb === null || vitals.memTotalMb === null ? '' : `память ${gigabytes(vitals.memUsedMb)} из ${gigabytes(vitals.memTotalMb)}`,
  ].filter(part => part !== '')
  const second =
    vitals.diskPercent === null ? '' : `диск сервера ${vitals.diskPercent}%${vitals.diskFreeMb === null ? '' : ` · свободно ${gigabytes(vitals.diskFreeMb)}`}`
  return [first.join(' · '), second].filter(line => line !== '')
}

/** The project's own processes, as the card lists them. */
export function shownServices(vitals: Vitals): Service[] {
  return vitals.services
}

/** The rest of the machine, kept apart; a check from before 0.8 has none. */
export function otherServices(vitals: Vitals): Service[] {
  return vitals.others ?? []
}

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  const word = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many
  return `${count} ${word}`
}

/** The folded line for the rest of the machine: "ещё 4 контейнера на сервере"; empty when there is none. */
export function othersLine(vitals: Vitals): string {
  const rest = otherServices(vitals)
  const containers = rest.filter(one => one.kind === 'container').length
  const processes = rest.length - containers
  const parts = [
    containers > 0 ? plural(containers, 'контейнер', 'контейнера', 'контейнеров') : '',
    processes > 0 ? plural(processes, 'процесс pm2', 'процесса pm2', 'процессов pm2') : '',
  ].filter(part => part !== '')
  return parts.length === 0 ? '' : `ещё ${parts.join(' и ')} на сервере`
}

/** Said in place of an empty list: Docker is on the server, none of its containers is the project's. */
export function hasNoContainers(vitals: Vitals): boolean {
  return vitals.hasDocker === true && !vitals.services.some(one => one.kind === 'container')
}

/** What needs the person's eye, worst first: a process of the project down, the disk or memory nearly full, no project folder. */
export function alerts(vitals: Vitals): string[] {
  const out: string[] = []
  if (vitals.isDirMissing) out.push('папки проекта нет на сервере')
  for (const one of vitals.services) if (!isUp(one)) out.push(`${one.name}: ${stateWord(one)}`)
  if (vitals.diskPercent !== null && vitals.diskPercent >= 90) out.push(`диск сервера заполнен на ${vitals.diskPercent}%`)
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

/** What runs the project, all of it: "Docker Compose и pm2". */
export function runtimeTitle(vitals: Vitals): string {
  const kinds = new Set(vitals.services.map(one => one.kind))
  const names = [kinds.has('container') ? 'Docker Compose' : '', kinds.has('pm2') ? 'pm2' : '', kinds.has('systemd') ? 'systemd' : ''].filter(name => name !== '')
  return names.length === 0 ? runtimeName(vitals.runtime) : names.join(' и ')
}

/** Where the errors are read from, for the card: the project's processes, then its log files. */
export function logSources(vitals: Vitals): string {
  const own = (kind: Service['kind']) => vitals.services.filter(one => one.kind === kind).map(one => one.name)
  const run = [
    own('container').length > 0 ? `docker ${own('container').join(', ')}` : '',
    own('pm2').length > 0 ? `pm2 ${own('pm2').join(', ')}` : '',
    own('systemd').length > 0 ? `journalctl ${own('systemd').join(', ')}` : '',
  ].filter(part => part !== '')
  return [...(run.length === 0 ? ['nginx'] : run), ...vitals.logFiles].join(', ')
}
