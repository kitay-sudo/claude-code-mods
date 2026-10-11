import { expect, test } from 'claude-code/testing'

import { checkServer, connectHint, connectScript, dangers, encodePowerShell, formatOutput, isPush, parseAddress, quote, sshArgs } from '../hooks/ssh'
import type { Server } from '../types'

const PROD: Server = { name: 'prod', host: '1.2.3.4', user: 'root', port: 22, dir: '~/app' }

test('a server record is checked field by field', () => {
  expect(checkServer({ name: 'prod', host: '1.2.3.4', user: 'root', dir: '~/app', deploy: 'git pull && docker compose up -d' })).toEqual({
    server: { name: 'prod', host: '1.2.3.4', user: 'root', port: 22, dir: '~/app', deploy: 'git pull && docker compose up -d' },
  })
  expect(checkServer({ name: 'stage', host: 'stage.example.com', user: 'deploy', port: 2222 })).toEqual({
    server: { name: 'stage', host: 'stage.example.com', user: 'deploy', port: 2222 },
  })
  for (const bad of [
    { name: 'prod', host: '-oProxyCommand=calc', user: 'root' },
    { name: 'prod', host: '1.2.3.4', user: 'root;id' },
    { name: 'my prod', host: '1.2.3.4', user: 'root' },
    { name: 'prod', host: '1.2.3.4', user: 'root', port: 70000 },
    { name: 'prod', host: '1.2.3.4', user: 'root', key: '-i other' },
    { name: 'prod', host: '1.2.3.4', user: 'root', deploy: 'git pull\nrm -rf /' },
  ]) {
    expect('error' in checkServer(bad)).toBe(true)
  }
})

test('the command reaches the server folder, the home part left for the remote shell', () => {
  expect(sshArgs(PROD, 'docker compose ps')).toEqual([
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-p', '22',
    '--',
    'root@1.2.3.4',
    "cd ~/'app' && docker compose ps",
  ])
  expect(sshArgs({ ...PROD, dir: '/var/www/my app', key: 'C:\\keys\\prod' }, 'ls').slice(-5)).toEqual([
    '-i', 'C:\\keys\\prod', '--', 'root@1.2.3.4', "cd '/var/www/my app' && ls",
  ])
  expect(quote("it's")).toBe(`'it'\\''s'`)
})

test('risky commands are named for the confirm dialog', () => {
  expect(dangers('rm -rf /var/www/old')).toContain('удаляет файлы')
  expect(dangers('docker system prune -af')).toContain('удаляет контейнеры, образы или тома Docker')
  expect(dangers('sudo reboot')).toContain('перезагружает или выключает сервер')
  expect(dangers('psql -c "DROP TABLE users"')).toContain('удаляет данные в базе')
  expect(dangers('docker compose ps && git log -1')).toEqual([])
})

test('output is cut in the middle when long, and a refused login says what to do', () => {
  const long = 'x'.repeat(20_000)
  const shown = formatOutput(0, long, '')
  expect(shown).toContain('exit code: 0')
  expect(shown).toContain('пропущено 4000 символов')
  expect(formatOutput(1, '', '')).toContain('(вывода нет)')
  expect(connectHint(PROD, 'root@1.2.3.4: Permission denied (publickey,password).')).toContain('ssh-keygen -t ed25519')
  expect(connectHint(PROD, 'ssh: connect to host 1.2.3.4 port 22: Connection timed out')).toContain('не достучаться')
  expect(connectHint(PROD, 'bash: foo: command not found')).toBeUndefined()
})

test('the form reads an address the way people write it', () => {
  expect(parseAddress('root@1.2.3.4')).toEqual({ user: 'root', host: '1.2.3.4', port: 22 })
  expect(parseAddress('deploy@host.example.com:2201')).toEqual({ user: 'deploy', host: 'host.example.com', port: 2201 })
  expect(parseAddress('ssh root@5.6.7.8 -p 2200')).toEqual({ user: 'root', host: '5.6.7.8', port: 2200 })
  expect('error' in parseAddress('1.2.3.4')).toBe(true)
  expect('error' in parseAddress('root@-oProxyCommand=calc')).toBe(true)
})

test('a git push is told from commands that only mention it', () => {
  expect(isPush('git push origin main')).toBe(true)
  expect(isPush('git add -A && git commit -m "fix" && git push')).toBe(true)
  expect(isPush('git -C app push')).toBe(true)
  expect(isPush('git push --dry-run')).toBe(false)
  expect(isPush('echo git pushed')).toBe(false)
})

test('the connect window gets its script as PowerShell reads -EncodedCommand', () => {
  expect(encodePowerShell('ab')).toBe('YQBiAA==')
  expect(encodePowerShell('я')).toBe('TwQ=')
  const script = connectScript({ ...PROD, port: 2222 }, "C:\\Users\\o'neil\\.ssh\\server_panel_ed25519.pub")
  expect(script).toContain("Get-Content -Raw 'C:\\Users\\o''neil\\.ssh\\server_panel_ed25519.pub' | ssh -o StrictHostKeyChecking=accept-new -p 2222 root@1.2.3.4 ")
  expect(script).not.toContain('"')
})
