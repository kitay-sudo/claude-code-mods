import { expect, test } from 'claude-code/testing'

import { addNote, briefing, checkText, emptyPassport, looksSecret, restore, whenText } from '../hooks/notes'
import type { Passport } from '../types'

test('a note is one short line, and never a secret', () => {
  expect(checkText('  Денису пишем\n по-английски  ')).toEqual({ text: 'Денису пишем по-английски' })
  expect('error' in checkText('')).toBe(true)
  expect('error' in checkText('x'.repeat(401))).toBe(true)
  for (const secret of [
    'ключ openai sk-proj-AbCdEfGhIjKlMnOpQrSt',
    'пароль: hunter2',
    'API key = 0123456789abcdef0123456789abcdef',
    'token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]) {
    expect(looksSecret(secret)).toBe(true)
  }
  expect(looksSecret('Админка: /admin, вход через Google')).toBe(false)
})

test('the same note is not kept twice, and ids keep counting', () => {
  let passport = emptyPassport()
  passport = addNote(passport, { section: 'rules', text: 'Логотип не трогать', at: 1, by: 'person' })
  passport = addNote(passport, { section: 'rules', text: 'логотип не трогать', at: 2, by: 'claude' })
  passport = addNote(passport, { section: 'client', text: 'Клиент: Денис', at: 3, by: 'person' })
  expect(passport.notes.map(note => note.id)).toEqual(['n1', 'n2'])
  expect(restore(JSON.parse(JSON.stringify(passport))).next).toBe(3)
  expect(restore({ notes: [{ id: 'n9', section: 'nowhere', text: 'x' }, { id: 'n4', section: 'rules', text: 'пароль: 1' }] }).notes).toEqual([])
})

test('the model reads the passport by section, the client language first', () => {
  let passport: Passport = { ...emptyPassport(), replyLanguage: 'en' }
  passport = addNote(passport, { section: 'client', text: 'Клиент: Денис, Молдова', at: 1, by: 'person' })
  passport = addNote(passport, { section: 'rules', text: 'Логотип не трогать', at: 2, by: 'claude' })
  const text = briefing(passport, 'mcp__project-passport__passport_update')
  expect(text).toContain('Messages and reports for the client are written in English.')
  expect(text).toContain('Клиент и общение:\n- [n1] Клиент: Денис, Молдова')
  expect(text).toContain('Правила и тонкости:\n- [n2] Логотип не трогать')
  expect(briefing(emptyPassport(), 'tool')).toContain('This project has no passport yet')
})

test('a passport from before the marks counts as filled when Claude wrote in it', () => {
  const old = { replyLanguage: null, next: 3, notes: [{ id: 'n1', section: 'client', text: 'Клиент: Денис', at: 7, by: 'claude' }] }
  expect(restore(old).ran).toEqual({ fill: 7, sort: null, update: null })
  expect(restore({ ...old, notes: [{ ...old.notes[0], by: 'person' }] }).ran.fill).toBeNull()
  expect(restore({ ...old, ran: { fill: null, sort: 9 } }).ran).toEqual({ fill: null, sort: 9, update: null })
})

test('the last update reads as today or as a date', () => {
  const at = new Date(2026, 9, 13, 9, 5).getTime()
  expect(whenText(at, new Date(2026, 9, 13, 18, 0).getTime())).toBe('сегодня в 09:05')
  expect(whenText(at, new Date(2026, 9, 15, 10, 0).getTime())).toBe('13.10 в 09:05')
})
