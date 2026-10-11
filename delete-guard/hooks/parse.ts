// Reads a shell command without running it and finds what it would delete.
//
// Best effort by design: it knows the usual delete commands of bash,
// PowerShell and cmd, the shells and interpreters they are run through, and
// leans towards reporting. What it cannot see ahead (a path in a variable, a
// pipeline, a find predicate, code) is reported as such, never let through.

export type Shell = 'bash' | 'powershell' | 'cmd'

/** A path a deletion names, as written, and the `cd` steps taken before it. */
export type PathRef = {
  text: string
  cwdSteps: readonly string[]
  shell: Shell
}

export type Deletion = {
  /** The word that deletes: `rm`, `Remove-Item`, `git clean`, ... */
  verb: string
  paths: PathRef[]
  /** What it deletes that cannot be counted ahead. */
  notes: string[]
}

export type PathContext = {
  /** The directory the command runs in, absolute. */
  cwd: string
  /** An environment variable by its upper-case name. */
  env: (name: string) => string | undefined
}

export type Resolved =
  | { kind: 'path'; path: string }
  | { kind: 'glob'; dir: string; pattern: string; path: string }
  | { kind: 'unknown'; text: string }

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'sep'; text: string }
  | { kind: 'redirect'; takesTarget: boolean }

type Segment = { words: string[]; before: string }

type Style = 'dash' | 'ps' | 'slash'

