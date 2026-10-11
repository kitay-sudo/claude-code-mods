// client-report: /report writes a report for the client about what was really
// done, from this conversation and the project's commits since the last
// report, in plain conversational words: no long dashes, straight quotes only,
// starting with 🪴. It opens in a pane with «Скопировать» in front, and the
// same rules reach the model whenever it writes to a client in the chat.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

import type { Report } from '../types'
import { STYLE_RULES, humanize, parseArgs, reportPrompt, rewritePrompt, utf16Base64 } from './style'
import type { ReportRequest } from './style'

const PANE = 'client-report'
const PANE_TITLE = 'Отчёт клиенту'
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS = 7
const OLDEST_DAYS = 31
const COMMITS_KEPT = 60

const CHAT_RULES = [
  'When the user asks for a report, an update or a message for a client in the chat (not through /report), follow these rules,',
  'and put the finished text in one ```text code block so it is copied with one press. The user can also run /report.',
  '',
  STYLE_RULES,
].join('\n')

const report = atom({ plugin: 'client-report', key: 'report' } as const, null)
const busy = atom({ plugin: 'client-report', key: 'busy' } as const, null)
const note = atom({ plugin: 'client-report', key: 'note' } as const, '')

async function storeKey($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  return `report:${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

function restoreReport(raw: unknown): Report | null {
  const kept = (raw ?? {}) as Partial<Report>
  if (typeof kept.text !== 'string' || kept.text === '' || !(Number(kept.at) > 0)) return null
  const at = Number(kept.at)
  const since = Number(kept.since)
  return { text: kept.text, at, period: typeof kept.period === 'string' ? kept.period : '', since: since > 0 && since <= at ? since : at, isEnglish: kept.isEnglish === true }
}

function shortDate(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getDate()).padStart(2, '0')}.${String(at.getMonth() + 1).padStart(2, '0')}`
}

