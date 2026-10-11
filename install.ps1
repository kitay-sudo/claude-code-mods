# Ставит все моды из этой папки во все сессии Claude Code.
# Можно запускать сколько угодно раз: уже стоящие моды просто остаются.
#
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\mods\install.ps1"

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host 'Claude Code не найден. Поставь его и запусти скрипт ещё раз:' -ForegroundColor Red
    Write-Host '  irm https://claude.ai/install.ps1 | iex'
    exit 1
}

$market = Get-Content -Raw -Encoding UTF8 (Join-Path $root '.claude-plugin\marketplace.json') | ConvertFrom-Json
$name = $market.name

$known = (claude plugin marketplace list 2>&1 | Out-String)
if ($known -match "(?m)\s$([regex]::Escape($name))\s*$") {
    Write-Host "Маркетплейс $name уже подключён, обновляю..." -ForegroundColor Cyan
    claude plugin marketplace update $name
} else {
    Write-Host "Подключаю маркетплейс $name из $root" -ForegroundColor Cyan
    claude plugin marketplace add $root
}
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Не получилось подключить маркетплейс, смотри сообщение выше.' -ForegroundColor Red
    exit 1
}

$failed = @()
foreach ($plugin in $market.plugins) {
    $id = "$($plugin.name)@$name"
    Write-Host "Ставлю $id" -ForegroundColor Cyan
    claude plugin install $id --scope user
    if ($LASTEXITCODE -ne 0) { $failed += $id; continue }
    # Уже стоявший мод грузится прямо из папки; update только записывает его новую версию.
    claude plugin update $id --scope user *> $null
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host "Не встали: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "Готово: $($market.plugins.Count) модов. Открой новый чат в Claude, и они появятся." -ForegroundColor Green