const SEPARATORS = new Set(['\n', ';', '&', '|', '(', ')', '{', '}'])
const PREFIXES = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'builtin', 'nice', 'env', 'xargs', 'call'])
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl'])
const DASH_DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'wipe', 'trash', 'trash-put', 'rimraf'])
const PS_DELETE = new Set(['remove-item', 'ri', 'rm', 'rmdir', 'del', 'erase', 'rd'])
const CMD_DELETE = new Set(['del', 'erase', 'rd', 'rmdir'])
const EMPTY_TRASH = new Set(['clear-recyclebin', 'trash-empty'])
const SH = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl'])
const CODE_FLAGS = new Set(['-c', '-e', '-E', '-p', '--eval', '--print'])
const CODE_DELETE =
  /shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)\b|\.unlink\(|\.rmdir\(|fs(?:Promises|\.promises)?\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b|rimraf|FileUtils\.rm|File\.delete|Remove-Item/
const DOTNET_DELETE = /\]::(?:Delete|DeleteFile|DeleteDirectory)$/i
const METHOD_DELETE = /\.(?:Delete|DeleteFile|DeleteDirectory)$/i
const PS_VALUE_PARAMS = [
  'path', 'literalpath', 'pspath', 'lp', 'filter', 'include', 'exclude', 'erroraction', 'ea',
  'warningaction', 'wa', 'informationaction', 'infa', 'errorvariable', 'ev', 'warningvariable', 'wv',
  'outvariable', 'ov', 'outbuffer', 'ob', 'pipelinevariable', 'pv', 'credential', 'stream', 'progressaction',
]
const PS_PATH_PARAMS = ['path', 'literalpath', 'pspath', 'lp']
const PS_SWITCHES = ['recurse', 'force', 'whatif', 'confirm', 'verbose', 'debug']
const PS_FILTERS = ['filter', 'include', 'exclude']
const POWERSHELL_VALUE_FLAGS = new Set([
  '-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-workingdirectory', '-wd', '-outputformat', '-of',
  '-inputformat', '-if', '-configurationname', '-psconsolefile', '-version', '-v', '-settingsfile',
])
const VARIABLE =
  /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g

function tokenize(src: string, shell: Shell): Token[] {
  const tokens: Token[] = []
  const escape = shell === 'bash' ? '\\' : shell === 'powershell' ? '`' : '^'
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  const at = (k: number) => src.charAt(k)
  let word = ''
  let inWord = false
  let i = 0

  const flush = () => {
    if (inWord) tokens.push({ kind: 'word', text: word })
    word = ''
    inWord = false
  }

  while (i < src.length) {
    const c = at(i)

    if (c === escape && i + 1 < src.length) {
      const isContinuation = at(i + 1) === '\n' || (at(i + 1) === '\r' && at(i + 2) === '\n')
      if (!isContinuation) {
        word += at(i + 1)
        inWord = true
      }
      i += at(i + 1) === '\r' ? 3 : 2
      continue
    }

    // PowerShell here-string: its lines are one literal word.
    if (shell === 'powershell' && c === '@' && (at(i + 1) === "'" || at(i + 1) === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 40))) {
      const end = src.indexOf(`\n${at(i + 1)}@`, i + 2)
      word += src.slice(src.indexOf('\n', i) + 1, end === -1 ? src.length : end)
      inWord = true
      i = end === -1 ? src.length : end + 3
      continue
    }

    if (c === "'" && shell !== 'cmd') {
      let j = i + 1
      for (; j < src.length; j++) {
        if (at(j) === "'") {
          if (shell === 'powershell' && at(j + 1) === "'") {
            word += "'"
            j++
            continue
          }
          break
        }
        word += at(j)
      }
      inWord = true
      i = j + 1
      continue
    }

    if (c === '"') {
      let j = i + 1
      for (; j < src.length && at(j) !== '"'; j++) {
        const d = at(j)
        const isEscape =
          j + 1 < src.length &&
          ((shell === 'bash' && d === '\\' && '$`"\\\n'.includes(at(j + 1))) || (shell === 'powershell' && d === '`'))
        if (isEscape) {
          word += at(j + 1)
          j++
          continue
        }
        word += d
      }
      inWord = true
      i = j + 1
      continue
    }

    if (c === '#' && !inWord && shell !== 'cmd') {
      while (i < src.length && at(i) !== '\n') i++
      continue
    }

    if (c === '$' && at(i + 1) === '{') {
      const end = src.indexOf('}', i)
      const stop = end === -1 ? src.length : end + 1
      word += src.slice(i, stop)
      inWord = true
      i = stop
      continue
    }

    if (c === '$' && at(i + 1) === '(') {
      flush()
      tokens.push({ kind: 'sep', text: '$(' })
      i += 2
      continue
    }

    if (c === '`' && shell === 'bash') {
      flush()
      tokens.push({ kind: 'sep', text: '`' })
      i++
      continue
    }

    if (c === '<' || c === '>') {
      // A file descriptor written before the operator (2>, *>) is no word.
      if (inWord && /^(\d+|\*)$/.test(word)) {
        word = ''
        inWord = false
      } else {
        flush()
      }
      let j = i + 1
      if (at(j) === c) j++
      const isHeredoc = shell === 'bash' && c === '<' && j === i + 2 && at(j) !== '<'
      if (c === '<' && at(j) === '<') j++
      if (isHeredoc) {
        let k = j
        const stripTabs = at(k) === '-'
        if (stripTabs) k++
        while (at(k) === ' ' || at(k) === '\t') k++
        let delimiter = ''
        for (; k < src.length && !/[\s;&|<>()]/.test(at(k)); k++) {
          if (!`'"\\`.includes(at(k))) delimiter += at(k)
        }
        if (delimiter !== '') heredocs.push({ delimiter, stripTabs })
        tokens.push({ kind: 'redirect', takesTarget: false })
        i = k
        continue
      }
      let takesTarget = true
      if (at(j) === '&') {
        j++
        while (j < src.length && /[0-9-]/.test(at(j))) j++
        takesTarget = false
      }
      tokens.push({ kind: 'redirect', takesTarget })
      i = j
      continue
    }

    // A line that opened here-documents: their bodies are text, not commands.
    if (c === '\n' && heredocs.length > 0) {
      flush()
      tokens.push({ kind: 'sep', text: '\n' })
      let k = i + 1
      for (const doc of heredocs) {
        while (k < src.length) {
          const eol = src.indexOf('\n', k)
          const line = src.slice(k, eol === -1 ? src.length : eol).replace(/\r$/, '')
          k = eol === -1 ? src.length : eol + 1
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
        }
      }
      heredocs.length = 0
      i = k
      continue
    }

    if (SEPARATORS.has(c)) {
      flush()
      tokens.push({ kind: 'sep', text: c })
      i++
      continue
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      flush()
      i++
      continue
    }

    word += c
    inWord = true
    i++
  }
  flush()
  return tokens
}