function stamp(ms: number): string {
  const at = new Date(ms)
  return `${shortDate(ms)} в ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function isEnglish(text: string): boolean {
  return !/[а-яё]/i.test(text)
}

type Period = { since: number; words: string }

/** Since when the report runs: the last one's time, else a week back. */
function periodOf(last: Report | null, now: number): Period {
  if (last !== null && now - last.at < OLDEST_DAYS * DAY_MS) return { since: last.at, words: `с прошлого отчёта (${shortDate(last.at)})` }
  return { since: now - DEFAULT_DAYS * DAY_MS, words: `за последние ${DEFAULT_DAYS} дней` }
}

async function commitsSince($: EngineInterface, since: number): Promise<string> {
  try {
    const log = await $.process.run(
      ['git', 'log', `--since=${new Date(since).toISOString()}`, '--no-merges', `-n${COMMITS_KEPT}`, '--date=short', '--pretty=format:%ad %s'],
      { timeoutMs: 15_000 },
    )
    return log.exitCode === 0 ? log.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function sessionModel($: EngineInterface): Promise<string> {
  try {
    return await $.session.model()
  } catch {
    return 'sonnet'
  }
}

/** A fresh report: the conversation's fork when there is one, else the commits alone. */
async function write($: EngineInterface, request: ReportRequest, again?: Period): Promise<string> {
  if ((await read($, busy)) !== null) return 'Отчёт уже пишется, он появится в панели.'
  await update($, busy, () => 'Пишу отчёт...')
  await update($, note, () => '')
  void $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
  try {
    const now = await $.clock.now()
    const period = again ?? periodOf(await read($, report), now)
    const commits = await commitsSince($, period.since)
    const prompt = reportPrompt(request, period.words, commits)
    let answer = await $.model.fork({ prompt })
    if (!answer.isAnswered && answer.reason === 'nothing-to-fork') {
      if (commits === '') return keepNote($, 'Пока не о чем писать: в этом разговоре ещё не было работы, и коммитов за этот период нет.')
      answer = await $.model.complete({ model: await sessionModel($), prompt })
    }
    if (!answer.isAnswered) return keepNote($, `Отчёт не получился: ${answer.reason}. Нажми «Заново».`)
    const text = humanize(answer.text)
    await keepReport($, { text, at: now, period: period.words, since: period.since, isEnglish: isEnglish(text) })
    return text
  } catch (error) {
    return keepNote($, `Отчёт не получился: ${String(error)}`)
  } finally {
    await update($, busy, () => null)
  }
}

/** The report shortened or translated, the time it covers kept. */
async function rewrite($: EngineInterface, change: 'shorter' | 'ru' | 'en'): Promise<void> {
  const current = await read($, report)
  if (current === null || (await read($, busy)) !== null) return
  await update($, busy, () => (change === 'shorter' ? 'Сокращаю...' : 'Перевожу...'))
  await update($, note, () => '')
  try {
    const answer = await $.model.complete({ model: await sessionModel($), prompt: rewritePrompt(change, current.text) })
    if (!answer.isAnswered) {
      await keepNote($, `Не получилось: ${answer.reason}.`)
      return
    }
    const text = humanize(answer.text)
    await keepReport($, { ...current, text, isEnglish: isEnglish(text) })
  } catch (error) {
    await keepNote($, `Не получилось: ${String(error)}`)
  } finally {
    await update($, busy, () => null)
  }
}

async function keepReport($: EngineInterface, next: Report): Promise<void> {
  await $.store.set(await storeKey($), next)
  await update($, report, () => next)
}

async function keepNote($: EngineInterface, text: string): Promise<string> {
  await update($, note, () => text)
  return text
}

/** The surface's clipboard, else on Windows PowerShell's, the text sent as base64 so nothing is lost. */
async function copy($: EngineInterface, surface: RenderSurface): Promise<void> {
  const current = await read($, report)
  if (current === null) return
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text: current.text, surface })).isCopied
  } catch {
    isCopied = false
  }
  if (!isCopied && (await $.env.get('OS')) === 'Windows_NT') {
    const script = `Set-Clipboard -Value ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16Base64(current.text)}')))`
    try {
      isCopied = (await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000 })).exitCode === 0
    } catch {
      isCopied = false
    }
  }
  $.ui.toast(isCopied ? 'Отчёт скопирован' : 'Не получилось скопировать: выдели текст в панели и скопируй вручную')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, report, () => null)
    await update($, busy, () => null)
    await update($, note, () => '')
    try {
      const kept = restoreReport(await $.store.get(await storeKey($)))
      await update($, report, () => kept)
    } catch {
      // No project to read from: the pane starts empty.
    }
    await $.command.register({ name: 'report', description: 'Отчёт клиенту простыми словами: что сделали, что осталось, что нужно от клиента' })
    return next(e)
  })

  on('command.run', { command: 'report' }, async ($, e) => {
    const text = await write($, parseArgs(e.args))
    return { text }
  })

  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    return { ...context, blocks: [...context.blocks, { name: 'clientWriting', text: CHAT_RULES }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, report)
    const working = await read($, busy)
    const said = await read($, note)

    return (
      <Box flexDirection="column">
        <Text dimColor>ОТЧЁТ КЛИЕНТУ</Text>
        {current !== null && (
          <Text dimColor>
            {current.period} · написан {stamp(current.at)}
          </Text>
        )}

        {current === null && working === null && (
          <Box marginTop={1} flexDirection="column">
            <Text wrap="wrap">Отчёта пока нет. Он соберётся из этого разговора и коммитов с прошлого отчёта.</Text>
            <Box marginTop={1}>
              <Button key="cr-write" variant="primary" label="Написать отчёт" onPress={() => void write($, { language: 'auto', extra: '' })} />
            </Box>
          </Box>
        )}

        {current !== null && (
          <Box marginTop={1} flexDirection="column">
            <Text wrap="wrap">{current.text}</Text>
          </Box>
        )}

        {working !== null && (
          <Box marginTop={1}>
            <Text color="warning">{working}</Text>
          </Box>
        )}
        {said !== '' && (
          <Box marginTop={1}>
            <Text color="error" wrap="wrap">
              {said}
            </Text>
          </Box>
        )}

        {current !== null && (
          <Box marginTop={1} gap={1} flexWrap="wrap">
            <Button key="cr-copy" variant="primary" hotkey="c" label="Скопировать" onPress={press => void copy($, press.surface)} />
            <Button key="cr-shorter" label="Короче" onPress={() => void rewrite($, 'shorter')} />
            <Button
              key="cr-language"
              label={current.isEnglish ? 'По-русски' : 'По-английски'}
              onPress={() => void rewrite($, current.isEnglish ? 'ru' : 'en')}
            />
            <Button key="cr-again" label="Заново" onPress={() => void write($, { language: current.isEnglish ? 'en' : 'auto', extra: '' }, { since: current.since, words: current.period })} />
          </Box>
        )}
      </Box>
    )
  })
}
