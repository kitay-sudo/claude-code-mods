import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The disk beneath the plugin: a build folder of two files, 2,4 МБ together.
const DISK: Record<string, { kind: 'file' | 'dir'; size: number }> = {
  'C:\\proj\\build': { kind: 'dir', size: 0 },
  'C:\\proj\\build\\a.js': { kind: 'file', size: 1_500 },
  'C:\\proj\\build\\sub': { kind: 'dir', size: 0 },
  'C:\\proj\\build\\sub\\b.js': { kind: 'file', size: 2_500_000 },
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('\\'))

function world(on: On) {
  const ran: string[] = []
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.stat', ($, e) => {
    const entry = DISK[e.path]
    return entry === undefined ? { deny: 'ENOENT' } : { value: { ...entry, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', ($, e) => ({
    value: Object.entries(DISK)
      .filter(([path]) => parentOf(path) === e.path)
      .map(([path, entry]) => ({ name: path.slice(e.path.length + 1), ...entry, mtimeMs: 0, isLink: false })),
  }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.log', () => ({ value: undefined }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' || e.tool === 'PowerShell') ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  return { ran }
}

const RM = { tool: 'Bash', command: 'rm -rf build' } as const

test('a deletion shows what it deletes and waits for «да», then runs once', async ($, on) => {
  const { ran } = world(on)

  const stopped = await $.tool.call(RM)
  expect(stopped.deny).toContain('• C:\\proj\\build — папка: 2 файла, 2,4 МБ')
  expect(stopped.deny).toContain('Итого: 2 файла, 2,4 МБ')
  expect(stopped.deny).toContain('спроси «Удалять?»')
  expect(ran).toEqual([])

  await $.prompt.submit({ text: 'Да', wait: false, origin: { kind: 'composer' } })
  const allowed = await $.tool.call(RM)
  expect(allowed.deny).toBeUndefined()
  expect(ran).toEqual(['rm -rf build'])

  const again = await $.tool.call(RM)
  expect(again.deny).toBeDefined()
  expect(ran).toEqual(['rm -rf build'])
})

test('anything but the person’s «да» keeps it stopped', async ($, on) => {
  const { ran } = world(on)

  await $.tool.call(RM)
  await $.prompt.submit({ text: 'нет, оставь', wait: false, origin: { kind: 'composer' } })
  expect((await $.tool.call(RM)).deny).toBeDefined()

  await $.prompt.submit({ text: 'да', wait: false, origin: { kind: 'plugin', name: 'other' } })
  expect((await $.tool.call(RM)).deny).toBeDefined()

  await $.prompt.submit({ text: 'да', wait: false, origin: { kind: 'sdk' } })
  expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf build dist' })).deny).toBeDefined()
  expect(ran).toEqual([])
})

test('commands that delete nothing run untouched', async ($, on) => {
  const { ran } = world(on)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls -la build' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'PowerShell', command: 'Get-ChildItem build' })).deny).toBeUndefined()
  expect(ran).toEqual(['ls -la build', 'Get-ChildItem build'])
})

test('a missing path and an unknown one are named as such', async ($, on) => {
  world(on)
  const stopped = await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item gone.txt, $target' })
  expect(stopped.deny).toContain('• C:\\proj\\gone.txt — не найдено')
  expect(stopped.deny).toContain('• $target — не удалось определить заранее')
})