function segmentsOf(tokens: Token[]): Segment[] {
  const list: Segment[] = []
  let current: Segment = { words: [], before: '' }
  let skipsTarget = false
  for (const token of tokens) {
    if (token.kind === 'sep') {
      list.push(current)
      current = { words: [], before: token.text }
      skipsTarget = false
    } else if (token.kind === 'redirect') {
      skipsTarget = token.takesTarget
    } else if (skipsTarget) {
      skipsTarget = false
    } else {
      current.words.push(token.text)
    }
  }
  list.push(current)
  return list
}

function verbOf(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

function isPsValueParam(name: string): boolean {
  if (PS_VALUE_PARAMS.includes(name)) return true
  return name.length >= 3 && PS_VALUE_PARAMS.some(p => p.startsWith(name)) && !PS_SWITCHES.some(s => s.startsWith(name))
}

function isPsPathParam(name: string): boolean {
  return PS_PATH_PARAMS.includes(name) || (name.length >= 3 && ['path', 'literalpath', 'pspath'].some(p => p.startsWith(name)))
}

function argPaths(args: readonly string[], style: Style): string[] {
  const paths: string[] = []
  let isOptionsEnd = false
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] ?? ''
    if (style === 'dash') {
      if (!isOptionsEnd && arg === '--') isOptionsEnd = true
      else if (!isOptionsEnd && arg.length > 1 && arg.startsWith('-')) continue
      else paths.push(arg)
    } else if (style === 'slash') {
      if (!/^\/[A-Za-z?](:.*)?$/.test(arg)) paths.push(arg)
    } else if (arg.length > 1 && arg.startsWith('-')) {
      if (arg.includes(':')) continue
      const name = arg.slice(1).toLowerCase()
      if (!isPsValueParam(name)) continue
      const value = args[k + 1]
      k++
      if (value !== undefined && isPsPathParam(name)) paths.push(...value.split(','))
    } else {
      paths.push(...arg.split(','))
    }
  }
  return paths.map(p => p.trim()).filter(p => p !== '')
}

function deleteStyle(verb: string, shell: Shell): Style | null {
  if (shell === 'cmd' && CMD_DELETE.has(verb)) return 'slash'
  if (shell === 'powershell' && PS_DELETE.has(verb)) return 'ps'
  if (DASH_DELETE.has(verb)) return 'dash'
  if (PS_DELETE.has(verb)) return 'ps'
  return null
}

function cdStyle(verb: string, shell: Shell): Style {
  if (verb === 'set-location' || verb === 'sl' || shell === 'powershell') return 'ps'
  return shell === 'cmd' ? 'slash' : 'dash'
}

// -EncodedCommand is base64 of UTF-16LE text.
function decodeUtf16Base64(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text.replace(/[^A-Za-z0-9+/]/g, '')) {
    buffer = (buffer << 6) | alphabet.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  let out = ''
  for (let k = 0; k + 1 < bytes.length; k += 2) out += String.fromCharCode((bytes[k] ?? 0) | ((bytes[k + 1] ?? 0) << 8))
  return out
}

function refs(paths: readonly string[], cwdSteps: readonly string[], shell: Shell): PathRef[] {
  return paths.map(text => ({ text, cwdSteps: [...cwdSteps], shell }))
}

