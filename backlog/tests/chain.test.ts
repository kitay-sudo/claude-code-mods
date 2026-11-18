import { expect, test } from 'claude-code/testing'

import { chainBriefing, chainOf, dayOf, intentPrompt, newestOpen, planPrompt, specPrompt, stageOf, workPrompt } from '../hooks/chain'

test('a big task is at the stage of its first missing file', () => {
  const fresh = chainOf('2026-10-12-otchety', [])
  expect(fresh.dir).toBe('intent/2026-10-12-otchety')
  expect(stageOf(fresh)).toBe('intent')
  expect(stageOf(chainOf('x', ['intent.md']))).toBe('spec')
  expect(stageOf(chainOf('x', ['INTENT.md', 'SPEC.md']))).toBe('plan')
  expect(stageOf(chainOf('x', ['INTENT.md', 'SPEC.md', 'PLAN.md', 'notes.txt']))).toBe('work')
})

test('the open big task is the newest folder not closed', () => {
  const folders = ['2026-10-01-forma', '2026-10-12-otchety', '2026-10-05-oplata']
  expect(newestOpen(folders, [])).toBe('2026-10-12-otchety')
  expect(newestOpen(folders, ['2026-10-12-otchety'])).toBe('2026-10-05-oplata')
  expect(newestOpen([], [])).toBeNull()
  expect(dayOf(new Date(2026, 9, 12, 23, 59).getTime())).toBe('2026-10-12')
})

test('each stage asks for its file, and keeps the client out of the repository', () => {
  const intent = intentPrompt('отчёты по продажам', '2026-10-12')
  for (const part of ['Задача: отчёты по продажам', 'Проведи со мной интервью', 'intent/2026-10-12-', 'Проблема', 'Нужный результат', 'Кого касается', 'Что затронет', 'Ограничения', 'Открытые вопросы', '"Готово, когда"', 'паспорте проекта', 'Код пока не трогай']) {
    expect(intent).toContain(part)
  }
  expect(intentPrompt('', '2026-10-12')).toContain('Сначала спроси меня, что делаем.')

  const chain = chainOf('2026-10-12-otchety', ['INTENT.md', 'SPEC.md', 'PLAN.md'])
  expect(specPrompt(chain)).toContain('Прочитай intent/2026-10-12-otchety/INTENT.md и составь intent/2026-10-12-otchety/SPEC.md')
  expect(specPrompt(chain)).toContain('спорные места')
  expect(planPrompt(chain)).toContain('что это может сломать, какой шаг самый рискованный, что ты отбросил и почему')
  expect(workPrompt(chain)).toContain('Реализуй план из intent/2026-10-12-otchety/PLAN.md')
  expect(workPrompt(chain)).toContain('отчитайся по каждому')
  expect(chainBriefing(chain)).toContain('intent/2026-10-12-otchety/ (INTENT.md, SPEC.md, PLAN.md)')
  // The prompts follow the person's style: no long dashes.
  for (const text of [intent, specPrompt(chain), planPrompt(chain), workPrompt(chain)]) expect(text).not.toMatch(/[—–]/)
})
