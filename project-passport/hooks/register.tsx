// project-passport: what is worth knowing about this project and its client,
// kept per project and read by the model at the start of every conversation:
// who the client is and the language to write to them in, what the project
// is, its rules and nuances, where things live. Never a password or a key.
//
// The /passport pane shows and edits it, opens by itself when a session starts
// in a project that has one, and fills it in one press by asking the model to
// read the project. The model adds what it learns with `passport_update`; the
// person confirms each change (or switches that off in the pane). After an
// answer it also picks, by itself, what is worth keeping from the person's own
// messages (see learnPrompt). Every chat of the project reads the same store
// and looks at it again every few seconds, so a change shows in all of them.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Note, NoteDraft, Passport, PassportSettings, Section } from '../types'
import {
  LANGUAGES,
  SECTIONS,
  addNote,
  applyLearned,
  briefing,
  checkText,
  describeChanges,
  emptyPassport,
  isNothing,
  isSection,
  learnPrompt,
  parseLearned,
  removeNote,
  restore,
  worthLearning,
} from './notes'
import type { Learned } from './notes'

const PANE = 'project-passport'
const PANE_TITLE = 'Паспорт проекта'
const TOOL = 'mcp__project-passport__passport_update'
const SETTINGS_KEY = 'settings'
const DEFAULT_SETTINGS: PassportSettings = { autoOpen: true, askBeforeAdd: true, autoLearn: true }
const EMPTY_DRAFT: NoteDraft = { section: 'rules', text: '', error: '' }
// The notes' numbers stand in a column of this width.
const NUMBER_WIDTH = 4
const LANGUAGE_LABELS = { ru: 'RU', en: 'EN', 'ru+en': 'RU+EN' } as const
// How often a chat looks whether another chat of the project changed the passport.
const SYNC_MS = 4_000
// A note picked from the chat is marked new this long.
const NEW_MS = 24 * 60 * 60 * 1000
// Prompts the person wrote: at the prompt, through Remote Control, or in the app.
const PERSON = new Set(['composer', 'bridge', 'sdk'])
const HEARD_KEPT = 20

const FILL_PROMPT =
  'Заполни паспорт этого проекта. Прочитай README, CLAUDE.md, файлы пакета, скрипты деплоя и git remote, но в паспорт ' +
  'через passport_update запиши только то, чего в этих файлах нет и что нужно знать про клиента: кто клиент, как и на ' +
  'каком языке с ним общаться, договорённости, где что лежит (админки, серверы, документы, без паролей). Про проект ' +
  'одной строкой. Стек, команды и правила по коду не переписывай, они уже в файлах. Чего не найдёшь, спроси у меня.'

const SORT_PROMPT =
  'Разбери паспорт проекта и CLAUDE.md. Всё про клиента (кто он, язык и тон общения, деньги, договорённости, личные ' +
  'тонкости) должно быть в паспорте и не должно лежать в CLAUDE.md, README и других файлах репозитория: клиент может ' +
  'видеть репозиторий. Всё про код и работу с репозиторием (сборка, тесты, устройство, что не трогать в коде) должно ' +
  'быть в CLAUDE.md, а не в паспорте. Дубли того, что уже есть в README, из паспорта убери. Сначала покажи мне списком, ' +
  'что куда переносишь и что убираешь, и подожди моего "да". Потом перенеси: паспорт через passport_update, CLAUDE.md ' +
  'правь сам. Если CLAUDE.md нет, а перенести в него есть что, создай его.'

const TOOL_DESCRIPTION =
  "Changes this project's passport: the durable facts and nuances the user wants you to know in every " +
  'conversation (who the client is and how to talk to them, what the project is, its rules, where things ' +
  'live). Add notes, remove them by id, or set the language messages to the client are written in. One short ' +
  'fact per note, in the user’s language. Never a password, key or token. The user confirms the change. ' +
  'Only what concerns the client and the arrangements and what the repository files do not say: rules about the ' +
  "code belong in the project's CLAUDE.md instead."

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    add: {
      type: 'array',
      description: 'Notes to add.',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: SECTIONS.map(section => section.id), description: SECTIONS.map(section => `${section.id}: ${section.hint}`).join('; ') },
          text: { type: 'string', description: 'One fact or nuance, one line.' },
        },
        required: ['section', 'text'],
      },
    },
    remove: { type: 'array', items: { type: 'string' }, description: 'Ids of notes to remove, e.g. n3.' },
    replyLanguage: { type: 'string', enum: ['ru', 'en', 'ru+en'], description: 'The language messages to the client are written in.' },
  },
}

