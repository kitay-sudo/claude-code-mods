// tdd: tests before code, in a project of the person's choosing.
//
// "Добавить в проект" writes the rules into the project's CLAUDE.md, which
// Claude Code reads in every session: from then on the agent works that way
// there, mod or no mod. Two gates stand on top, per project: off, observe
// (they only say so) and enforce (they refuse). The edit gate wants a test file
// touched before code is; the commit gate wants the tests green after the last
// edit of code. The person's "без тестов" lifts them for what they asked.
// The pane (/tdd) holds the button, the gate mode and where things stand.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderElement } from 'claude-code'

import type { Gates } from '../types'
import { EDIT_DENY, FRESH_RUN, RED_LIMIT, RED_NUDGE, chipOf, commitDeny, commitGate, committed, editGate, personSaid, statusLine, testRan } from './gate'
import { addRule, hasRule, isCommitCommand, isTestCommand, removeRule, testCommandOf } from './rules'
import { joinRow } from './status-row'

const PANE = 'tdd'
const PANE_TITLE = 'Тесты до кода'
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
const SHELL_TOOLS = ['Bash', 'PowerShell'] as const
const TOAST_MS = 8_000

const GATE_HELP: Record<Gates, string> = {
  off: 'Ворота выключены: ничего не проверяется.',
  observe: 'Только предупреждают: код без теста и коммит без зелёных тестов проходят, но вы видите уведомление.',
  enforce:
    'Блокируют: код не правится, пока нет теста, и коммит не проходит без зелёного прогона тестов. Слова "без тестов" в вашем сообщении снимают блок на этот раз.',
}

const runState = atom({ plugin: 'tdd', key: 'run' } as const, FRESH_RUN)
const gates = atom({ plugin: 'tdd', key: 'gates' } as const, 'off' as Gates)
const ruleState = atom({ plugin: 'tdd', key: 'rule' } as const, 'unknown' as 'unknown' | 'added' | 'absent')
const testCommand = atom({ plugin: 'tdd', key: 'testCommand' } as const, null as string | null)
const project = atom({ plugin: 'tdd', key: 'project' } as const, '')

// Messages the person wrote, or pressed as a suggestion.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

function isPerson(origin: PromptOrigin): boolean {
  return PERSON.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
}

function folderOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function fileName(path: string): string {
  return folderOf(path).split('/').pop() ?? path
}

