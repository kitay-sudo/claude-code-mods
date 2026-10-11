// What a passport may hold and how the model reads it, as plain data: no `$`,
// so tests read it directly.

import type { Note, Passport, Section } from '../types'

export const SECTIONS: readonly { id: Section; title: string; hint: string }[] = [
  { id: 'client', title: 'Клиент и общение', hint: 'кто клиент, как и на каком языке с ним общаться, договорённости и деньги' },
  { id: 'project', title: 'О проекте', hint: 'одной строкой, что это за проект для клиента. Стек и устройство живут в CLAUDE.md' },
  { id: 'rules', title: 'Правила и тонкости', hint: 'договорённости с клиентом: что можно и чего нельзя. Правила по коду живут в CLAUDE.md' },
  { id: 'places', title: 'Где что лежит', hint: 'админка, серверы, документы, тестовые входы без паролей' },
]

export const LANGUAGES = { ru: 'по-русски', en: 'по-английски', 'ru+en': 'на двух языках: русский и английский' } as const

const TEXT_MAX = 400

// Secrets never go into a passport: it is read back into every conversation.
const SECRETS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /\b[a-f0-9]{32,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(парол[ья]|password|passwd|pwd|token|токен|secret|api[_ -]?key|ключ api)\s*[:=]\s*\S+/i,
]

export function isSection(value: unknown): value is Section {
  return SECTIONS.some(section => section.id === value)
}

export function looksSecret(text: string): boolean {
  return SECRETS.some(test => test.test(text))
}

/** A note's text as kept: one line, trimmed, short; or why it cannot be kept. */
export function checkText(raw: unknown): { text: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'нужен текст заметки' }
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text === '') return { error: 'пустая заметка' }
  if ([...text].length > TEXT_MAX) return { error: `заметка длиннее ${TEXT_MAX} символов: раздели на несколько` }
  if (looksSecret(text)) return { error: 'похоже на пароль, ключ или токен: их в паспорт не пишем' }
  return { text }
}

export function addNote(passport: Passport, note: Omit<Note, 'id'>): Passport {
  const same = passport.notes.some(one => one.section === note.section && one.text.toLowerCase() === note.text.toLowerCase())
  if (same) return passport
  return { ...passport, notes: [...passport.notes, { ...note, id: `n${passport.next}` }], next: passport.next + 1 }
}

export function removeNote(passport: Passport, id: string): Passport {
  return { ...passport, notes: passport.notes.filter(one => one.id !== id) }
}

export function emptyPassport(): Passport {
  return { replyLanguage: null, notes: [], next: 1 }
}

/** A passport read back from the store, anything malformed left out. */
export function restore(raw: unknown): Passport {
  const kept = (raw ?? {}) as { replyLanguage?: unknown; notes?: unknown; next?: unknown }
  const notes = Array.isArray(kept.notes)
    ? kept.notes.flatMap((one): Note[] => {
        const note = one as Partial<Note>
        const checked = checkText(note.text)
        if (typeof note.id !== 'string' || !isSection(note.section) || 'error' in checked) return []
        return [{ id: note.id, section: note.section, text: checked.text, at: Number(note.at) || 0, by: note.by === 'claude' ? 'claude' : 'person' }]
      })
    : []
  const language = kept.replyLanguage
  const highest = notes.reduce((top, note) => Math.max(top, Number(note.id.slice(1)) || 0), 0)
  return {
    replyLanguage: language === 'ru' || language === 'en' || language === 'ru+en' ? language : null,
    notes,
    next: Math.max(Number(kept.next) || 1, highest + 1),
  }
}

/** The passport as the model reads it at the start of every conversation. */
/**
 * Where a fact goes: the code in CLAUDE.md, which is in git; the client in the
 * passport, which is not, since the client may see the repository.
 */
export const WHERE =
  "Where things go: rules about the code and how to work with the repository (build, tests, structure, what not to touch in the code) belong in the project's CLAUDE.md, which is in git. " +
  'Everything about the client (who they are, language and tone, money, arrangements, private nuances) belongs in the project passport, ' +
  'never in CLAUDE.md, README or any other file of the repository: the client may see the repository. ' +
  'Do not copy into the passport what README or CLAUDE.md already say.'

export function briefing(passport: Passport, tool: string): string {
  const howToAdd =
    `When you learn a durable fact about the client or the arrangements (who the client is and how to talk to them, money, ` +
    `a private nuance, where something lives), or the user says «запомни», add it with ${tool}. Never store passwords, keys or tokens.`
  if (passport.notes.length === 0 && passport.replyLanguage === null) {
    return (
      'This project has no passport yet (project-passport). When the user asks to fill it, add only what the repository ' +
      'files do not tell: the client, how to talk to them, arrangements, where things live; ask the user for what you cannot find. ' +
      `${howToAdd}\n${WHERE}`
    )
  }
  const lines = ['Project passport (project-passport): facts and nuances of this project. Follow them.']
  if (passport.replyLanguage !== null) {
    lines.push(`Messages and reports for the client are written ${passport.replyLanguage === 'ru' ? 'in Russian' : passport.replyLanguage === 'en' ? 'in English' : 'in Russian and in English'}.`)
  }
  for (const section of SECTIONS) {
    const notes = passport.notes.filter(note => note.section === section.id)
    if (notes.length === 0) continue
    lines.push(`${section.title}:`)
    for (const note of notes) lines.push(`- [${note.id}] ${note.text}`)
  }
  lines.push(howToAdd, WHERE)
  return lines.join('\n')
}

/** What a batch of changes reads as in the confirm dialog. */
export function describeChanges(
  adds: readonly { section: Section; text: string }[],
  removes: readonly Note[],
  language: Passport['replyLanguage'] | undefined,
): string {
  const parts: string[] = []
  for (const add of adds) parts.push(`+ ${SECTIONS.find(one => one.id === add.section)?.title}: ${add.text}`)
  for (const note of removes) parts.push(`− ${note.text}`)
  if (language !== undefined && language !== null) parts.push(`клиенту пишем ${LANGUAGES[language]}`)
  return parts.join(' · ')
}
