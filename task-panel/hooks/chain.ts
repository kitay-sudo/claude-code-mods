// A big task worked through files, each stage ending in one the next one
// reads: INTENT.md (what we want and why, from an interview), SPEC.md (the
// requirements and how the solution is built), PLAN.md (files, order, risks,
// checks), then the work, started from the files rather than the chat. They
// live in the project, `intent/<date>-<name>/`, so a new chat picks them up.
//
// Plain data: no `$`, so tests read it directly.

import type { Chain, ChainStage } from '../types'

export const INTENT_DIR = 'intent'
const FILES = { intent: 'INTENT.md', spec: 'SPEC.md', plan: 'PLAN.md' } as const

/** A big task's folder as listed: which of its files are there. */
export function chainOf(name: string, files: readonly string[]): Chain {
  const has = (file: string) => files.some(one => one.toLowerCase() === file.toLowerCase())
  return { name, dir: `${INTENT_DIR}/${name}`, hasIntent: has(FILES.intent), hasSpec: has(FILES.spec), hasPlan: has(FILES.plan) }
}

/** The newest folder under `intent/` that is not closed: by its date prefix, then by name. */
export function newestOpen(folders: readonly string[], closed: readonly string[]): string | null {
  const open = folders.filter(name => !closed.includes(name)).sort((a, b) => b.localeCompare(a))
  return open[0] ?? null
}

/** The stage the big task is at: the first of its files that is missing, else the work. */
export function stageOf(chain: Chain): ChainStage {
  if (!chain.hasIntent) return 'intent'
  if (!chain.hasSpec) return 'spec'
  if (!chain.hasPlan) return 'plan'
  return 'work'
}

export const STAGES: readonly { id: ChainStage; title: string }[] = [
  { id: 'intent', title: 'Намерение' },
  { id: 'spec', title: 'Спецификация' },
  { id: 'plan', title: 'План' },
  { id: 'work', title: 'Работа' },
]

/** YYYY-MM-DD of a day, for a new folder's name. */
export function dayOf(ms: number): string {
  const at = new Date(ms)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

const KEEP_CLIENT_OUT =
  'Клиентские тонкости (деньги, договорённости, личное) в эти файлы не пиши, они живут в паспорте проекта.'

/** Stage 1: the interview, then INTENT.md. */
export function intentPrompt(task: string, today: string): string {
  const what = task.trim() === '' ? 'Сначала спроси меня, что делаем.' : `Задача: ${task.trim()}`
  return [
    `Большая задача, работаем через намерение. ${what}`,
    'Проведи со мной интервью: задавай вопросы по одному-два, пока не закроешь все пробелы. Зачем это, для кого, ' +
      'что должно получиться, какие системы и файлы затронет, что нельзя ломать, какие ограничения. Не додумывай за ' +
      'меня: чего не знаешь, спроси или запиши в открытые вопросы.',
    `Потом запиши файл ${INTENT_DIR}/${today}-<коротко латиницей через дефис>/${FILES.intent} с разделами: Проблема, ` +
      'Нужный результат, Кого касается, Что затронет, Ограничения, Открытые вопросы, и в конце "Готово, когда": ' +
      '2-5 проверяемых пунктов. Пиши моими словами, без решений и без кода.',
    KEEP_CLIENT_OUT,
    'Код пока не трогай. Когда файл готов, попроси меня его прочитать и поправить.',
  ].join('\n\n')
}

/** Stage 2: SPEC.md from the intent. */
export function specPrompt(chain: Chain): string {
  return [
    `Прочитай ${chain.dir}/${FILES.intent} и составь ${chain.dir}/${FILES.spec}: требования и устройство решения ` +
      '(архитектура, данные, интерфейс, безопасность), чтобы его можно было сразу отдать исполнителю. Учти CLAUDE.md проекта.',
    'Отдельно перечисли спорные места, особенно где требования противоречат друг другу.',
    KEEP_CLIENT_OUT,
    'Код пока не трогай.',
  ].join('\n\n')
}

/** Stage 3: PLAN.md, and the plan questioned. */
export function planPrompt(chain: Chain): string {
  return [
    `Прочитай ${chain.dir}/${FILES.intent} и ${chain.dir}/${FILES.spec} и составь ${chain.dir}/${FILES.plan}. ` +
      `В заголовке ссылка на ${FILES.intent}. Разделы: Файлы (какие появятся и изменятся), Порядок работ, Риски, ` +
      `Проверка (пункты, которые докажут, что результат из ${FILES.intent} достигнут).`,
    'Потом сам ответь мне на три вопроса: что это может сломать, какой шаг самый рискованный, что ты отбросил и почему.',
    'Код пока не трогай.',
  ].join('\n\n')
}

/** Stage 4: the work, from the files. Meant for a fresh chat. */
export function workPrompt(chain: Chain): string {
  return [
    `Реализуй план из ${chain.dir}/${FILES.plan}. Контекст: ${chain.dir}/${FILES.intent} и ${chain.dir}/${FILES.spec}.`,
    `Пункты раздела "Проверка" из ${FILES.plan} передай в пульт как критерии "готово, когда". ` +
      `Если отойдёшь от плана, обнови ${FILES.plan}.`,
    'В конце пройди все пункты проверки и отчитайся по каждому: выполнено или нет и где это видно.',
  ].join('\n\n')
}

/** What the model reads at a chat's start while a big task is open. */
export function chainBriefing(chain: Chain): string {
  const files = [chain.hasIntent ? FILES.intent : '', chain.hasSpec ? FILES.spec : '', chain.hasPlan ? FILES.plan : ''].filter(Boolean)
  return (
    `An open big task of this project lives in ${chain.dir}/ (${files.length === 0 ? 'no files yet' : files.join(', ')}). ` +
    'Before working on it, read these files. Keep to the goal in INTENT.md: if a request would break it, say so before doing it. ' +
    'Deviations from the plan go into PLAN.md.'
  )
}