function gitDeletions(args: readonly string[], cwdSteps: readonly string[], shell: Shell): Deletion[] {
  const steps = [...cwdSteps]
  let k = 0
  while (k < args.length && (args[k] ?? '').startsWith('-')) {
    const arg = args[k] ?? ''
    if (arg === '-C' && args[k + 1] !== undefined) steps.push(args[k + 1] ?? '')
    k += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(arg) ? 2 : 1
  }
  const sub = args[k]
  const rest = args.slice(k + 1)
  const isDryRun = rest.some(a => a === '--dry-run' || /^-[A-Za-z]*n[A-Za-z]*$/.test(a))

  if (sub === 'rm') {
    if (rest.includes('--cached') || isDryRun) return []
    return [{ verb: 'git rm', paths: refs(argPaths(rest, 'dash'), steps, shell), notes: [] }]
  }
  if (sub === 'clean') {
    if (isDryRun) return []
    const scope = argPaths(rest.filter((a, i) => a !== '-e' && rest[i - 1] !== '-e'), 'dash')
    const withIgnored = rest.some(a => /^-[A-Za-z]*[xX]/.test(a))
    return [
      {
        verb: 'git clean',
        paths: [],
        notes: [
          `git clean удалит неотслеживаемые файлы${withIgnored ? ', и игнорируемые тоже,' : ''}` +
            `${scope.length > 0 ? ` в ${scope.join(', ')}` : ''}; точный список покажет та же команда с флагом -n`,
        ],
      },
    ]
  }
  if (sub === 'worktree' && rest[0] === 'remove') {
    return [{ verb: 'git worktree remove', paths: refs(argPaths(rest.slice(1), 'dash'), steps, shell), notes: [] }]
  }
  return []
}

function powershellDeletions(args: readonly string[], cwdSteps: readonly string[], depth: number): Deletion[] {
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] ?? ''
    const flag = arg.toLowerCase()
    if (!flag.startsWith('-')) return analyze(args.slice(k).join(' '), 'powershell', [...cwdSteps], depth + 1)
    if (flag.length >= 2 && '-command'.startsWith(flag)) {
      return analyze(args.slice(k + 1).join(' '), 'powershell', [...cwdSteps], depth + 1)
    }
    if (flag === '-e' || flag === '-ec' || (flag.length >= 4 && '-encodedcommand'.startsWith(flag))) {
      return analyze(decodeUtf16Base64(args[k + 1] ?? ''), 'powershell', [...cwdSteps], depth + 1)
    }
    if (flag.length >= 2 && '-file'.startsWith(flag)) return []
    if (POWERSHELL_VALUE_FLAGS.has(flag)) k++
  }
  return []
}

