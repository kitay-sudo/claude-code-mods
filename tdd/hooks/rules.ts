// tdd: the rules a project is asked to follow, and how a file or a command is told
// apart. Plain data, no `$`, so tests read it directly.
//
// "Добавить в проект" writes RULES_TEXT between two markers into the project's
// CLAUDE.md. Claude Code reads that file in every session, so from then on the
// agent works that way in the project, with or without this mod, and the person
// can read and edit the text. "Убрать из проекта" takes the block out again.

export const START = '<!-- tdd-rules:start -->'
export const END = '<!-- tdd-rules:end -->'

export const RULES_TEXT = [
  '## Как работать с кодом (тесты до кода)',
  '',
  'Этот блок добавлен модом tdd. Его можно править, а убрать целиком можно кнопкой "Убрать из проекта".',
  '',
  '1. Сначала тест, потом код. Для каждого изменения поведения сначала напиши тест, который падает, и только потом минимальный код, чтобы он прошёл. Один маленький шаг за раз.',
  '2. Тест проверяет поведение через публичный интерфейс, а не внутреннее устройство. Ожидаемое значение берётся из условия задачи, а не считается тем же способом, что и в коде.',
  '3. Перед словами "готово" прогони все тесты проекта и скажи итог одной строкой. Не ломай старые тесты ради новых.',
  '4. Три красных прогона подряд: остановись и объясни, что не получается. Не ослабляй и не удаляй тест, чтобы он прошёл, не добавляй паузы и повторы.',
  '5. Безопасный код с самого начала: проверяй входные данные, запросы к базе только с параметрами, не клади ключи и пароли в код, проверяй права доступа.',
  '6. Если тест для задачи не нужен (текст, стили, разметка), так и скажи и пропусти его.',
].join('\n')

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** The block as written to the file: the rules between the two markers. */
export function ruleBlock(eol = '\n'): string {
  return `${START}${eol}${RULES_TEXT.replace(/\n/g, eol)}${eol}${END}`
}

export function hasRule(text: string): boolean {
  const start = text.indexOf(START)
  return start !== -1 && text.indexOf(END, start) !== -1
}

/** The text with the block in it: appended to the end, or the old block refreshed in place. */
export function addRule(text: string): string {
  const eol = eolOf(text)
  const block = ruleBlock(eol)
  if (hasRule(text)) {
    const start = text.indexOf(START)
    const end = text.indexOf(END, start) + END.length
    return `${text.slice(0, start)}${block}${text.slice(end)}`
  }
  const base = text.replace(/\s+$/, '')
  return base === '' ? `${block}${eol}` : `${base}${eol}${eol}${block}${eol}`
}

/** The text without the block and the blank lines around it; '' when nothing else was there. */
export function removeRule(text: string): string {
  if (!hasRule(text)) return text
  const eol = eolOf(text)
  const start = text.indexOf(START)
  const end = text.indexOf(END, start) + END.length
  const before = text.slice(0, start).replace(/\s+$/, '')
  const after = text.slice(end).replace(/^\s+/, '').replace(/\s+$/, '')
  const joined = [before, after].filter(part => part !== '').join(eol + eol)
  return joined === '' ? '' : `${joined}${eol}`
}

// A test file: in a tests folder, or named like one.
const TEST_PATH = /(^|[\\/])(tests?|__tests__|specs?|e2e)[\\/]|[._-](test|spec)\.[a-z0-9]+$|(^|[\\/])test_[^\\/]*\.py$|_test\.(go|py|rs)$/i
const CODE_FILE = /\.(?:m?js|cjs|jsx?|tsx?|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp|swift|sh|ps1)$/i
// What is not the project's own code: dependencies, build output, typings, the tool's own files.
const NOT_CODE = /(^|[\\/])(node_modules|dist|build|out|coverage|vendor|\.git|\.claude)[\\/]|\.d\.ts$/i

export function isTestFile(path: string): boolean {
  return TEST_PATH.test(path)
}

/** A source file of the project that is not a test: what the gate asks a test for. */
export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path) && !NOT_CODE.test(path) && !isTestFile(path)
}

const TEST_COMMAND =
  /(^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check)\b|\bnode\s+(?:--[\w=-]+\s+)*--test\b|\b(?:pytest|py\.test|vitest|jest|mocha|phpunit|rspec|ctest)\b|\b(?:dotnet|go|cargo|mvn|gradle)\s+test\b|\bclaude\s+plugin\s+test\b|check\.ps1/i

/** A command that runs the project's tests. */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

// `git` starts the command or follows a separator, so a mention ("echo git commit") is not a commit.
const COMMIT =
  /(^|[;&|(])\s*git\s+(?:(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?)\s+)*commit(?![\w-])/i

/** A command that makes a git commit. */
export function isCommitCommand(command: string): boolean {
  return COMMIT.test(command)
}

/** The project's test command as `package.json` names it, or null. */
export function testCommandOf(packageJson: string): string | null {
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts
    const test = scripts?.test
    // npm's placeholder for "no tests yet" is not a test command.
    if (typeof test !== 'string' || test.trim() === '' || /no test specified/i.test(test)) return null
    return 'npm test'
  } catch {
    return null
  }
}
