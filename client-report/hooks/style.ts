// How a report for a client reads, and the clean-up that keeps it that way:
// plain data, no `$`, so tests read it directly.

export type Language = 'auto' | 'ru' | 'en' | 'ru+en'

export type ReportRequest = {
  language: Language
  /** What the person added after /report: "за неделю", "коротко", ... */
  extra: string
}

export const OPENER = '🪴'

/** The rules every message for a client follows, /report or not. */
export const STYLE_RULES = [
  'Как писать отчёты и сообщения клиенту:',
  '1. От лица пользователя, который отправит текст клиенту: "я", а не "мы". Род бери из того, как пользователь пишет о себе в разговоре. Если не видно, строй фразы без рода: "готово", "теперь работает". По-английски тоже "I", а не "we".',
  '2. Простой разговорный язык, как пишет живой человек в мессенджере. Без канцелярита и без оборотов вроде "в рамках", "осуществлено", "был реализован", "данный", "следует отметить", "таким образом".',
  '3. Короткие предложения и мало запятых: лучше два предложения, чем одно длинное.',
  '4. Никаких длинных тире. Где нужно, точка или запятая.',
  '5. Кавычки только прямые, вот такие: "пример". Никаких ёлочек и лапок.',
  '6. Без жирного, заголовков с решётками и другой разметки.',
  '7. Никаких "-" или "•" в начале строк. Несколько пунктов нумеруй: 1. 2. 3. Если пункт один, пиши его просто строкой.',
  '8. После заголовка вроде "Что готово:" и после каждого пункта пустая строка, чтобы текст не слипался.',
  '9. Пиши, что изменилось для клиента и его пользователей, а не названия файлов и функций.',
  `10. Отчёт начинается с ${OPENER}.`,
  '11. По-английски так же: просто, дружелюбно, короткими фразами, без длинных тире, кавычки прямые.',
].join('\n')

const LANGUAGE_WORDS: [RegExp, Language][] = [
  [/^(ru\+en|en\+ru|оба|два|двух|обоих)$/i, 'ru+en'],
  [/^(en|eng|english|англ|английский|английском|по-английски)$/i, 'en'],
  [/^(ru|rus|рус|русский|русском|по-русски)$/i, 'ru'],
]

/** `/report en за неделю` → English, "за неделю". */
export function parseArgs(args: string): ReportRequest {
  let language: Language = 'auto'
  const rest: string[] = []
  for (const word of args.trim().split(/\s+/).filter(Boolean)) {
    const found = LANGUAGE_WORDS.find(([test]) => test.test(word))
    if (found !== undefined && language === 'auto') language = found[1]
    else rest.push(word)
  }
  return { language, extra: rest.join(' ') }
}

function languageRule(language: Language): string {
  if (language === 'ru') return 'Пиши по-русски.'
  if (language === 'en') return 'Пиши по-английски.'
  if (language === 'ru+en') return `Сначала напиши отчёт по-русски, потом тот же отчёт по-английски. Каждый начинай с ${OPENER}.`
  return 'Пиши на языке, который указан для клиента в паспорте проекта, если он есть в разговоре. Если не указан, пиши по-русски.'
}

/** What the fork of the session is asked for a fresh report. */
export function reportPrompt(request: ReportRequest, period: string, commits: string): string {
  return [
    `Не продолжай работу. Напиши от моего лица отчёт для клиента о работе по проекту ${period}.`,
    'Опирайся только на то, что реально сделано в этом разговоре, и на коммиты ниже. Ничего не придумывай. Если что-то не доделано, так и скажи.',
    commits === '' ? '' : `Коммиты за этот период:\n${commits}`,
    languageRule(request.language),
    request.extra === '' ? '' : `Пожелание к отчёту: ${request.extra}`,
    [
      'Структура, пустые части пропускай:',
      `${OPENER} одна строка о главном`,
      '',
      'Что готово:',
      '',
      '1. ...',
      '',
      '2. ...',
      '',
      'Что осталось:',
      '',
      '1. ...',
      '',
      'Что нужно от вас:',
      '',
      '1. ...',
    ].join('\n'),
    STYLE_RULES,
    'Ответь только текстом отчёта, без пояснений до и после.',
  ]
    .filter(part => part !== '')
    .join('\n\n')
}

/** What the fork is asked to change an existing report. */
export function rewritePrompt(change: 'shorter' | 'ru' | 'en', report: string): string {
  const ask =
    change === 'shorter'
      ? 'Сократи этот отчёт для клиента примерно вдвое. Оставь главное.'
      : change === 'en'
        ? 'Переведи этот отчёт для клиента на английский.'
        : 'Переведи этот отчёт для клиента на русский.'
  return [`Не продолжай работу. ${ask}`, STYLE_RULES, 'Ответь только текстом отчёта, без пояснений до и после.', report].join('\n\n')
}

const ITEM = /^(?:-|\d{1,2}[.)])\s+(.*)$/

/**
 * One block per line with a blank line between, so nothing sticks together:
 * a run of list items numbered 1. 2. 3., a lone item left as a plain line.
 */
function layout(text: string): string {
  const blocks: string[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length === 1) blocks.push(items[0] ?? '')
    else items.forEach((item, i) => blocks.push(`${i + 1}. ${item}`))
    items = []
  }
  for (const line of text.split('\n').map(one => one.trim())) {
    if (line === '') continue
    const item = ITEM.exec(line)
    if (item !== null) items.push(item[1] ?? '')
    else {
      flush()
      blocks.push(line)
    }
  }
  flush()
  return blocks.join('\n\n')
}

/**
 * The report as a person would type it: long dashes made hyphens, typographic
 * quotes made straight, markup dropped, lists numbered with air between, and
 * the opener first.
 */
export function humanize(raw: string): string {
  // Code fence lines go: the report is copied as plain text.
  let text = raw.replace(/\r\n/g, '\n').replace(/^[ \t]*```[a-z]*[ \t]*$/gim, '').trim()
  // A short "Вот отчёт:" before the opener is the model talking, not the report.
  const opener = text.indexOf(OPENER)
  if (opener > 0 && opener < 200) text = text.slice(opener)
  text = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[—–•*][ \t]+/gm, '- ')
    .replace(/[ \t]*[—–][ \t]*/g, match => (/[ \t]/.test(match) ? ' - ' : '-'))
    .replace(/[«»“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/…/g, '...')
  text = layout(text)
  return text.startsWith(OPENER) ? text : `${OPENER} ${text}`
}

/** Base64 of the text's UTF-16LE code units, as PowerShell's Unicode decoding reads it. */
export function utf16Base64(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes.push(code & 0xff, code >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const chunk = (a << 16) | (b << 8) | c
    out += alphabet[(chunk >> 18) & 63]! + alphabet[(chunk >> 12) & 63]!
    out += i + 1 < bytes.length ? alphabet[(chunk >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? alphabet[chunk & 63]! : '='
  }
  return out
}
