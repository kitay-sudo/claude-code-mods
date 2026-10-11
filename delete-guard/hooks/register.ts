// delete-guard: stops every shell command that would delete files or folders,
// and lets it run only once the person has answered «да» to what it deletes.
//
// A command that deletes is refused, and the refusal the model reads lists
// each path with how many files it holds and how much they weigh, and tells
// the model to show that list and ask «Удалять?». The person's next prompt
// decides: «да» lets exactly that command through, once; anything else drops it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PendingDeletion } from '../types'
import { findDeletions, globToRegExp, resolvePath } from './parse'
import type { Deletion, PathContext, Shell } from './parse'

const MAX_DIRS = 3000
const BATCH = 16
const MAX_LINES = 40
const COMMAND_SHOWN = 300

const pending = atom({ plugin: 'delete-guard', key: 'pending' } as const, null)
const approved = atom({ plugin: 'delete-guard', key: 'approved' } as const, null)

// Prompts the person wrote: at the prompt, through Remote Control, or in the
// app hosting the session. Notifications, schedules, peers and plugins never
// answer for them.
const PERSON = new Set(['composer', 'bridge', 'sdk'])
const YES = /^\s*да(?:[\s,.!]+удал\S*)?[\s.!]*$/iu

const FAILED =
  'Сторож удаления не смог проверить эту команду и остановил её. ' +
  'Скажи пользователю, что команда удаляет файлы и сторож её не пропустил.'

type Measured = { text: string; files: number; bytes: number; isCounted: boolean; isCapped: boolean }

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100
  const ones = n % 10
  if (ones === 1 && tens !== 11) return one
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few
  return many
}

function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function formatFiles(n: number): string {
  return `${grouped(n)} ${plural(n, 'файл', 'файла', 'файлов')}`
}

function formatSize(bytes: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const shown = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace('.', ',')
  return `${shown} ${units[unit]}`
}

function counted(text: string, files: number, bytes: number, isCapped = false): Measured {
  return { text, files, bytes, isCounted: true, isCapped }
}

function uncounted(text: string): Measured {
  return { text, files: 0, bytes: 0, isCounted: false, isCapped: false }
}

async function walk($: EngineInterface, root: string, sep: string): Promise<{ files: number; bytes: number; isCapped: boolean }> {
  let files = 0
  let bytes = 0
  let dirs = 0
  let queue = [root]
  while (queue.length > 0) {
    if (dirs >= MAX_DIRS) return { files, bytes, isCapped: true }
    const batch = queue.slice(0, BATCH)
    queue = queue.slice(BATCH)
    dirs += batch.length
    const listed = await Promise.all(
      batch.map(dir => $.fs.list(dir).then(entries => ({ dir, entries }), () => ({ dir, entries: [] }))),
    )
    for (const { dir, entries } of listed) {
      for (const entry of entries) {
        if (entry.kind === 'dir' && !entry.isLink) {
          queue.push(`${dir}${sep}${entry.name}`)
        } else {
          files += 1
          bytes += entry.size
        }
      }
    }
  }
  return { files, bytes, isCapped: false }
}

async function measurePath($: EngineInterface, path: string, sep: string): Promise<Measured> {
  let stat
  try {
    stat = await $.fs.stat(path)
  } catch {
    return uncounted(`${path} — не найдено`)
  }
  if (stat.isLink) return counted(`${path} — ссылка (удалится только она сама)`, 1, 0)
  if (stat.kind !== 'dir') return counted(`${path} — файл, ${formatSize(stat.size)}`, 1, stat.size)
  const tally = await walk($, path, sep)
  const more = tally.isCapped ? ' (это не всё: папка слишком большая, чтобы обойти её целиком)' : ''
  return counted(
    `${path} — папка: ${formatFiles(tally.files)}, ${formatSize(tally.bytes)}${more}`,
    tally.files,
    tally.bytes,
    tally.isCapped,
  )
}

async function measureGlob($: EngineInterface, dir: string, pattern: string, path: string, sep: string): Promise<Measured[]> {
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return [uncounted(`${path} — папка ${dir} не найдена`)]
  }
  const test = globToRegExp(pattern, sep === '\\')
  const matches = entries.filter(entry => test.test(entry.name))
  if (matches.length === 0) return [uncounted(`${path} — под шаблон ничего не подходит`)]
  const base = dir.endsWith(sep) ? dir : `${dir}${sep}`
  return Promise.all(matches.map(entry => measurePath($, `${base}${entry.name}`, sep)))
}

