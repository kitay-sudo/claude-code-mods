# 🧩 Мои моды для Claude Code

![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.284%2B-D97757?logo=claude&logoColor=white)
![моды](https://img.shields.io/badge/%D0%BC%D0%BE%D0%B4%D1%8B-8-8A2BE2)
![тесты](https://img.shields.io/badge/%D1%82%D0%B5%D1%81%D1%82%D1%8B-59%2F59-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)
![репозиторий](https://img.shields.io/badge/%D1%80%D0%B5%D0%BF%D0%BE%D0%B7%D0%B8%D1%82%D0%BE%D1%80%D0%B8%D0%B9-%D0%BF%D1%80%D0%B8%D0%B2%D0%B0%D1%82%D0%BD%D1%8B%D0%B9-555555?logo=github)

Восемь модов, которые я сделал под свою работу с Claude. Они стоят во всех сессиях сразу: Claude Code подключает эту папку как маркетплейс `local-mods` и грузит каждый мод прямо отсюда.

Число тестов в бейдже обновляет `check.ps1`, когда проверяет все моды.

## Что внутри

| Мод | Версия | Что делает | Где найти |
| --- | --- | --- | --- |
| ⏱ **cache-timer** | ![](https://img.shields.io/badge/v0.3.3-blue) | Сколько минут осталось до остывания кэша и сколько токенов в контексте. Кнопка "Сжать" запускает `/compact`. За 5 минут до остывания всплывает напоминание. | блок над полем ввода |
| 💸 **spend-meter** | ![](https://img.shields.io/badge/v0.4.2-blue) | Расход в рублях: сессия, проект, сегодня. В панели расход по дням, лимиты подписки и бюджет проекта с предупреждениями. Курс 87 ₽ за $, меняется в настройках мода. | блок над полем ввода, `/spend` |
| 🖥 **server-panel** | ![](https://img.shields.io/badge/v0.4.3-blue) | Сервер проекта: статус связи, деплой кнопкой или сам после `git push`. Подключение по ключу в один клик. Claude сам заходит на сервер и выполняет команды, каждую после подтверждения. | блок над полем ввода, `/server` |
| → **quick-steps** | ![](https://img.shields.io/badge/v0.4.1-blue) | После ответа до трёх подсказок "что дальше". Нажал цифру или кликнул, и запрос сразу ушёл. | блок над полем ввода |
| 📋 **task-panel** | ![](https://img.shields.io/badge/v0.3.0-blue) | Пульт задачи сбоку: шаги плана, что готово, процент и сколько идёт работа. Когда всё готово, становится зелёным. | `/task-panel`, открывается сам |
| 🛡 **delete-guard** | ![](https://img.shields.io/badge/v0.1.0-blue) | Перед любым удалением показывает, что удалится, сколько файлов и сколько весит. Без ответа "да" ничего не удаляет. | срабатывает сам |
| 📒 **project-passport** | ![](https://img.shields.io/badge/v0.1.0-blue) | Паспорт проекта: кто клиент, на каком языке ему писать, правила и тонкости, где что лежит. Claude читает его в начале каждого чата и дополняет с моего согласия. | `/passport` |
| 🪴 **client-report** | ![](https://img.shields.io/badge/v0.2.0-blue) | Отчёт клиенту от первого лица по этому чату и коммитам. Простыми словами, без длинных тире, кавычки прямые, пункты с номерами. Копируется одной кнопкой. | `/report` |

### Блок над полем ввода

Четыре мода рисуют один общий блок. Примерно так:

```text
⏱ кэш: 42 мин · контекст: 61k из 200k (31%)  [Сжать]      ₽ сессия 340 ₽ · проект 3 480 ₽ · сегодня 520 ₽

● prod  на связи · 48 мс · деплой 18:20 ✓  [Деплой] [Пульт]

→ дальше:
  1  Прогони тесты модуля auth
  2  Закоммить изменения
  0  скрыть
```

## Переезд на новый компьютер

Всё делается в PowerShell. Команды можно копировать как есть.

**1. Поставить Claude и войти в свой аккаунт.**

Приложение берётся на [claude.ai/download](https://claude.ai/download). Если нужен ещё и `claude` в терминале:

```powershell
irm https://claude.ai/install.ps1 | iex
```

**2. Поставить Git и GitHub CLI**, потом закрыть и заново открыть PowerShell.

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```

**3. Войти в GitHub.** Репозиторий приватный, без входа он не скачается.

```powershell
gh auth login
```

**4. Скачать моды в ту же папку, что и сейчас.**

```powershell
gh repo clone kitay-sudo/claude-code-mods "$env:USERPROFILE\.claude\mods"
```

**5. Поставить все моды одной командой.**

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\mods\install.ps1"
```

Скрипт подключит маркетплейс `local-mods` и поставит каждый мод во все сессии. Его можно запускать повторно, ничего не сломается.

**6. Перенести данные модов.** Это можно пропустить, тогда всё начнётся с нуля.

Там лежат расход по проектам, сохранённые серверы, паспорта проектов, последние отчёты и настройки модов. На старом компьютере скопируй файлы на флешку:

```powershell
Copy-Item "$env:USERPROFILE\.claude\plugins\store\*_local-mods-*.json" "E:\перенос\"
```

На новом закрой Claude и положи их на место:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\plugins\store" | Out-Null
Copy-Item "E:\перенос\*_local-mods-*.json" "$env:USERPROFILE\.claude\plugins\store\"
```

Имена файлов на новом компьютере будут те же, переименовывать ничего не надо. Паспорт, расход и серверы привязаны к пути проекта. Если проекты лежат по тем же путям (например `E:\OTHER-PROJECT\...`), всё подхватится само.

**7. Подключить серверы заново.** Проще всего так: открыть `/server`, выбрать сервер и нажать "Подключить". Мод сам сделает новый ключ и откроет окно, где сервер один раз спросит пароль.

Можно и перенести старый ключ `%USERPROFILE%\.ssh\server_panel_ed25519` вместе с `.pub`. Но только через флешку и никогда через репозиторий или чат.

**8. Проверить.** Открой новый чат. Над полем ввода должен появиться блок с кэшем и расходом, а команды `/report`, `/passport`, `/spend`, `/server` и `/task-panel` должны открываться.

**Если в терминальном `claude` моды не видны.** Моды в Claude Code пока в раннем доступе. В приложении Claude у меня они работают и так. Терминалу может понадобиться флаг:

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', '1', 'User')
```

## Каждый день

**Поправить мод**

1. Меняю файлы в папке мода и поднимаю `version` в его `.claude-plugin/plugin.json`.

2. Проверяю: `.\check.ps1 имя-мода` (или просто `.\check.ps1`, тогда проверятся все моды и обновится бейдж с тестами).

3. Открываю новый чат или пишу `/reload-plugins`, и мод грузится уже новый.

4. Сохраняю в GitHub: `git add -A`, `git commit -m "..."`, `git push`.

**Забрать правки на другом компьютере**

```powershell
cd "$env:USERPROFILE\.claude\mods"
git pull
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

После этого открываю новый чат.

**Добавить новый мод**

1. Создаю папку с `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx` и тестами в `tests/`.

2. Добавляю строку в `.claude-plugin/marketplace.json`.

3. Запускаю `.\check.ps1 имя-мода` и `.\install.ps1`.

**Убрать мод**

```powershell
claude plugin uninstall имя-мода@local-mods
```

Потом убираю его строку из `marketplace.json` и саму папку.

## Как устроено

```text
.claude-plugin/marketplace.json   список модов маркетплейса local-mods
<мод>/.claude-plugin/plugin.json  имя, версия, описание, настройки мода
<мод>/hooks/register.tsx          сам мод
<мод>/hooks/*.ts                  чистая логика без движка, её проверяют тесты
<мод>/types/index.d.ts            какие значения мод хранит в состоянии
<мод>/tests/*.test.ts             тесты, их запускает claude plugin test
install.ps1                       ставит все моды во все сессии
check.ps1                         валидация и тесты всех модов
```

**Общий блок над полем ввода.** Его рисуют cache-timer, server-panel, spend-meter и quick-steps. В каждом из них лежит одинаковый файл `hooks/status-row.ts`. Строки блока такие: `status` (кэш слева, расход справа), `server` и `next` (подсказки). Порядок кусков задают ключи `seg-1-cache`, `seg-2-server`, `seg-3-spend` и `seg-4-steps`. Если меняешь `status-row.ts`, меняй его во всех четырёх модах одинаково.

**Данные модов** хранятся не в репозитории, а в `%USERPROFILE%\.claude\plugins\store`. Файл называется `<мод>_local-mods-<хэш>.json`, где хэш берётся из `<мод>@local-mods`. Поэтому на любом компьютере имена совпадают.

## Безопасность

1. В репозитории нет паролей, ключей и токенов. `.gitignore` не пускает сюда ключи и `.env`.

2. Пароль от сервера вводится только в окне ssh, которое открывает server-panel. Ни мод, ни Claude его не видят.

3. Команды на сервере по умолчанию идут только после подтверждения. В пульте сервера можно включить подтверждение только для опасных команд.

4. delete-guard не даёт ничего удалить без "да".

5. Паспорт проекта не записывает ничего похожего на пароль, ключ или токен.