const passport = atom({ plugin: 'project-passport', key: 'passport' } as const, emptyPassport())
const settings = atom({ plugin: 'project-passport', key: 'settings' } as const, DEFAULT_SETTINGS)
const draft = atom({ plugin: 'project-passport', key: 'draft' } as const, EMPTY_DRAFT)
const confirming = atom({ plugin: 'project-passport', key: 'confirming' } as const, null)
const project = atom({ plugin: 'project-passport', key: 'project' } as const, '')
const asked = atom({ plugin: 'project-passport', key: 'asked' } as const, null)
const heard = atom({ plugin: 'project-passport', key: 'heard' } as const, [] as string[])
// A second press within this time is the same request: it is not sent again.
const REPEAT_MS = 15_000
// How long "✓ Передал Claude" stays under the buttons.
const SENT_SHOWN_MS = 60_000
const ASKED_WORDS = { fill: 'заполнить паспорт', sort: 'разобрать паспорт и CLAUDE.md' } as const

function folderOf(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function storeKey($: EngineInterface): Promise<string> {
  return `passport:${folderOf(await $.session.cwd()).toLowerCase()}`
}

function settingsOf(raw: unknown): PassportSettings {
  const mode = (raw ?? {}) as Partial<PassportSettings>
  return { autoOpen: mode.autoOpen !== false, askBeforeAdd: mode.askBeforeAdd !== false, autoLearn: mode.autoLearn !== false }
}

async function load($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const kept = restore(await $.store.get(await storeKey($)))
  const mode = settingsOf(await $.store.get(SETTINGS_KEY))
  await update($, passport, () => kept)
  await update($, settings, () => mode)
  await update($, project, () => folderOf(cwd).split('/').pop() ?? cwd)
}

/** Whatever another chat of this project wrote, shown here too. */
async function refresh($: EngineInterface): Promise<void> {
  const fresh = restore(await $.store.get(await storeKey($)))
  if (JSON.stringify(fresh) !== JSON.stringify(await read($, passport))) await update($, passport, () => fresh)
  const mode = settingsOf(await $.store.get(SETTINGS_KEY))
  if (JSON.stringify(mode) !== JSON.stringify(await read($, settings))) await update($, settings, () => mode)
}

/** A change made on what the store holds now: another chat of the project may have written since this one looked. */
async function change($: EngineInterface, fn: (current: Passport) => Passport): Promise<{ before: Passport; next: Passport }> {
  const key = await storeKey($)
  const before = restore(await $.store.get(key))
  const next = fn(before)
  if (next !== before) await $.store.set(key, next)
  await update($, passport, () => next)
  return { before, next }
}

async function keepSettings($: EngineInterface, next: PassportSettings): Promise<void> {
  await $.store.set(SETTINGS_KEY, next)
  await update($, settings, () => next)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// The model reads the passport at a conversation's start; a change the person
// makes in the pane later reaches it this way. A build without
// $.session.append (2.1.284) has it from the next conversation on.
async function tell($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[project-passport] ${text}` }] } })
  } catch {
    // Nothing to do: the next conversation reads it.
  }
}

/** A hint as a sentence: capital first, a full stop last. */
function sentence(text: string): string {
  const line = text.trim()
  return line === '' ? line : `${line[0]?.toUpperCase() ?? ''}${line.slice(1)}${/[.!?]$/.test(line) ? '' : '.'}`
}

async function personAdd($: EngineInterface): Promise<void> {
  const form = await read($, draft)
  const checked = checkText(form.text)
  if ('error' in checked) {
    await update($, draft, one => ({ ...one, error: checked.error }))
    return
  }
  const at = await $.clock.now()
  const { before, next } = await change($, current => addNote(current, { section: form.section, text: checked.text, at, by: 'person' }))
  await update($, draft, one => ({ ...one, text: '', error: '' }))
  const title = SECTIONS.find(section => section.id === form.section)?.title ?? ''
  if (next !== before) await tell($, `Пользователь добавил в паспорт проекта (${title}): ${checked.text}`)
}

async function editDraft($: EngineInterface, edit: Partial<NoteDraft>): Promise<void> {
  await update($, draft, one => ({ ...one, ...edit, error: '' }))
}

async function setLanguage($: EngineInterface, language: 'ru' | 'en' | 'ru+en'): Promise<void> {
  const { next: changed } = await change($, current => ({ ...current, replyLanguage: current.replyLanguage === language ? null : language }))
  const next = changed.replyLanguage
  await tell($, next === null ? 'Пользователь убрал язык общения с клиентом из паспорта.' : `Пользователь указал в паспорте: клиенту пишем ${LANGUAGES[next]}.`)
}

async function deleteNote($: EngineInterface, id: string): Promise<void> {
  await update($, confirming, () => null)
  let note: Note | undefined
  await change($, current => {
    note = current.notes.find(one => one.id === id)
    return removeNote(current, id)
  })
  if (note !== undefined) await tell($, `Пользователь убрал из паспорта проекта: ${note.text}`)
}

/** Every note of one section taken away, after the second press. */
async function clearSection($: EngineInterface, section: Section): Promise<void> {
  await update($, confirming, () => null)
  let gone: Note[] = []
  await change($, current => {
    gone = current.notes.filter(note => note.section === section)
    return gone.reduce((next, note) => removeNote(next, note.id), current)
  })
  const title = SECTIONS.find(one => one.id === section)?.title ?? section
  if (gone.length > 0) await tell($, `Пользователь очистил раздел паспорта "${title}": убрано заметок ${gone.length}.`)
}

/** A request handed to Claude as the person's own. */
async function askClaude($: EngineInterface, what: 'fill' | 'sort', text: string): Promise<void> {
  const at = await $.clock.now()
  const last = await read($, asked)
  if (last !== null && last.what === what && at - last.at < REPEAT_MS) return
  await update($, asked, () => ({ what, at }))
  $.ui.toast(`Передал Claude: ${ASKED_WORDS[what]}. Если он сейчас занят, начнёт после текущего шага.`)
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (error) {
    await update($, asked, () => null)
    $.ui.toast(`Не удалось попросить Claude: ${String(error)}`)
  }
}

async function toggle($: EngineInterface, name: keyof PassportSettings): Promise<void> {
  const mode = settingsOf(await $.store.get(SETTINGS_KEY))
  await keepSettings($, { ...mode, [name]: !mode[name] })
}

// --- From the chat ---------------------------------------------------------

// The passport tool ran this turn: the model and the person have just settled
// it (a «Отмена» included), so the chat is not looked at again for it.
let toolRan = false
let learning = false
let syncTimer: { cancel: () => void } | null = null

async function hear($: EngineInterface, text: string): Promise<void> {
  if (text.trim() === '') return
  await update($, heard, list => [...list, text].slice(-HEARD_KEPT))
}

/** What the person wrote since the last look, read by a fork; what is worth keeping goes in at once. */
async function learn($: EngineInterface): Promise<void> {
  const said = await read($, heard)
  if (said.length === 0 || !worthLearning(said)) return
  await update($, heard, () => [])
  const now = restore(await $.store.get(await storeKey($)))
  const reply = await $.model.fork({ prompt: learnPrompt(now, said) })
  if (!reply.isAnswered) return
  const at = await $.clock.now()
  let learned: Learned = { adds: [], replaces: [] }
  const { before, next } = await change($, current => {
    learned = parseLearned(reply.text, current)
    return isNothing(learned) ? current : applyLearned(current, learned, at)
  })
  if (next === before) return
  const parts = next.notes.filter(note => !before.notes.some(old => old.id === note.id)).map(note => note.text)
  if (learned.replyLanguage !== undefined) parts.push(`клиенту пишем ${LANGUAGES[learned.replyLanguage]}`)
  if (parts.length > 0) $.ui.toast(`Паспорт пополнен из чата: ${parts[0]}${parts.length > 1 ? `, и ещё ${parts.length - 1}` : ''}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    await update($, confirming, () => null)
    await update($, heard, () => [])
    await $.command.register({ name: 'passport', description: 'Открыть паспорт проекта: клиент, язык общения, правила и тонкости' })
    await $.tool.register({ name: 'passport_update', description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    // Another chat of the project wrote: this one shows it within seconds.
    syncTimer?.cancel()
    syncTimer = $.clock.every(SYNC_MS, () => void refresh($).catch(() => undefined))
    // Beside the task panel in every chat, an empty one inviting to be filled.
    if ((await read($, settings)).autoOpen) void openPane($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'passport' }, async ($, e) => {
    await openPane($)
    // Opened by another plugin: no line in the chat.
    return e.origin.kind === 'plugin' ? {} : { text: 'Паспорт проекта открыт.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (PERSON.has(e.origin.kind) && (await read($, settings)).autoLearn) await hear($, e.text)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (toolRan) {
      toolRan = false
      await update($, heard, () => [])
      return result
    }
    if (e.reason === 'answer' && !learning && (await read($, settings)).autoLearn) {
      learning = true
      void learn($)
        .catch(error => $.ui.log(`project-passport: ${String(error)}`, { to: 'debug' }))
        .finally(() => {
          learning = false
        })
    }
    return result
  })

  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    await refresh($).catch(() => undefined)
    return { ...context, blocks: [...context.blocks, { name: 'projectPassport', text: briefing(await read($, passport), TOOL) }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    toolRan = true
    const input = e as unknown as { add?: unknown; remove?: unknown; replyLanguage?: unknown }
    const current = restore(await $.store.get(await storeKey($)))
    const errors: string[] = []
    const adds: { section: Section; text: string }[] = []
    for (const one of Array.isArray(input.add) ? input.add : []) {
      const raw = one as { section?: unknown; text?: unknown }
      const checked = checkText(raw.text)
      if (!isSection(raw.section)) errors.push(`section «${String(raw.section)}»: одно из ${SECTIONS.map(section => section.id).join(', ')}`)
      else if ('error' in checked) errors.push(`«${String(raw.text).slice(0, 60)}»: ${checked.error}`)
      else adds.push({ section: raw.section, text: checked.text })
    }
    const ids = Array.isArray(input.remove) ? input.remove.map(String) : []
    const removes = current.notes.filter(note => ids.includes(note.id))
    for (const id of ids) if (!removes.some(note => note.id === id)) errors.push(`нет заметки ${id}`)
    const language = input.replyLanguage
    if (language !== undefined && language !== 'ru' && language !== 'en' && language !== 'ru+en') errors.push('replyLanguage: ru, en или ru+en')
    if (errors.length > 0) return { deny: `Паспорт не изменён: ${errors.join('; ')}.` }
    const replyLanguage = language as 'ru' | 'en' | 'ru+en' | undefined
    if (adds.length === 0 && removes.length === 0 && replyLanguage === undefined) return { deny: 'Нечего менять: передай add, remove или replyLanguage.' }

    const summary = describeChanges(adds, removes, replyLanguage)
    if ((await read($, settings)).askBeforeAdd) {
      let picked = ''
      try {
        picked = await $.ui.ask(`Записать в паспорт проекта: ${summary}?`, { options: ['Записать', 'Отмена'], header: 'Паспорт' })
      } catch (error) {
        return { result: `Паспорт не изменён: пользователь не ответил (${String(error)}).` }
      }
      if (picked !== 'Записать') return { result: `Паспорт не изменён: ${picked === 'Отмена' ? 'пользователь нажал «Отмена»' : `пользователь ответил: ${picked}`}.` }
    }

    const at = await $.clock.now()
    await change($, now => {
      let next = now
      for (const note of removes) next = removeNote(next, note.id)
      for (const add of adds) next = addNote(next, { ...add, at, by: 'claude' })
      return replyLanguage === undefined ? next : { ...next, replyLanguage }
    })
    $.ui.toast(`Паспорт проекта: ${[adds.length > 0 ? `+${adds.length}` : '', removes.length > 0 ? `−${removes.length}` : '', replyLanguage !== undefined ? 'язык' : ''].filter(Boolean).join(' ')}`)
    return { result: `Записано в паспорт: ${summary}.` }
  })

  // The pane in sections with air between them: headings a row above their
  // content, the form's labels above its fields, settings as label and value.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e): Promise<RenderElement> => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // A surface without text fields (mobile) adds notes through the chat.
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    const current = await read($, passport)
    const mode = await read($, settings)
    const form = await read($, draft)
    const waiting = await read($, confirming)
    const name = await read($, project)
    const isEmpty = current.notes.length === 0 && current.replyLanguage === null
    const lastAsked = await read($, asked)
    const sentAt = await $.clock.now()
    const sent = lastAsked !== null && sentAt - lastAsked.at < SENT_SHOWN_MS ? lastAsked : null

    const heading = (key: string, text: string) => (
      <Box key={key} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {heading('h-title', 'ПАСПОРТ ПРОЕКТА')}
        <Text>{name}</Text>
        {mode.autoLearn && (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Пополняется сам из твоих сообщений во всех чатах проекта.
            </Text>
          </Box>
        )}

        <Box marginTop={2} flexDirection="column">
          {heading('h-lang', 'НА КАКОМ ЯЗЫКЕ ПИСАТЬ КЛИЕНТУ')}
          <Box gap={1} flexWrap="wrap">
            {(['ru', 'en', 'ru+en'] as const).map(language => (
              <Button
                key={`lang-${language}`}
                label={LANGUAGE_LABELS[language]}
                {...(current.replyLanguage === language ? { variant: 'primary' as const } : {})}
                onPress={() => void setLanguage($, language)}
              />
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {current.replyLanguage === null ? 'Не выбран. Нажми нужный.' : `Клиенту пишем ${LANGUAGES[current.replyLanguage]}.`}
            </Text>
          </Box>
        </Box>

        {SECTIONS.map(section => {
          const notes = current.notes.filter(note => note.section === section.id)
          return (
            <Box key={`sec-${section.id}`} marginTop={2} flexDirection="column">
              {/* The heading, and "Очистить" at its right while the section holds notes. */}
              <Box key={`h-${section.id}`} marginBottom={1} justifyContent="space-between" alignItems="center">
                <Text dimColor>{section.title.toUpperCase()}</Text>
                {notes.length > 0 && waiting !== `clear:${section.id}` && (
                  <Button key={`clear-${section.id}`} label="Очистить" onPress={() => void update($, confirming, () => `clear:${section.id}`)} />
                )}
              </Box>
              {waiting === `clear:${section.id}` && (
                <Box flexDirection="column" marginBottom={1}>
                  <Text color="warning" wrap="wrap">
                    Убрать все заметки раздела ({notes.length})?
                  </Text>
                  <Box marginTop={1} gap={1}>
                    <Button key={`clear-yes-${section.id}`} label="Да, очистить" onPress={() => void clearSection($, section.id)} />
                    <Button key={`clear-no-${section.id}`} label="Отмена" onPress={() => void update($, confirming, () => null)} />
                  </Box>
                </Box>
              )}
              {notes.length === 0 && (
                <Text dimColor wrap="wrap">
                  {sentence(section.hint)}
                </Text>
              )}
              {notes.map((note, index) =>
                waiting === note.id ? (
                  <Box key={`row-${note.id}`} flexDirection="column" {...(index > 0 ? { marginTop: 1 } : {})}>
                    <Text color="warning" wrap="wrap">
                      Убрать "{note.text}"?
                    </Text>
                    <Box marginTop={1} gap={1}>
                      <Button key={`yes-${note.id}`} label="Да, убрать" onPress={() => void deleteNote($, note.id)} />
                      <Button key={`no-${note.id}`} label="Отмена" onPress={() => void update($, confirming, () => null)} />
                    </Box>
                  </Box>
                ) : (
                  <Box key={`row-${note.id}`} {...(index > 0 ? { marginTop: 1 } : {})}>
                    <Box width={NUMBER_WIDTH} flexShrink={0}>
                      <Text dimColor>{index + 1}.</Text>
                    </Box>
                    <Box flexGrow={1}>
                      <Text wrap="wrap">
                        {note.text}
                        {note.by === 'claude' ? <Text dimColor> · Claude</Text> : ''}
                        {note.by === 'chat' ? <Text dimColor> · из чата</Text> : ''}
                        {note.by === 'chat' && sentAt - note.at < NEW_MS ? <Text color="success"> · новое</Text> : ''}
                      </Text>
                    </Box>
                    <Box flexShrink={0} marginLeft={1}>
                      <Button key={`del-${note.id}`} plain label="✕" onPress={() => void update($, confirming, () => note.id)} />
                    </Box>
                  </Box>
                ),
              )}
            </Box>
          )
        })}

        {Input !== undefined && Select !== undefined && (
          <Box marginTop={2} flexDirection="column">
            {heading('h-add', 'ДОБАВИТЬ ЗАМЕТКУ')}
            <Text>Раздел</Text>
            <Box marginTop={1}>
              <Select
                key="pp-section"
                options={SECTIONS.map(section => ({ value: section.id, label: section.title }))}
                value={form.section}
                onSelect={value => void editDraft($, { section: isSection(value) ? value : 'rules' })}
              />
            </Box>
            <Box marginTop={2} flexDirection="column">
              <Text>Заметка</Text>
              <Box marginTop={1} flexDirection="column">
                {/* The field and its button on one row, the button right beside it: the app sizes the field itself. */}
                <Box gap={1} alignItems="center">
                  <Input
                    key="pp-text"
                    placeholder="Например: Денису пишем по-английски, коротко и без смайлов"
                    value={form.text}
                    onInput={value => void editDraft($, { text: value })}
                    onSubmit={value => void editDraft($, { text: value }).then(() => personAdd($))}
                  />
                  <Button key="pp-add" label="Добавить" onPress={() => void personAdd($)} />
                </Box>
                <Box marginTop={1}>
                  <Text dimColor wrap="wrap">
                    Одна мысль одной строкой. Пароли и ключи сюда не пишем.
                  </Text>
                </Box>
              </Box>
            </Box>
            {form.error !== '' && (
              <Box marginTop={1}>
                <Text color="error" wrap="wrap">
                  {form.error}
                </Text>
              </Box>
            )}
          </Box>
        )}

        <Box marginTop={2} flexDirection="column">
          {heading('h-fill', 'ИЗ ПРОЕКТА')}
          <Text dimColor wrap="wrap">
            Заполнить: Claude прочитает README, CLAUDE.md, деплой и git и запишет сюда то, чего в файлах нет. Чего не найдёт, спросит у тебя.
          </Text>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Разобрать: всё про клиента переедет из CLAUDE.md сюда, всё про код отсюда в CLAUDE.md. Сначала Claude покажет список и спросит.
            </Text>
          </Box>
          <Box marginTop={1} gap={1} flexWrap="wrap">
            <Button key="pp-fill" variant="primary" label={isEmpty ? 'Заполнить из проекта' : 'Дополнить из проекта'} onPress={() => void askClaude($, 'fill', FILL_PROMPT)} />
            <Button key="pp-sort" label="Разобрать с CLAUDE.md" onPress={() => void askClaude($, 'sort', SORT_PROMPT)} />
          </Box>
          {sent !== null && (
            <Box marginTop={1}>
              <Text color="success" wrap="wrap">
                ✓ Передал Claude: {ASKED_WORDS[sent.what]}. Ответ будет в чате.
              </Text>
            </Box>
          )}
        </Box>

        <Box marginTop={2} marginBottom={1} flexDirection="column">
          {heading('h-settings', 'НАСТРОЙКИ')}
          <Box justifyContent="space-between">
            <Text>Открывать при старте чата</Text>
            <Button key="pp-autoopen" label={mode.autoOpen ? 'да' : 'нет'} onPress={() => void toggle($, 'autoOpen')} />
          </Box>
          <Box marginTop={1} justifyContent="space-between">
            <Text>Пополнять из чатов</Text>
            <Button key="pp-learn" label={mode.autoLearn ? 'да' : 'нет'} onPress={() => void toggle($, 'autoLearn')} />
          </Box>
          <Box marginTop={1} justifyContent="space-between">
            <Text>Записи Claude</Text>
            <Button key="pp-ask" label={mode.askBeforeAdd ? 'с вопросом' : 'без вопроса'} onPress={() => void toggle($, 'askBeforeAdd')} />
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Пополнять из чатов: после ответа Claude смотрит твои сообщения и сам записывает сюда важное про клиента с пометкой "из чата". Лишнее убери крестиком.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Записи Claude: когда ты просишь что-то запомнить, Claude спрашивает перед записью или пишет сразу.
            </Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
