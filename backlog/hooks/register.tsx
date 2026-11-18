// backlog: what is left for later in this project, kept between chats, in a
// pane beside the chat. The model adds to it with its `backlog` tool and marks
// items done; the person adds a line, sends an item to work in one press, or
// closes it. Every chat of the project reads the same store and looks at it
// again every few seconds, so a change shows in all of them.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Backlog } from '../types'
import { addItems, ageText, backlogBriefing, checkItem, closeItems, emptyBacklog, isStale, reopenItem, restoreBacklog, takePrompt } from './backlog'

const PANE = 'backlog'
const PANE_TITLE = 'Бэклог'
const TOOL = 'mcp__backlog__backlog'
// How often a chat looks whether another chat of the project changed the backlog.
const SYNC_MS = 4_000
const CLOSED_SHOWN = 3
// The items' numbers stand in a column of this width.
const NUMBER_WIDTH = 4

const TOOL_DESCRIPTION =
  "Keeps the project's backlog in the Backlog pane: things to do later, kept between chats. Add items when the user " +
  'says to do something later or next time, or when work is left over at the end of a task; mark items done by id ' +
  "once they are finished, and drop the ones no longer needed. One short line per item, in the user's language."

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    add: { type: 'array', items: { type: 'string' }, description: 'New items, one short line each.' },
    done: { type: 'array', items: { type: 'string' }, description: 'Ids of finished items, e.g. b3.' },
    drop: { type: 'array', items: { type: 'string' }, description: 'Ids of items no longer needed.' },
  },
}

const CHECK_PROMPT =
  'Проверь бэклог проекта: по каждому пункту посмотри код, git и, если нужно, сервер, и реши, сделан ли он уже ' +
  'или больше не нужен. Сделанные закрой через backlog с done, ненужные с drop, остальные оставь как есть. ' +
  'В проекте ничего не меняй, только проверь, и коротко напиши, что закрыл и почему.'

const backlog = atom({ plugin: 'backlog', key: 'backlog' } as const, emptyBacklog() as Backlog)
const draft = atom({ plugin: 'backlog', key: 'draft' } as const, '')
const clearing = atom({ plugin: 'backlog', key: 'clearing' } as const, false)
const project = atom({ plugin: 'backlog', key: 'project' } as const, '')

