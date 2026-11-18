import { expect, test } from 'claude-code/testing'

import { OPENER, reportPrompt } from '../hooks/report'

const prompt = reportPrompt({ id: 'b7', text: 'Поправить письма клиентам' })

test('the prompt names the task and holds Claude to what really happened', () => {
  expect(prompt).toContain('[b7]: Поправить письма клиентам')
  expect(prompt).toContain('git log')
  expect(prompt).toContain('Ничего не придумывай')
  // Without traces of the work it asks rather than guesses.
  expect(prompt).toContain('не пиши наугад')
})

test('the rules ask for a person to a person: first person, plain words, no code talk, no dashes', () => {
  for (const rule of [
    '"я", а не "мы"',
    'как в мессенджере',
    'Без шаблонов нейросети',
    'Без технических подробностей',
    'Никаких длинных тире',
    'Кавычки только прямые',
    'Без жирного, заголовков с решётками',
    'Без "-" и "•" в начале и без точки в конце',
  ]) {
    expect(prompt).toContain(rule)
  }
})

test('the report starts with the mark and the project version, and comes back as one code block', () => {
  expect(prompt).toContain(`Первая строка: ${OPENER} и версия проекта вида v1.2.3 из поля version в package.json`)
  expect(prompt).toContain('в одном блоке кода ```text')
  expect(prompt).toContain('До и после блока ничего не пиши')
})

test('the example shows the voice and the list layout, and itself follows the rules', () => {
  const example = prompt.slice(prompt.indexOf('Пример тона'), prompt.indexOf('Ответь только отчётом'))
  expect(example).toContain(`${OPENER} v1.4.0`)
  expect(example).toContain('Что теперь работает:\n\nНовые письма уходят сразу\n\nСписок отправленных открывается за секунду')
  // No long dashes, no typographic quotes, no bullets in what it teaches by.
  expect(example).not.toMatch(/[—–«»“”„]/)
  expect(example).not.toMatch(/^[-•*] /m)
})
