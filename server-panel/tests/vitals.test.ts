import { expect, test } from 'claude-code/testing'

import {
  alerts,
  hasNoContainers,
  logSources,
  logsCommand,
  machineLines,
  parseVitals,
  runtimeTitle,
  serviceLine,
  shownServices,
  stateWord,
  vitalsArgs,
  vitalsScript,
} from '../hooks/vitals'
import type { Server, Service, Vitals } from '../types'

const COMPOSE = [
  'load=0.50',
  'cpus=2',
  'mem=1229/3891',
  'disk=93/1843',
  'docker=1',
  'ctr=web|running',
  'ctr=worker|exited',
  'logfile=storage/logs/laravel.log',
  'err=\u001b[31m2026-10-11 12:03 ERROR\u001b[0m   connection refused to db:5432',
  'err=Traceback (most recent call last):',
].join('\n')

// acme-travel on prod: the site under pm2. The other project's containers
// beside it are sorted out on the server and never come back.
const ACME = ['load=0.2', 'cpus=4', 'mem=2048/7900', 'disk=84/6349', 'docker=1', 'pm2=acme|online|3|1.4.0', 'nginx=active'].join('\n')

const container = (name: string, state: string): Service => ({ kind: 'container', name, state, restarts: null, version: null })

test('one check reads the machine, the project\'s containers, the log files and their errors', () => {
  const vitals = parseVitals(COMPOSE)
  expect(vitals).toEqual({
    cpu: 25,
    memUsedMb: 1229,
    memTotalMb: 3891,
    diskPercent: 93,
    diskFreeMb: 1843,
    runtime: 'compose',
    services: [container('web', 'running'), container('worker', 'exited')],
    hasDocker: true,
    errors: ['2026-10-11 12:03 ERROR connection refused to db:5432', 'Traceback (most recent call last):'],
    logFiles: ['storage/logs/laravel.log'],
    isDirMissing: false,
  })
  expect(machineLines(vitals)).toEqual(['процессор 25% · память 1,2 ГБ из 3,8 ГБ', 'диск сервера 93% · свободно 1,8 ГБ'])
  expect(alerts(vitals)).toEqual(['worker: остановлен', 'диск сервера заполнен на 93%'])
  expect(runtimeTitle(vitals)).toBe('Docker Compose')
  expect(logSources(vitals)).toBe('docker web, worker, storage/logs/laravel.log')
  expect(serviceLine(vitals.services[0]!)).toBe('контейнер · работает')
})

test('the project\'s pm2 process and nginx are its own; with no container of its own that is said', () => {
  const vitals = parseVitals(ACME)
  expect(shownServices(vitals).map(serviceLine)).toEqual(['pm2 · работает · v1.4.0 · перезапусков 3', 'работает'])
  expect(shownServices(vitals).map(one => one.name)).toEqual(['acme', 'nginx'])
  expect(hasNoContainers(vitals)).toBe(true)
  expect(runtimeTitle(vitals)).toBe('pm2')
  expect(alerts(vitals)).toEqual([])
  expect(machineLines(vitals)[1]).toBe('диск сервера 84% · свободно 6,2 ГБ')
  expect(logSources(vitals)).toBe('pm2 acme')
})

test('pm2 processes come with their version and restarts, and a bare server still reads', () => {
  const pm2 = parseVitals('pm2=api|online|4|2.0.1\npm2=cron|errored|12|N/A\n')
  expect(pm2.runtime).toBe('pm2')
  expect(pm2.services.map(stateWord)).toEqual(['работает · v2.0.1 · перезапусков 4', 'упал · перезапусков 12'])
  expect(alerts(pm2)).toEqual(['cron: упал · перезапусков 12'])
  // No Docker on the server: nothing said about containers.
  expect(hasNoContainers(pm2)).toBe(false)

  const bare = parseVitals('dir=missing\nload=\n')
  expect(bare.runtime).toBe('none')
  expect(bare.cpu).toBeNull()
  expect(machineLines(bare)).toEqual([])
  expect(alerts(bare)).toEqual(['папки проекта нет на сервере'])
  expect(logSources(bare)).toBe('nginx')
  expect(runtimeTitle(bare)).toBe('без Docker, pm2 и systemd')
})