function commandDeletions(
  words: readonly string[],
  shell: Shell,
  cwdSteps: string[],
  pipedFrom: string | null,
  depth: number,
): Deletion[] {
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (shell === 'bash' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++
    } else if (PREFIXES.has(verbOf(word))) {
      i++
      while (i < words.length && (words[i] ?? '').startsWith('-')) i++
    } else {
      break
    }
  }
  const head = words[i]
  if (head === undefined) return []
  const verb = verbOf(head)
  const args = words.slice(i + 1)

  if (CD.has(verb)) {
    cwdSteps.push(argPaths(args, cdStyle(verb, shell))[0] ?? '~')
    return []
  }

  const style = deleteStyle(verb, shell)
  if (style !== null) {
    const paths = argPaths(args, style)
    const notes: string[] = []
    if (paths.length === 0) {
      notes.push(pipedFrom !== null ? `${head} получит пути от предыдущей команды: ${pipedFrom}` : `${head}: пути не указаны`)
    }
    if (style === 'ps' && args.some(a => PS_FILTERS.some(f => a.length > 2 && f.startsWith(a.slice(1).toLowerCase())))) {
      notes.push(`${head} с фильтром (-Filter, -Include или -Exclude): удалится только то, что под него подходит`)
    }
    return [{ verb: head, paths: refs(paths, cwdSteps, shell), notes }]
  }

  if (EMPTY_TRASH.has(verb)) return [{ verb: head, paths: [], notes: [`${head} безвозвратно очистит Корзину`] }]
  if (verb === 'git') return gitDeletions(args, cwdSteps, shell)

  if (verb === 'find') {
    const execAt = args.findIndex(a => ['-exec', '-execdir', '-ok', '-okdir'].includes(a))
    const execDeletes = execAt !== -1 && deleteStyle(verbOf(args[execAt + 1] ?? ''), shell) !== null
    if (!args.includes('-delete') && !execDeletes) return []
    const starts: string[] = []
    for (const arg of args) {
      if (arg.startsWith('-') || arg === '!' || arg === '(') break
      starts.push(arg)
    }
    const where = (starts.length > 0 ? starts : ['.']).join(', ')
    return [{ verb: 'find', paths: [], notes: [`find удалит то, что найдёт в ${where} по условию: ${args.slice(starts.length).join(' ')}`] }]
  }

  if (verb === 'rsync' && args.some(a => a.startsWith('--delete') || a === '--remove-source-files')) {
    const target = argPaths(args, 'dash').pop() ?? '?'
    return [{ verb: 'rsync', paths: [], notes: [`rsync удалит файлы в ${target}, которых нет в источнике`] }]
  }

  if (SH.has(verb)) {
    const at = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
    const script = at === -1 ? undefined : args[at + 1]
    return script === undefined ? [] : analyze(script, 'bash', [...cwdSteps], depth + 1)
  }
  if (verb === 'powershell' || verb === 'pwsh') return powershellDeletions(args, cwdSteps, depth)
  if (verb === 'cmd') {
    const at = args.findIndex(a => /^\/[ck]$/i.test(a))
    return at === -1 ? [] : analyze(args.slice(at + 1).join(' '), 'cmd', [...cwdSteps], depth + 1)
  }

  if (INTERPRETERS.has(verb)) {
    const at = args.findIndex(a => CODE_FLAGS.has(a))
    const hit = at === -1 ? null : CODE_DELETE.exec(args[at + 1] ?? '')
    if (hit === null) return []
    return [{ verb: head, paths: [], notes: [`${head} удаляет файлы прямо из кода (${hit[0]}); что именно, заранее не посчитать`] }]
  }

  return []
}

// .NET calls a PowerShell line can make anywhere in it, not only at its start.
function dotnetDeletions(segment: Segment, next: Segment | undefined, cwdSteps: readonly string[]): Deletion[] {
  const found: Deletion[] = []
  segment.words.forEach((word, k) => {
    if (DOTNET_DELETE.test(word)) {
      const isCalled = k === segment.words.length - 1 && next?.before === '('
      const arg = isCalled ? next?.words[0]?.replace(/,$/, '') : undefined
      found.push({
        verb: word,
        paths: arg === undefined ? [] : refs([arg], cwdSteps, 'powershell'),
        notes: arg === undefined ? [`${word}: путь заранее не определить`] : [],
      })
    } else if (METHOD_DELETE.test(word)) {
      found.push({ verb: word, paths: [], notes: [`${word}(): удаление через объект, что именно, заранее не определить`] })
    }
  })
  return found
}

function analyze(src: string, shell: Shell, cwdSteps: string[], depth: number): Deletion[] {
  if (depth > 4) return []
  const segments = segmentsOf(tokenize(src, shell))
  const found: Deletion[] = []
  segments.forEach((segment, index) => {
    const previous = segments[index - 1]
    const pipedFrom =
      segment.before === '|' && previous !== undefined && previous.words.length > 0 ? previous.words.join(' ') : null
    if (shell === 'powershell') found.push(...dotnetDeletions(segment, segments[index + 1], cwdSteps))
    found.push(...commandDeletions(segment.words, shell, cwdSteps, pipedFrom, depth))
  })
  return found
}

/** Every deletion the command would make, as far as it can be read ahead. */
export function findDeletions(command: string, shell: Shell): Deletion[] {
  return analyze(command, shell, [], 0)
}