async function describeDeletions($: EngineInterface, deletions: readonly Deletion[], command: string): Promise<string> {
  // The variables a path may use that the guard expands; any other stays unknown.
  const [cwd, userProfile, home, temp, tmp, appData, localAppData] = await Promise.all([
    $.session.cwd(),
    $.env.get('USERPROFILE'),
    $.env.get('HOME'),
    $.env.get('TEMP'),
    $.env.get('TMP'),
    $.env.get('APPDATA'),
    $.env.get('LOCALAPPDATA'),
  ])
  const env = new Map(
    Object.entries({ USERPROFILE: userProfile, HOME: home, TEMP: temp, TMP: tmp, APPDATA: appData, LOCALAPPDATA: localAppData }),
  )
  const ctx: PathContext = { cwd, env: name => env.get(name) }
  const sep = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? '\\' : '/'

  const seen = new Set<string>()
  const lines: Measured[] = []
  for (const ref of deletions.flatMap(deletion => deletion.paths)) {
    const where = resolvePath(ref, ctx)
    const key = where.kind === 'unknown' ? `?${where.text}` : where.path
    if (seen.has(key)) continue
    seen.add(key)
    try {
      if (where.kind === 'unknown') lines.push(uncounted(`${where.text} — не удалось определить заранее`))
      else if (where.kind === 'glob') lines.push(...(await measureGlob($, where.dir, where.pattern, where.path, sep)))
      else lines.push(await measurePath($, where.path, sep))
    } catch {
      lines.push(uncounted(`${ref.text} — не удалось посчитать`))
    }
  }
  const notes = [...new Set(deletions.flatMap(deletion => deletion.notes))]

  const shownCommand = command.length > COMMAND_SHOWN ? `${command.slice(0, COMMAND_SHOWN)}…` : command
  const out = [
    'Сторож удаления остановил эту команду: без ответа пользователя «да» она не выполнится.',
    '',
    `Команда: ${shownCommand}`,
  ]
  if (lines.length > 0) {
    out.push('', 'Удалится:')
    for (const line of lines.slice(0, MAX_LINES)) out.push(`• ${line.text}`)
    if (lines.length > MAX_LINES) out.push(`• …и ещё ${lines.length - MAX_LINES}`)
    const total = lines.filter(line => line.isCounted)
    if (total.length > 0) {
      const files = total.reduce((sum, line) => sum + line.files, 0)
      const bytes = total.reduce((sum, line) => sum + line.bytes, 0)
      const isPartial = total.length < lines.length || total.some(line => line.isCapped) || notes.length > 0
      out.push(`Итого: ${formatFiles(files)}, ${formatSize(bytes)}${isPartial ? ' (без того, что не удалось посчитать)' : ''}`)
    }
  }
  if (notes.length > 0) {
    out.push('', 'Заранее не посчитать:')
    for (const note of notes) out.push(`• ${note}`)
  }
  out.push(
    '',
    'Покажи пользователю этот список целиком, спроси «Удалять?» и на этом закончи ответ. ' +
      'Если пользователь ответит «да», повтори ровно ту же команду, ничего в ней не меняя. ' +
      'Не пытайся удалить это другим способом.',
  )
  return out.join('\n')
}

// Undefined lets the command run; a string is why it is stopped.
async function guard($: EngineInterface, tool: string, command: string, shell: Shell): Promise<string | undefined> {
  const deletions = findDeletions(command, shell)
  if (deletions.length === 0) return undefined
  const key = command.trim()
  const allowed = await read($, approved)
  if (allowed !== null && allowed.tool === tool && allowed.command === key) {
    await update($, approved, () => null)
    return undefined
  }
  const asked: PendingDeletion = { tool, command: key }
  await update($, pending, () => asked)
  try {
    return await describeDeletions($, deletions, key)
  } catch (error) {
    return `${FAILED}\n\nКоманда: ${key}\nПочему не посчитать: ${String(error)}\n\nСпроси «Удалять?». Если пользователь ответит «да», повтори ровно ту же команду.`
  }
}

async function answer($: EngineInterface, text: string, origin: string): Promise<void> {
  const asked = await read($, pending)
  if (!PERSON.has(origin)) {
    if (asked !== null && YES.test(text)) {
      $.ui.log(`Сторож удаления: «да» пришло не от тебя (${origin}), удаление не разрешено.`)
    }
    return
  }
  await update($, pending, () => null)
  await update($, approved, () => (asked !== null && YES.test(text) ? asked : null))
}

async function forget($: EngineInterface): Promise<void> {
  await update($, pending, () => null)
  await update($, approved, () => null)
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await guard($, e.tool, e.command, 'bash')
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) =>
    next.called ? next(e) : findDeletions(e.command, 'bash').length > 0 ? { deny: FAILED } : next(e),
  )

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const deny = await guard($, e.tool, e.command, 'powershell')
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) =>
    next.called ? next(e) : findDeletions(e.command, 'powershell').length > 0 ? { deny: FAILED } : next(e),
  )

  on('prompt.submit', async ($, e, next) => {
    await answer($, e.text, e.origin.kind)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await forget($)
    return next(e)
  })
}
