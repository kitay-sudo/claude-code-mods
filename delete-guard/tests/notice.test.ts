import { expect, test } from 'claude-code/testing'

import { RELOAD_NOTICE } from '../hooks/register'

test('only hot-reload notices are taken off the chat', () => {
  expect(RELOAD_NOTICE.test('quick-steps plugin.json changed — reloaded (modules: hooks\\register.tsx unchanged; 4 hooks: turn.start)')).toBe(true)
  expect(RELOAD_NOTICE.test('task-panel hooks/register.tsx changed - reloaded')).toBe(true)
  // Failures stay in the chat: they say why a mod does nothing.
  expect(RELOAD_NOTICE.test('task-panel: ui.render (Pane) refused: bad tree; the engine drew its own')).toBe(false)
  expect(RELOAD_NOTICE.test('server-panel: module did not load: SyntaxError')).toBe(false)
  expect(RELOAD_NOTICE.test('Удаление остановлено')).toBe(false)
})