function join(root: string, name: string): string {
  const sep = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${name}`
}

async function storeKey($: EngineInterface): Promise<string> {
  return `tdd:${folderOf(await $.session.root()).toLowerCase()}`
}

/** The project's rules file: its CLAUDE.md at the root. */
async function rulesFile($: EngineInterface): Promise<string> {
  return join(await $.session.root(), 'CLAUDE.md')
}

async function refreshRule($: EngineInterface): Promise<void> {
  const path = await rulesFile($)
  const found = (await $.fs.exists(path)) && hasRule(String(await $.fs.read(path)))
  await update($, ruleState, () => (found ? 'added' : 'absent'))
}

async function load($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  await update($, project, () => fileName(root))
  const kept = (await $.store.get(await storeKey($))) as { gates?: unknown } | undefined
  const mode = kept?.gates === 'observe' || kept?.gates === 'enforce' ? kept.gates : 'off'
  await update($, gates, () => mode)
  await refreshRule($).catch(() => undefined)
  const packagePath = join(root, 'package.json')
  const command = (await $.fs.exists(packagePath).catch(() => false)) ? testCommandOf(String(await $.fs.read(packagePath))) : null
  await update($, testCommand, () => command)
}

async function setGates($: EngineInterface, mode: Gates): Promise<void> {
  await $.store.set(await storeKey($), { gates: mode })
  await update($, gates, () => mode)
}

async function addToProject($: EngineInterface): Promise<void> {
  const path = await rulesFile($)
  const text = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  await $.fs.write(path, addRule(text))
  await update($, ruleState, () => 'added')
  $.ui.toast('Правила добавлены в CLAUDE.md проекта. Агент теперь работает по ним.', { timeoutMs: TOAST_MS })
}

async function removeFromProject($: EngineInterface): Promise<void> {
  const path = await rulesFile($)
  if (await $.fs.exists(path)) await $.fs.write(path, removeRule(String(await $.fs.read(path))))
  await update($, ruleState, () => 'absent')
  $.ui.toast('Правила убраны из CLAUDE.md проекта.', { timeoutMs: TOAST_MS })
}

async function openPane($: EngineInterface): Promise<void> {
  await refreshRule($).catch(() => undefined)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tdd', description: 'Тесты до кода: правила проекта, ворота на правку и на коммит' })
    try {
      await load($)
    } catch {
      // No project to read from: the gates stay off.
    }
    return next(e)
  })

  on('command.run', { command: 'tdd' }, async $ => {
    await openPane($)
    return { text: 'Правила разработки открыты.' }
  })

  // The person's words end the last "без тестов" and may start a new one.
  on('prompt.submit', async ($, e, next) => {
    if (isPerson(e.origin)) await update($, runState, run => personSaid(run, e.text))
    return next(e)
  })

  // A /clear or a resume starts another conversation: what was remembered goes.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await update($, runState, () => FRESH_RUN)
    return next(e)
  })

  // The edit gate: code is not edited before a test file was touched.
  for (const tool of EDIT_TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
      const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
      if (path === '') return next(e)
      const checked = editGate(await read($, runState), await read($, gates), path)
      await update($, runState, () => checked.run)
      if (checked.verdict === 'deny') return { deny: EDIT_DENY }
      if (checked.verdict === 'warn') $.ui.toast(`Тесты до кода: ${fileName(path)} правится без теста`, { timeoutMs: TOAST_MS })
      return next(e)
    })
  }

  // The commit gate, and the watch on test runs: green clears the work waiting
  // for a check, three reds in a row stop the agent.
  for (const tool of SHELL_TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const command = (e as unknown as { command?: unknown }).command
      if (typeof command !== 'string') return next(e)
      const isCommit = isCommitCommand(command)
      const isTest = isTestCommand(command)
      if (isCommit && !isTest) {
        const known = await read($, testCommand)
        const run = await read($, runState)
        const checked = commitGate(run, await read($, gates), known !== null || run.lastGreen !== null)
        await update($, runState, () => checked.run)
        if (checked.verdict === 'deny') return { deny: commitDeny(known) }
        if (checked.verdict === 'warn') $.ui.toast('Тесты до кода: коммит без свежего прогона тестов', { timeoutMs: TOAST_MS })
      }
      const out = await next(e)
      if (out.deny !== undefined) return out
      const isGreen = out.isError !== true
      if (isTest) {
        const now = await $.clock.now()
        await update($, runState, run => testRan(run, isGreen, now))
        if (!isGreen && (await read($, runState)).redStreak === RED_LIMIT) {
          $.ui.toast(`Тесты красные ${RED_LIMIT} раза подряд`, { timeoutMs: TOAST_MS })
          return { ...out, context: [...(out.context ?? []), RED_NUDGE] }
        }
      }
      if (isCommit && isGreen) await update($, runState, run => committed(run))
      return out
    })
  }

  // A chip in the shared block above the input, always in sight: where TDD
  // stands in this project, a nudge when it could be on, and one press to the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next): Promise<RenderElement> => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return below
    const { Box, Button } = $.ui.resolve(e)
    const chip = chipOf(await read($, gates), await read($, ruleState), (await read($, testCommand)) !== null, (await read($, runState)).dirty)
    const open = () => void openPane($).catch(() => undefined)
    const button =
      chip.tone === 'attention' ? (
        <Button key="tdd-open" variant="primary" label={chip.text} onPress={open} />
      ) : (
        <Button key="tdd-open" plain {...(chip.tone === 'dim' ? { dimColor: true as const } : {})} label={chip.text} onPress={open} />
      )
    return joinRow(
      below,
      <Box key="seg-2-tdd" gap={1}>
        {button}
      </Box>,
      Box,
      'status',
    )
  })

  // The pane: the button for the project, the gate mode, where things stand.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rule = await read($, ruleState)
    const mode = await read($, gates)
    const known = await read($, testCommand)
    const run = await read($, runState)
    const name = await read($, project)
    const now = await $.clock.now()

    const heading = (key: string, text: string) => (
      <Box key={key} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )
    const gateButton = (which: Gates, label: string) => (
      <Button
        key={`gates-${which}`}
        label={label}
        {...(mode === which ? { variant: 'primary' as const } : {})}
        onPress={() => void setGates($, which).catch(() => undefined)}
      />
    )

    return (
      <Box flexDirection="column">
        {heading('h-title', 'ПРАВИЛА РАЗРАБОТКИ')}
        <Text>{name}</Text>

        <Box marginTop={2} flexDirection="column">
          {heading('h-rule', 'ТЕСТЫ ДО КОДА')}
          <Text wrap="wrap" {...(rule === 'added' ? {} : { dimColor: true })}>
            {rule === 'added'
              ? '✓ Добавлено в CLAUDE.md проекта. Агент в этом проекте работает по этим правилам.'
              : '○ Не добавлено. Нажмите, и правила запишутся в CLAUDE.md проекта: агент сразу начнёт им следовать.'}
          </Text>
          <Box marginTop={1} gap={1} flexWrap="wrap">
            {rule === 'added' ? (
              <Button key="rule-remove" label="Убрать из проекта" onPress={() => void removeFromProject($).catch(() => undefined)} />
            ) : (
              <Button key="rule-add" label="Добавить в проект" variant="primary" onPress={() => void addToProject($).catch(() => undefined)} />
            )}
          </Box>
        </Box>

        <Box marginTop={2} flexDirection="column">
          {heading('h-gates', 'ВОРОТА')}
          <Box gap={1} flexWrap="wrap">
            {gateButton('off', 'Выкл')}
            {gateButton('observe', 'Наблюдать')}
            {gateButton('enforce', 'Блокировать')}
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {GATE_HELP[mode]}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {known === null ? 'Команда тестов не найдена: ворота на коммит ждут первого прогона тестов.' : `Команда тестов: ${known}`}
            </Text>
          </Box>
        </Box>

        <Box marginTop={2} marginBottom={1} flexDirection="column">
          {heading('h-now', 'СЕЙЧАС')}
          <Text wrap="wrap" {...(run.dirty ? { color: 'warning' } : { dimColor: true })}>
            {statusLine(run, now)}
          </Text>
        </Box>
      </Box>
    )
  })
}