function folderOf(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function storeKey($: EngineInterface): Promise<string> {
  return `backlog:${folderOf(await $.session.cwd()).toLowerCase()}`
}

async function load($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const kept = restoreBacklog(await $.store.get(await storeKey($)))
  await update($, backlog, () => kept)
  await update($, project, () => folderOf(cwd).split('/').pop() ?? cwd)
}

/** Whatever another chat of this project wrote, shown here too. */
async function refresh($: EngineInterface): Promise<void> {
  const fresh = restoreBacklog(await $.store.get(await storeKey($)))
  if (JSON.stringify(fresh) !== JSON.stringify(await read($, backlog))) await update($, backlog, () => fresh)
}

/** A change made on what the store holds now: another chat of the project may have written since this one looked. */
async function change($: EngineInterface, fn: (current: Backlog) => Backlog): Promise<{ before: Backlog; next: Backlog }> {
  const key = await storeKey($)
  const before = restoreBacklog(await $.store.get(key))
  const next = fn(before)
  if (next !== before) await $.store.set(key, next)
  await update($, backlog, () => next)
  return { before, next }
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

/** Words handed to Claude as the person's own. */
async function handOver($: EngineInterface, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (error) {
    $.ui.toast(`Не удалось передать Claude: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function personAdd($: EngineInterface, value: string): Promise<void> {
  const checked = checkItem(value)
  if ('error' in checked) return
  const at = await $.clock.now()
  await change($, current => addItems(current, [checked.text], at, 'person'))
  await update($, draft, () => '')
}

async function closeItem($: EngineInterface, id: string, how: 'done' | 'dropped'): Promise<void> {
  const at = await $.clock.now()
  await change($, current => closeItems(current, [id], how, at))
}

async function clearAll($: EngineInterface): Promise<void> {
  await update($, clearing, () => false)
  const at = await $.clock.now()
  await change($, current => closeItems(current, current.items.map(item => item.id), 'dropped', at))
}

/** The item handed to Claude; it stays on the list until Claude marks it done. */
async function takeItem($: EngineInterface, id: string): Promise<void> {
  const item = (await read($, backlog)).items.find(one => one.id === id)
  if (item !== undefined) await handOver($, takePrompt(item))
}

let syncTimer: { cancel: () => void } | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'backlog', description: 'Открыть бэклог проекта: что сделать потом' })
    await $.tool.register({ name: 'backlog', description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    try {
      await load($)
    } catch {
      // No project to read from: the backlog starts empty.
    }
    // Another chat of the project wrote: this one shows it within seconds.
    syncTimer?.cancel()
    syncTimer = $.clock.every(SYNC_MS, () => void refresh($).catch(() => undefined))
    void openPane($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'backlog' }, async ($, e) => {
    await openPane($)
    // Opened by another plugin: no line in the chat.
    return e.origin.kind === 'plugin' ? {} : { text: 'Бэклог открыт.' }
  })

  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    await refresh($).catch(() => undefined)
    return { ...context, blocks: [...context.blocks, { name: 'backlog', text: backlogBriefing(await read($, backlog), TOOL) }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { add?: unknown; done?: unknown; drop?: unknown }
    const errors: string[] = []
    const adds: string[] = []
    for (const one of Array.isArray(input.add) ? input.add : []) {
      const checked = checkItem(one)
      if ('error' in checked) errors.push(`"${String(one).slice(0, 60)}": ${checked.error}`)
      else adds.push(checked.text)
    }
    const current = restoreBacklog(await $.store.get(await storeKey($)))
    const done = Array.isArray(input.done) ? input.done.map(String) : []
    const drops = Array.isArray(input.drop) ? input.drop.map(String) : []
    for (const id of [...done, ...drops]) if (!current.items.some(item => item.id === id)) errors.push(`нет пункта ${id}`)
    if (errors.length > 0) return { deny: `Бэклог не изменён: ${errors.join('; ')}.` }
    if (adds.length === 0 && done.length === 0 && drops.length === 0) return { deny: 'Нечего менять: передай add, done или drop.' }
    const at = await $.clock.now()
    const { before, next } = await change($, now => addItems(closeItems(closeItems(now, done, 'done', at), drops, 'dropped', at), adds, at, 'claude'))
    // What is new, an item already on the list not counted again.
    const had = new Set(before.items.map(item => item.id))
    const added = next.items.filter(item => !had.has(item.id)).map(item => `[${item.id}] ${item.text}`)
    const summary = [
      added.length > 0 ? `+${added.length}` : '',
      done.length > 0 ? `готово ${done.length}` : '',
      drops.length > 0 ? `не актуально ${drops.length}` : '',
    ].filter(Boolean)
    if (summary.length > 0) $.ui.toast(`Бэклог: ${summary.join(', ')}`)
    return { result: `Бэклог обновлён${added.length > 0 ? `. Добавлено: ${added.join('; ')}` : ''}.` }
  })

  // The pane with air between its parts: the heading and its buttons, the items
  // each with its own buttons a row under the text, the recently closed, the field.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // A surface without text fields (mobile) adds through the chat.
    const Input = 'Input' in elements ? elements.Input : undefined
    const later = await read($, backlog)
    const typed = await read($, draft)
    const isClearing = await read($, clearing)
    const name = await read($, project)
    const now = await $.clock.now()
    const recentlyClosed = [...later.closed].reverse().slice(0, CLOSED_SHOWN)

    const heading = (key: string, text: string) => (
      <Box key={key} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {heading('h-title', later.items.length === 0 ? 'БЭКЛОГ ПРОЕКТА · пусто' : `БЭКЛОГ ПРОЕКТА · ${later.items.length}`)}
        <Text>{name}</Text>

        {later.items.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Скажи Claude "сделаем потом", и пункт появится здесь. Или добавь сам внизу.
            </Text>
          </Box>
        ) : isClearing ? (
          <Box flexDirection="column" marginTop={2}>
            <Text color="warning" wrap="wrap">
              Убрать все пункты ({later.items.length}) как неактуальные? Их можно будет вернуть из закрытых.
            </Text>
            <Box marginTop={1} gap={1}>
              <Button key="clear-yes" label="Да, очистить" onPress={() => void clearAll($)} />
              <Button key="clear-no" label="Отмена" onPress={() => void update($, clearing, () => false)} />
            </Box>
          </Box>
        ) : (
          <Box marginTop={2} gap={1} flexWrap="wrap">
            <Button key="check" label="Проверить, что актуально" onPress={() => void handOver($, CHECK_PROMPT)} />
            <Button key="clear" label="Очистить всё" onPress={() => void update($, clearing, () => true)} />
          </Box>
        )}

        {later.items.length > 0 && (
          <Box marginTop={2} flexDirection="column">
            {later.items.map((item, index) => {
              const isOld = isStale(item.at, now)
              return (
                <Box key={item.id} flexDirection="column" {...(index > 0 ? { marginTop: 2 } : {})}>
                  <Box>
                    <Box width={NUMBER_WIDTH} flexShrink={0}>
                      <Text dimColor>{index + 1}.</Text>
                    </Box>
                    <Box flexGrow={1}>
                      <Text wrap="wrap">{item.text}</Text>
                    </Box>
                  </Box>
                  <Box marginLeft={NUMBER_WIDTH}>
                    <Text {...(isOld ? { color: 'warning' } : { dimColor: true })}>
                      {item.by === 'claude' ? 'Claude' : 'ты'} · {ageText(item.at, now)}
                      {isOld ? ' · давно, ещё нужно?' : ''}
                    </Text>
                  </Box>
                  {/* Real buttons, a row under the text, so they read as buttons. */}
                  <Box marginLeft={NUMBER_WIDTH} marginTop={1} gap={1} flexWrap="wrap">
                    <Button key={`take-${item.id}`} label="в работу" onPress={() => void takeItem($, item.id)} />
                    <Button key={`done-${item.id}`} label="✓ сделано" onPress={() => void closeItem($, item.id, 'done')} />
                    <Button key={`drop-${item.id}`} label="✕ не актуально" onPress={() => void closeItem($, item.id, 'dropped')} />
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}

        {recentlyClosed.length > 0 && (
          <Box marginTop={2} flexDirection="column">
            {heading('h-closed', 'ЗАКРЫТО НЕДАВНО')}
            {recentlyClosed.map((item, index) => (
              <Box key={`closed-${item.id}`} {...(index > 0 ? { marginTop: 1 } : {})}>
                <Box flexGrow={1}>
                  <Text dimColor wrap="wrap">
                    {item.how === 'done' ? '✓' : '✕'} {item.text}
                  </Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Button key={`reopen-${item.id}`} label="вернуть" onPress={() => void change($, current => reopenItem(current, item.id))} />
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {/* The field and its button on one row; a hint and a spare row keep it whole at the pane's bottom. */}
        {Input !== undefined && (
          <Box marginTop={2} marginBottom={1} flexDirection="column">
            {heading('h-add', 'ДОБАВИТЬ НА ПОТОМ')}
            <Box gap={1} alignItems="center">
              <Input
                key="add-text"
                placeholder="Что сделать потом"
                value={typed}
                onInput={value => void update($, draft, () => value)}
                onSubmit={value => void personAdd($, value)}
              />
              <Button key="add" label="Добавить" onPress={() => void personAdd($, typed)} />
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Одна задача одной строкой.</Text>
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
