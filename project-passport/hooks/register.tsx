// project-passport: what is worth knowing about this project and its client,
// kept per project and read by the model at the start of every conversation:
// who the client is and the language to write to them in, what the project
// is, its rules and nuances, where things live. Never a password or a key.
//
// The /passport pane shows and edits it, opens by itself when a session starts
// in a project that has one, and fills it in one press by asking the model to
// read the project. The model adds what it learns with `passport_update`; the
// person confirms each change (or switches that off in the pane).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { NoteDraft, Passport, PassportSettings, Section } from '../types'
import { LANGUAGES, SECTIONS, addNote, briefing, checkText, describeChanges, emptyPassport, isSection, removeNote, restore } from './notes'

const PANE = 'project-passport'
const PANE_TITLE = 'Паспорт проекта'
const TOOL = 'mcp__project-passport__passport_update'
const SETTINGS_KEY = 'settings'
const DEFAULT_SETTINGS: PassportSettings = { autoOpen: true, askBeforeAdd: true }
const EMPTY_DRAFT: NoteDraft = { section: 'rules', text: '', error: '' }
const LANGUAGE_LABELS = { ru: 'RU', en: 'EN', 'ru+en': 'RU+EN' } as const

const FILL_PROMPT =
  'Заполни паспорт этого проекта: прочитай README, файлы пакета, скрипты деплоя, git remote и CLAUDE.md, ' +
  'запиши найденное через passport_update по разделам, а то, что из файлов не понять (кто клиент и на каком ' +
  'языке ему писать), спроси у меня.'

const TOOL_DESCRIPTION =
  "Changes this project's passport: the durable facts and nuances the user wants you to know in every " +
  'conversation (who the client is and how to talk to them, what the project is, its rules, where things ' +
  'live). Add notes, remove them by id, or set the language messages to the client are written in. One short ' +
  'fact per note, in the user’s language. Never a password, key or token. The user confirms the change.'

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

