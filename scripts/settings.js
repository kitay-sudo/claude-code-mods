// Points Claude at the mods folder: every mod loads straight from it and every
// chat watches it, so an edit reaches open chats by itself.
//
//   node scripts/settings.js <settings.json> <mod folder>;<mod folder>;...
//
// Only the two env keys change; the rest of the settings is kept as it is.

const fs = require('fs')

const [file, dirs] = process.argv.slice(2)
if (file === undefined || dirs === undefined) {
  console.error('usage: node scripts/settings.js <settings.json> <dirs>')
  process.exit(2)
}

let settings = {}
if (fs.existsSync(file)) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  settings = text.trim() === '' ? {} : JSON.parse(text)
}
settings.env = { ...(settings.env ?? {}), CLAUDE_CODE_PLUGIN_DIRS: dirs, CLAUDE_CODE_PLUGIN_DIR_WATCH: '1' }
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
console.log(`settings: ${dirs.split(';').length} mods load from their folders, watched`)
