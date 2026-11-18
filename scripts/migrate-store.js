// Moves the data of renamed mods to their new names, once: task-panel's
// backlogs to backlog, project-passport's notes to project-memory (its
// sections in order, the client's language as a note of its own).
//
//   node scripts/migrate-store.js <store folder>
//
// The old files stay as they are, and a key already in a new file is kept:
// running it again changes nothing.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const [store] = process.argv.slice(2)
if (store === undefined) {
  console.error('usage: node scripts/migrate-store.js <store folder>')
  process.exit(2)
}

const fileOf = name =>
  path.join(store, `${name}_inline-${crypto.createHash('sha256').update(`${name}@inline`).digest('hex').slice(0, 12)}.json`)

/** The old mod's data: its file of the folder scheme, else one from the marketplace days. */
function oldFileOf(name) {
  if (fs.existsSync(fileOf(name))) return fileOf(name)
  const market = fs.readdirSync(store).find(file => file.startsWith(`${name}_local-mods-`) && file.endsWith('.json'))
  return market === undefined ? fileOf(name) : path.join(store, market)
}

function read(file) {
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim()
  return text === '' ? {} : JSON.parse(text)
}

const LANGUAGE = {
  ru: 'Клиенту пишем по-русски',
  en: 'Клиенту пишем по-английски',
  'ru+en': 'Клиенту пишем на двух языках: русский и английский',
}
const SECTIONS = ['client', 'project', 'rules', 'places']

/** A passport as the project's memory: one list, the language first, the sections in their order. */
function memoryOf(passport) {
  const notes = []
  const add = (text, at, by) => notes.push({ id: `n${notes.length + 1}`, text, at, by })
  if (LANGUAGE[passport.replyLanguage] !== undefined) add(LANGUAGE[passport.replyLanguage], Date.now(), 'person')
  const kept = Array.isArray(passport.notes) ? passport.notes : []
  for (const section of SECTIONS) {
    for (const note of kept.filter(one => one.section === section)) {
      if (typeof note.text === 'string' && note.text.trim() !== '') add(note.text, Number(note.at) || 0, note.by === 'person' ? 'person' : 'claude')
    }
  }
  return notes.length === 0 ? null : { notes, next: notes.length + 1 }
}

function move(from, to, convert) {
  const old = read(oldFileOf(from))
  if (old === null) return 0
  const target = read(fileOf(to)) ?? {}
  let moved = 0
  for (const [key, value] of Object.entries(old)) {
    const pair = convert(key, value)
    if (pair === null || pair[1] === null || pair[0] in target) continue
    target[pair[0]] = pair[1]
    moved++
  }
  if (moved > 0) fs.writeFileSync(fileOf(to), JSON.stringify(target))
  return moved
}

const backlogs = move('task-panel', 'backlog', (key, value) => (key.startsWith('backlog:') ? [key, value] : null))
const memories = move('project-passport', 'project-memory', (key, value) =>
  key.startsWith('passport:') ? [`memory:${key.slice('passport:'.length)}`, memoryOf(value)] : null,
)
console.log(`перенесено: бэклогов ${backlogs}, паспортов в память проекта ${memories}`)
