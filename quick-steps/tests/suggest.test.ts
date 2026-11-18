import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { cheapPrompt, clipMiddle, conversationExcerpt, digitPress } from '../hooks/suggest'

function message(role: 'user' | 'assistant', text: string, tools: string[] = []): SessionMessage {
  return { role, text, toolUses: tools.map((tool, index) => ({ tool_use_id: `u${index}`, tool, input: {} })) }
}

test('the excerpt holds the user messages, the earlier answers and the answer just given, in order', () => {
  const answer = 'Готово: поправил цифры.\n\nЗакоммитить?'
  const excerpt = conversationExcerpt(
    [message('user', 'Починить цифры'), message('assistant', 'Смотрю код.'), message('user', 'Давай быстрее'), message('assistant', answer)],
    answer,
  )
  expect(excerpt.indexOf('Починить цифры')).toBeLessThan(excerpt.indexOf('Смотрю код.'))
  expect(excerpt.indexOf('Смотрю код.')).toBeLessThan(excerpt.indexOf('Давай быстрее'))
  expect(excerpt.indexOf('Давай быстрее')).toBeLessThan(excerpt.indexOf('[assistant, the answer just given]'))
  // The transcript's copy of the answer is dropped: it is shown once, last.
  expect(excerpt.split('Закоммитить?')).toHaveLength(2)
})

test('the end of a long answer survives, where the question or the offer is', () => {
  const answer = `${'начало '.repeat(2000)}ЧТО ДЕЛАЕМ ДАЛЬШЕ: 1. тесты 2. коммит`
  const excerpt = conversationExcerpt([message('user', 'Сделай'), message('assistant', answer)], answer)
  expect(excerpt).toContain('ЧТО ДЕЛАЕМ ДАЛЬШЕ: 1. тесты 2. коммит')
  expect(excerpt).toContain('[…cut…]')
  expect(excerpt.length).toBeLessThan(9000)
})

test('what the assistant did while answering is named, and harness reminders are left out', () => {
  const excerpt = conversationExcerpt(
    [
      message('user', 'Поправь файл<system-reminder>секретная вставка харнесса</system-reminder>'),
      message('assistant', '', ['Read', 'Edit', 'Edit', 'Bash']),
      message('assistant', 'Файл поправлен.'),
    ],
    'Файл поправлен.',
  )
  expect(excerpt).toContain('the assistant used: Edit×2, Read, Bash')
  expect(excerpt).toContain('Поправь файл')
  expect(excerpt).not.toContain('секретная вставка')
})

test('terminal escapes are stripped before the text goes to the model', () => {
  const excerpt = conversationExcerpt([message('user', 'привет\x1b[31m красный\x1b[0m')], 'Ок, привет.')
  expect(excerpt).not.toContain('\x1b')
  expect(excerpt).toContain('привет красный')
})

test('clipMiddle keeps both ends and leaves a short text alone', () => {
  expect(clipMiddle('коротко', 100)).toBe('коротко')
  const clipped = clipMiddle(`начало ${'-'.repeat(500)} конец`, 60)
  expect(clipped.startsWith('начало')).toBe(true)
  expect(clipped.endsWith('конец')).toBe(true)
})

test('the prompt carries the rules, the skills only when there are any, and the conversation as data', () => {
  const base = { conversation: '[user]\nпривет', maxSuggestions: 3, maxChars: 160 }
  const bare = cheapPrompt({ ...base, skills: '' })
  expect(bare.system).toContain('ONLY a JSON array')
  expect(bare.prompt).toContain('Order them best first: the first one is the step you recommend.')
  expect(bare.prompt).toContain('up to 3 concrete prompts')
  expect(bare.prompt).toContain('at most 160 characters')
  expect(bare.prompt).toContain('never rewordings of one step')
  expect(bare.prompt).toContain('<conversation>\n[user]\nпривет\n</conversation>')
  expect(bare.prompt).not.toContain('<available-skills>')

  const withSkills = cheapPrompt({ ...base, skills: '/report: Отчёт клиенту' })
  expect(withSkills.prompt).toContain('<available-skills>\n/report: Отчёт клиенту\n</available-skills>')
})

const OFFER = ['Прогони тесты', 'Закоммить']

test('a single digit key in the empty box presses that suggestion; 0 hides them', () => {
  const key = (digit: string) => ({ text: '', inputText: digit, key: { key: digit } })
  expect(digitPress(OFFER, key('1'))).toEqual({ kind: 'send', item: 'Прогони тесты' })
  expect(digitPress(OFFER, key('2'))).toEqual({ kind: 'send', item: 'Закоммить' })
  expect(digitPress(OFFER, key('0'))).toEqual({ kind: 'hide' })
})

test('everything else is an ordinary edit', () => {
  const edit = { text: '', inputText: '1', key: { key: '1' } }
  expect(digitPress(OFFER, { ...edit, text: 'а' })).toBeUndefined()
  expect(digitPress(OFFER, { ...edit, key: undefined })).toBeUndefined()
  expect(digitPress(OFFER, { ...edit, key: { key: '1', ctrl: true } })).toBeUndefined()
  expect(digitPress(OFFER, { ...edit, key: { key: '1', meta: true } })).toBeUndefined()
  expect(digitPress(OFFER, { ...edit, inputText: '3', key: { key: '3' } })).toBeUndefined()
  expect(digitPress(OFFER, { ...edit, inputText: '12' })).toBeUndefined()
  expect(digitPress(OFFER, { ...edit, inputText: 'а' })).toBeUndefined()
  expect(digitPress([], edit)).toBeUndefined()
})