async function storeKey($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  return `passport:${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

async function load($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const kept = await $.store.get(await storeKey($))
  const mode = (await $.store.get(SETTINGS_KEY)) as Partial<PassportSettings> | undefined
  await update($, passport, () => restore(kept))
  await update($, settings, () => ({ autoOpen: mode?.autoOpen !== false, askBeforeAdd: mode?.askBeforeAdd !== false }))
  await update($, project, () => cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? cwd)
}

async function keep($: EngineInterface, next: Passport): Promise<void> {
  await $.store.set(await storeKey($), next)
  await update($, passport, () => next)
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
  const before = await read($, passport)
  const next = addNote(before, { section: form.section, text: checked.text, at, by: 'person' })
  await keep($, next)
  await update($, draft, one => ({ ...one, text: '', error: '' }))
  const title = SECTIONS.find(section => section.id === form.section)?.title ?? ''
  if (next !== before) await tell($, `Пользователь добавил в паспорт проекта (${title}): ${checked.text}`)
}

async function editDraft($: EngineInterface, change: Partial<NoteDraft>): Promise<void> {
  await update($, draft, one => ({ ...one, ...change, error: '' }))
}

async function setLanguage($: EngineInterface, language: 'ru' | 'en' | 'ru+en'): Promise<void> {
  const current = await read($, passport)
  const next = current.replyLanguage === language ? null : language
  await keep($, { ...current, replyLanguage: next })
  await tell($, next === null ? 'Пользователь убрал язык общения с клиентом из паспорта.' : `Пользователь указал в паспорте: клиенту пишем ${LANGUAGES[next]}.`)
}

async function deleteNote($: EngineInterface, id: string): Promise<void> {
  await update($, confirming, () => null)
  const current = await read($, passport)
  const note = current.notes.find(one => one.id === id)
  await keep($, removeNote(current, id))
  if (note !== undefined) await tell($, `Пользователь убрал из паспорта проекта: ${note.text}`)
}

async function fill($: EngineInterface): Promise<void> {
  try {
    await $.prompt.submit({ text: FILL_PROMPT, asUser: true })
  } catch (error) {
    $.ui.toast(`Не удалось попросить Claude: ${String(error)}`)
  }
}

async function toggleAutoOpen($: EngineInterface): Promise<void> {
  const mode = await read($, settings)
  await keepSettings($, { ...mode, autoOpen: !mode.autoOpen })
}

async function toggleAsk($: EngineInterface): Promise<void> {
  const mode = await read($, settings)
  await keepSettings($, { ...mode, askBeforeAdd: !mode.askBeforeAdd })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    await update($, confirming, () => null)
    await $.command.register({ name: 'passport', description: 'Открыть паспорт проекта: клиент, язык общения, правила и тонкости' })
    await $.tool.register({ name: 'passport_update', description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    const current = await read($, passport)
    const mode = await read($, settings)
    if (mode.autoOpen && (current.notes.length > 0 || current.replyLanguage !== null)) void openPane($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'passport' }, async $ => {
    await openPane($)
    return { text: 'Паспорт проекта открыт.' }
  })

  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    return { ...context, blocks: [...context.blocks, { name: 'projectPassport', text: briefing(await read($, passport), TOOL) }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { add?: unknown; remove?: unknown; replyLanguage?: unknown }
    const current = await read($, passport)
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
    let next = current
    for (const note of removes) next = removeNote(next, note.id)
    for (const add of adds) next = addNote(next, { ...add, at, by: 'claude' })
    if (replyLanguage !== undefined) next = { ...next, replyLanguage }
    await keep($, next)
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

    const heading = (key: string, text: string) => (
      <Box key={key} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {heading('h-title', 'ПАСПОРТ ПРОЕКТА')}
        <Text>{name}</Text>

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
              {heading(`h-${section.id}`, section.title.toUpperCase())}
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
                    <Box flexGrow={1}>
                      <Text wrap="wrap">
                        • {note.text}
                        {note.by === 'claude' ? <Text dimColor> · Claude</Text> : ''}
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
                {/* The field and its button on one row: the field takes the width, the button stays at its right. */}
                <Box gap={1} alignItems="center">
                  <Box flexGrow={1}>
                    <Input
                      key="pp-text"
                      placeholder="Например: Денису пишем по-английски, коротко и без смайлов"
                      value={form.text}
                      onInput={value => void editDraft($, { text: value })}
                      onSubmit={value => void editDraft($, { text: value }).then(() => personAdd($))}
                    />
                  </Box>
                  <Box flexShrink={0}>
                    <Button key="pp-add" label="Добавить" onPress={() => void personAdd($)} />
                  </Box>
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
          {heading('h-fill', 'ЗАПОЛНИТЬ ИЗ ПРОЕКТА')}
          <Text dimColor wrap="wrap">
            Claude прочитает README, файлы проекта, деплой и git и сам запишет, что найдёт. Чего из файлов не понять, спросит у тебя.
          </Text>
          <Box marginTop={1}>
            <Button key="pp-fill" variant="primary" label={isEmpty ? 'Заполнить из проекта' : 'Дополнить из проекта'} onPress={() => void fill($)} />
          </Box>
        </Box>

        <Box marginTop={2} marginBottom={1} flexDirection="column">
          {heading('h-settings', 'НАСТРОЙКИ')}
          <Box justifyContent="space-between">
            <Text>Открывать при старте чата</Text>
            <Button key="pp-autoopen" label={mode.autoOpen ? 'да' : 'нет'} onPress={() => void toggleAutoOpen($)} />
          </Box>
          <Box marginTop={1} justifyContent="space-between">
            <Text>Записи Claude</Text>
            <Button key="pp-ask" label={mode.askBeforeAdd ? 'с вопросом' : 'без вопроса'} onPress={() => void toggleAsk($)} />
          </Box>
        </Box>
      </Box>
    )
  })
}