function expand(text: string, ctx: PathContext): string | null {
  const home = ctx.env('USERPROFILE') ?? ctx.env('HOME')
  let out = text
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    if (home === undefined) return null
    out = home + out.slice(1)
  }
  out = out.replace(VARIABLE, (match: string, ...groups: unknown[]) => {
    const name = groups.slice(0, 5).find((group): group is string => typeof group === 'string')
    if (name === undefined || name === '_') return match
    const upper = name.toUpperCase()
    return (upper === 'HOME' ? (ctx.env('HOME') ?? home) : ctx.env(upper)) ?? match
  })
  if (out.includes('$') || /%[A-Za-z_][A-Za-z0-9_]*%/.test(out)) return null
  return out
}

function normalize(path: string, isWindows: boolean): string {
  const sep = isWindows ? '\\' : '/'
  let rest = path
  let root = ''
  if (isWindows) {
    const drive = /^[A-Za-z]:\\?/.exec(rest)
    if (rest.startsWith('\\\\')) {
      root = '\\\\'
      rest = rest.slice(2)
    } else if (drive !== null) {
      root = `${drive[0].charAt(0).toUpperCase()}:\\`
      rest = rest.slice(drive[0].length)
    }
  } else if (rest.startsWith('/')) {
    root = '/'
    rest = rest.slice(1)
  }
  const parts: string[] = []
  for (const part of rest.split(sep)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return root + parts.join(sep)
}

function locate(text: string, base: string, shell: Shell, ctx: PathContext, isWindows: boolean): string | null {
  const expanded = expand(text, ctx)
  if (expanded === null) return null
  if (!isWindows) return normalize(expanded.startsWith('/') ? expanded : `${base}/${expanded}`, false)

  const gitBashDrive = /^\/([A-Za-z])(\/|$)/.exec(expanded)
  // Git Bash's own paths (/tmp, /usr) map to folders it alone knows.
  if (gitBashDrive === null && expanded.startsWith('/') && shell === 'bash') return null
  const path =
    gitBashDrive !== null
      ? `${(gitBashDrive[1] ?? '').toUpperCase()}:\\${expanded.slice(3)}`.replace(/\//g, '\\')
      : expanded.replace(/\//g, '\\')
  if (/^[A-Za-z]:/.test(path) || path.startsWith('\\\\')) return normalize(path, true)
  if (path.startsWith('\\')) return normalize(base.slice(0, 2) + path, true)
  return normalize(`${base}\\${path}`, true)
}

/** Where a path a deletion names lies, a glob in its last part, or unknown. */
export function resolvePath(ref: PathRef, ctx: PathContext): Resolved {
  const isWindows = /^[A-Za-z]:[\\/]/.test(ctx.cwd) || ctx.cwd.startsWith('\\\\')
  const unknown: Resolved = { kind: 'unknown', text: ref.text }
  let base = normalize(isWindows ? ctx.cwd.replace(/\//g, '\\') : ctx.cwd, isWindows)
  for (const step of ref.cwdSteps) {
    const next = locate(step, base, ref.shell, ctx, isWindows)
    if (next === null || /[*?]/.test(next)) return unknown
    base = next
  }
  const path = locate(ref.text, base, ref.shell, ctx, isWindows)
  if (path === null) return unknown

  const sep = isWindows ? '\\' : '/'
  const cut = path.lastIndexOf(sep)
  const dir = cut <= (isWindows ? 2 : 0) ? path.slice(0, cut + 1) : path.slice(0, cut)
  const name = path.slice(cut + 1)
  if (/[*?]/.test(dir)) return unknown
  if (/[*?]/.test(name)) return { kind: 'glob', dir, pattern: name, path }
  return { kind: 'path', path }
}

/** A last-part glob (`*`, `?`) as a test of one directory entry's name. */
export function globToRegExp(pattern: string, isCaseless: boolean): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, isCaseless ? 'i' : '')
}