test('systemd services started from the project folder are its services, their journal its logs', () => {
  const systemd = parseVitals('unit=shop-api|active\nunit=shop-worker|failed\nlogfile=logs/app.log\n')
  expect(systemd.services.map(serviceLine)).toEqual(['systemd · работает', 'systemd · упал'])
  expect(alerts(systemd)).toEqual(['shop-worker: упал'])
  expect(logSources(systemd)).toBe('journalctl shop-api, shop-worker, logs/app.log')
  expect(logsCommand(systemd, 60).startsWith("journalctl -n 60 --no-pager -u 'shop-api' -u 'shop-worker' 2>&1; ")).toBe(true)
})

test('nginx is shown while it runs or has fallen, never when switched off', () => {
  expect(parseVitals('nginx=failed').services.map(one => `${one.name}: ${stateWord(one)}`)).toEqual(['nginx: упал'])
  expect(alerts(parseVitals('nginx=failed'))).toEqual(['nginx: упал'])
  expect(parseVitals('nginx=inactive').services).toEqual([])
  expect(parseVitals('nginx=').services).toEqual([])
})

test('a check kept from before reads without the new fields', () => {
  const old = { ...parseVitals('ctr=web|running'), hasDocker: undefined } as unknown as Vitals
  expect(hasNoContainers(old)).toBe(false)
  expect(serviceLine({ name: 'web', state: 'running', restarts: null } as unknown as Service)).toBe('работает')
})

test('the check is one sh line that enters the folder itself, keeps other projects on the server and changes nothing', () => {
  const server: Server = { name: 'prod', host: '1.2.3.4', user: 'root', port: 22, dir: '~/my app' }
  const args = vitalsArgs(server)
  const command = args.at(-1) ?? ''
  // The folder is entered inside the check, so a missing one is reported, not fatal.
  expect(command.startsWith("sh -c 'D=; cd ~/")).toBe(true)
  expect(command).toContain('dir=missing')
  expect(command).not.toContain('\n')
  for (const word of [' rm ', 'docker restart', 'compose restart', 'systemctl restart', 'systemctl stop', 'systemctl start', 'prune', 'kill ', 'compose down', 'compose up', 'pm2 restart', 'pm2 stop']) {
    expect(command).not.toContain(word)
  }
  // Containers by the folder Compose started them from, pm2 by where it runs from: only those are printed.
  for (const part of ['com.docker.compose.project.working_dir', 'echo "ctr=$n|$s";; esac', 'if(under(e.pm_cwd)||under(e.pm_exec_path))console.log', 'pwd -P', 'systemctl is-active nginx']) {
    expect(command).toContain(part)
  }
  // Every stack's own log files are looked for in the project folder.
  for (const place of ['storage/logs/*.log', 'var/log/*.log', 'wp-content/debug.log', 'logs/*.log', '/etc/systemd/system/*.service', '/var/log/nginx/error.log']) {
    expect(command).toContain(place)
  }
  expect(vitalsScript(undefined).startsWith("sh -c 'D=; P=;")).toBe(true)

  const own = 'for f in $(ls -t storage/logs/*.log var/log/*.log wp-content/debug.log logs/*.log log/*.log *.log 2>/dev/null | head -n 3); do echo "== $f"; tail -n 60 "$f"; done'
  expect(logsCommand(parseVitals(COMPOSE), 60)).toBe(`docker logs --tail 60 'web' 2>&1; docker logs --tail 60 'worker' 2>&1; ${own}`)
  expect(logsCommand(parseVitals(ACME), 60)).toBe(`pm2 logs 'acme' --nostream --raw --lines 60 2>&1; ${own}`)
  expect(logsCommand(undefined, 60)).toBe(`tail -n 60 /var/log/nginx/error.log 2>/dev/null; ${own}`)
})
