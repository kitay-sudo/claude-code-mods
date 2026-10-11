import { expect, test } from 'claude-code/testing'

import { alerts, logSources, logsCommand, machineLines, parseVitals, shownServices, stateWord, vitalsArgs, vitalsScript } from '../hooks/vitals'
import type { Server } from '../types'

const COMPOSE = [
  'load=0.50',
  'cpus=2',
  'mem=1229/3891',
  'disk=93/1843',
  'kind=compose',
  'svc=web|running|',
  'svc=worker|exited|',
  'logfile=storage/logs/laravel.log',
  'err=\u001b[31m2026-10-11 12:03 ERROR\u001b[0m   connection refused to db:5432',
  'err=Traceback (most recent call last):',
].join('\n')

test('one check reads the machine, the services, the log files and their errors', () => {
  const vitals = parseVitals(COMPOSE)
  expect(vitals).toEqual({
    cpu: 25,
    memUsedMb: 1229,
    memTotalMb: 3891,
    diskPercent: 93,
    diskFreeMb: 1843,
    runtime: 'compose',
    services: [
      { name: 'web', state: 'running', restarts: null },
      { name: 'worker', state: 'exited', restarts: null },
    ],
    errors: ['2026-10-11 12:03 ERROR connection refused to db:5432', 'Traceback (most recent call last):'],
    logFiles: ['storage/logs/laravel.log'],
    isDirMissing: false,
  })
  expect(machineLines(vitals)).toEqual(['процессор 25% · память 1,2 ГБ из 3,8 ГБ', 'диск 93% · свободно 1,8 ГБ'])
  expect(alerts(vitals)).toEqual(['worker: остановлен', 'диск заполнен на 93%'])
  expect(logSources(vitals)).toBe('Docker Compose, storage/logs/laravel.log')
})

test('pm2 processes come with their restarts, and a bare server still reads', () => {
  const pm2 = parseVitals('kind=pm2\nsvc=api|online|4\nsvc=cron|errored|12\n')
  expect(pm2.runtime).toBe('pm2')
  expect(pm2.services.map(stateWord)).toEqual(['работает · перезапусков 4', 'упал · перезапусков 12'])
  expect(alerts(pm2)).toEqual(['cron: упал · перезапусков 12'])

  const bare = parseVitals('dir=missing\nload=\nkind=none\n')
  expect(bare.runtime).toBe('none')
  expect(bare.cpu).toBeNull()
  expect(machineLines(bare)).toEqual([])
  expect(alerts(bare)).toEqual(['папки проекта нет на сервере'])
  expect(logSources(bare)).toBe('nginx')
})

test('systemd services started from the project folder are its services, their journal its logs', () => {
  const systemd = parseVitals('kind=systemd\nsvc=shop-api|active|\nsvc=shop-worker|failed|\nlogfile=logs/app.log\n')
  expect(systemd.services.map(stateWord)).toEqual(['работает', 'упал'])
  expect(alerts(systemd)).toEqual(['shop-worker: упал'])
  expect(logSources(systemd)).toBe('journalctl shop-api, shop-worker, logs/app.log')
  expect(logsCommand('systemd', 60, ['shop-api', 'shop-worker']).startsWith("journalctl -n 60 --no-pager -u 'shop-api.service' -u 'shop-worker.service' 2>&1; ")).toBe(true)
})

test('without a Compose project, stopped containers of the machine are not the project\'s alarm', () => {
  const docker = parseVitals('kind=docker\nsvc=app|running|\nsvc=old-db|exited|\nsvc=queue|restarting|\n')
  expect(shownServices(docker).map(service => service.name)).toEqual(['app', 'queue'])
  expect(alerts(docker)).toEqual(['queue: перезапускается'])
  // In a Compose project every service is the project's own.
  const compose = parseVitals('kind=compose\nsvc=app|running|\nsvc=worker|exited|\n')
  expect(shownServices(compose).map(service => service.name)).toEqual(['app', 'worker'])
  expect(alerts(compose)).toEqual(['worker: остановлен'])
})

test('the check is one sh line that enters the folder itself and changes nothing', () => {
  const server: Server = { name: 'prod', host: '1.2.3.4', user: 'root', port: 22, dir: '~/my app' }
  const args = vitalsArgs(server)
  const command = args.at(-1) ?? ''
  // The folder is entered inside the check, so a missing one is reported, not fatal.
  expect(command.startsWith("sh -c 'D=; cd ~/")).toBe(true)
  expect(command).toContain('dir=missing')
  expect(command).not.toContain('\n')
  for (const word of [' rm ', 'docker restart', 'compose restart', 'systemctl restart', 'systemctl stop', 'systemctl start', 'prune', 'kill ', 'compose down', 'compose up']) {
    expect(command).not.toContain(word)
  }
  // Every stack's own log files are looked for in the project folder.
  for (const place of ['storage/logs/*.log', 'var/log/*.log', 'wp-content/debug.log', 'logs/*.log', '/etc/systemd/system/*.service', '/var/log/nginx/error.log']) {
    expect(command).toContain(place)
  }
  expect(vitalsScript(undefined).startsWith("sh -c 'D=; echo")).toBe(true)

  const own = 'for f in $(ls -t storage/logs/*.log var/log/*.log wp-content/debug.log logs/*.log log/*.log *.log 2>/dev/null | head -n 3); do echo "== $f"; tail -n 60 "$f"; done'
  expect(logsCommand('compose', 60)).toBe(`docker compose logs --tail 60 --no-color 2>&1; ${own}`)
  expect(logsCommand('pm2', 60)).toBe(`pm2 logs --nostream --raw --lines 60 2>&1; ${own}`)
  expect(logsCommand('none', 60)).toBe(`tail -n 60 /var/log/nginx/error.log 2>/dev/null; ${own}`)
  // systemd without its units found: the project's own files alone.
  expect(logsCommand('systemd', 60, [])).toBe(own)
})
