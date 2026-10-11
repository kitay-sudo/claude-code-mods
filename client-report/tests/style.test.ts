import { expect, test } from 'claude-code/testing'

import { STYLE_RULES, humanize, parseArgs, reportPrompt, rewritePrompt, utf16Base64 } from '../hooks/style'

test('a report reads as typed by a person: no dashes or curly quotes, numbered lists with air, 🪴 first', () => {
  const raw = [
    'Вот отчёт для клиента:',
    '',
    '```text',
    '🪴 **Сайт стал быстрее** — главная грузится за 1 секунду…',
    '',
    '',
    '',
    '## Что готово:',
    '• Починил форму «Заявка» – теперь письма доходят',
    '— Обновил “прайс” и ‘контакты’',
    '* Кнопка звонка 2—3 раза больше',
    'Что нужно от вас:',
    '- Прислать новые фото',
    '```',
  ].join('\n')
  expect(humanize(raw)).toBe(
    [
      '🪴 Сайт стал быстрее - главная грузится за 1 секунду...',
      '',
      'Что готово:',
      '',
      '1. Починил форму "Заявка" - теперь письма доходят',
      '',
      '2. Обновил "прайс" и \'контакты\'',
      '',
      '3. Кнопка звонка 2-3 раза больше',
      '',
      'Что нужно от вас:',
      '',
      'Прислать новые фото',
    ].join('\n'),
  )
  // Numbered already, with or without blank lines between: numbered afresh, one blank line each.
  expect(humanize('🪴 Итог\nЧто осталось:\n\n1) Тексты\n\n\n3. Фото\n10.10 созвон')).toBe(
    '🪴 Итог\n\nЧто осталось:\n\n1. Тексты\n\n2. Фото\n\n10.10 созвон',
  )
  expect(humanize('Сделал оплату картой.')).toBe('🪴 Сделал оплату картой.')
  expect(humanize('🪴 Готово.')).toBe('🪴 Готово.')
})

test('/report reads its language first and keeps the rest as a wish', () => {
  expect(parseArgs('')).toEqual({ language: 'auto', extra: '' })
  expect(parseArgs('en за неделю, коротко')).toEqual({ language: 'en', extra: 'за неделю, коротко' })
  expect(parseArgs('по-русски')).toEqual({ language: 'ru', extra: '' })
  expect(parseArgs('оба')).toEqual({ language: 'ru+en', extra: '' })
})

test('the model is told the rules, the period, the commits and not to invent', () => {
  const prompt = reportPrompt({ language: 'en', extra: 'без цифр' }, 'с прошлого отчёта (09.10)', '2026-10-10 fix: form mail')
  expect(prompt).toContain('от моего лица отчёт для клиента о работе по проекту с прошлого отчёта (09.10)')
  expect(prompt).toContain('"я", а не "мы"')
  expect(prompt).toContain('Что готово:\n\n1. ...\n\n2. ...')
  expect(prompt).toContain('Ничего не придумывай')
  expect(prompt).toContain('Коммиты за этот период:\n2026-10-10 fix: form mail')
  expect(prompt).toContain('Пиши по-английски.')
  expect(prompt).toContain('Пожелание к отчёту: без цифр')
  expect(prompt).toContain(STYLE_RULES)
  expect(reportPrompt({ language: 'auto', extra: '' }, 'за последние 7 дней', '')).not.toContain('Коммиты')
  expect(rewritePrompt('shorter', '🪴 Готово.')).toMatch(/^Не продолжай работу\. Сократи[\s\S]*🪴 Готово\.$/)
  // The rules themselves follow the rules: no long dashes, no curly quotes.
  expect(STYLE_RULES).not.toMatch(/[—–«»“”]/)
})

test('the clipboard text goes to PowerShell as UTF-16LE base64, emoji and all', () => {
  expect(utf16Base64('Hi')).toBe('SABpAA==')
  expect(utf16Base64('🪴 Я "ок"')).toBe('Pti03iAALwQgACIAPgQ6BCIA')
})
