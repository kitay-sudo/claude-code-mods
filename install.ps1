# Включает все моды из этой папки во всех чатах Claude Code, с автообновлением:
# моды грузятся прямо из своих папок, и каждый чат следит за ними, так что
# правка мода сама появляется во всех открытых чатах.
# Можно запускать сколько угодно раз; после нового мода запусти ещё раз.
#
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\mods\install.ps1"
#
# Что делает:
#   1. Прописывает в ~/.claude/settings.json папки модов (CLAUDE_CODE_PLUGIN_DIRS)
#      и слежение за ними (CLAUDE_CODE_PLUGIN_DIR_WATCH=1). Остальные настройки не трогает.
#   2. Выключает копии модов из маркетплейса local-mods, если они стояли, чтобы не было двойников.
#   3. Переносит данные модов (расход, серверы, бэклог, паспорта) под имена файлов
#      новой схемы; старые файлы остаются.
#   4. Переносит данные переименованных модов: бэклог пульта задачи в backlog,
#      паспорта проектов в project-memory. Старые файлы тоже остаются.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$claudeDir = Join-Path $env:USERPROFILE '.claude'
$settingsFile = Join-Path $claudeDir 'settings.json'

$market = Get-Content -Raw -Encoding UTF8 (Join-Path $root '.claude-plugin\marketplace.json') | ConvertFrom-Json
$names = @($market.plugins | ForEach-Object { $_.name })
$dirs = ($names | ForEach-Object { (Join-Path $root $_) -replace '\\', '/' }) -join ';'

# 1. Папки модов и слежение в настройках.
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Force $claudeDir | Out-Null }
if (Test-Path $settingsFile) { Copy-Item $settingsFile "$settingsFile.before-mods.json" -Force }
if (Get-Command node -ErrorAction SilentlyContinue) {
    node (Join-Path $root 'scripts\settings.js') $settingsFile $dirs
    if ($LASTEXITCODE -ne 0) { Write-Host 'Не получилось записать настройки, смотри сообщение выше.' -ForegroundColor Red; exit 1 }
} else {
    $settings = if (Test-Path $settingsFile) { Get-Content -Raw -Encoding UTF8 $settingsFile | ConvertFrom-Json } else { New-Object PSObject }
    if ($null -eq $settings.env) { $settings | Add-Member -NotePropertyName env -NotePropertyValue (New-Object PSObject) }
    $settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue $dirs -Force
    $settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIR_WATCH -NotePropertyValue '1' -Force
    [IO.File]::WriteAllText($settingsFile, ($settings | ConvertTo-Json -Depth 50), (New-Object Text.UTF8Encoding($false)))
    Write-Host "settings: $($names.Count) mods load from their folders, watched"
}

# 2. Копии из маркетплейса выключить, если стояли. Уже выключенная копия
#    отвечает ошибкой: это не повод останавливаться.
if (Get-Command claude -ErrorAction SilentlyContinue) {
    $ErrorActionPreference = 'Continue'
    $installed = (cmd /c "claude plugin list 2>&1" | Out-String)
    foreach ($name in $names) {
        if ($installed -match "$([regex]::Escape($name))@local-mods") {
            $said = (cmd /c "claude plugin disable $name@local-mods --scope user 2>&1" | Out-String)
            if ($said -notmatch 'already disabled') { Write-Host "Выключена копия из маркетплейса: $name@local-mods" -ForegroundColor DarkGray }
        }
    }
    $ErrorActionPreference = 'Stop'
}

# 3. Данные модов под имена новой схемы: <мод>_inline-<первые 12 знаков sha256 от "<мод>@inline">.json
$store = Join-Path $claudeDir 'plugins\store'
if (Test-Path $store) {
    $sha = [Security.Cryptography.SHA256]::Create()
    foreach ($name in $names) {
        $old = Get-ChildItem $store -Filter "$($name)_local-mods-*.json" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $old) { continue }
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$name@inline"))
        $hash = (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
        $new = Join-Path $store "$($name)_inline-$hash.json"
        if (-not (Test-Path $new)) {
            Copy-Item $old.FullName $new
            Write-Host "Данные перенесены: $($old.Name)" -ForegroundColor DarkGray
        }
    }
}

# 4. Данные переименованных модов: task-panel в backlog, project-passport в project-memory.
if (Test-Path $store) {
    node (Join-Path $root 'scripts\migrate-store.js') $store
}

Write-Host ''
Write-Host "Готово: $($names.Count) модов. Открой новый чат в Claude. Дальше правки модов будут появляться сами." -ForegroundColor Green
