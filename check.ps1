# Проверяет все моды или один: валидация и тесты.
# Когда проверяются все, обновляет в README бейджи: число модов, тесты и версии.
#
#   powershell -ExecutionPolicy Bypass -File .\check.ps1
#   powershell -ExecutionPolicy Bypass -File .\check.ps1 spend-meter

param([string]$Only = '')

# Моды в Claude Code пока в раннем доступе: без этого флага терминальный
# `claude plugin test` отказывается их запускать. Флаг живёт только в этом запуске.
$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$root = $PSScriptRoot
$market = Get-Content -Raw -Encoding UTF8 (Join-Path $root '.claude-plugin\marketplace.json') | ConvertFrom-Json
$names = @($market.plugins | ForEach-Object { $_.name } | Where-Object { $Only -eq '' -or $_ -eq $Only })
if ($names.Count -eq 0) {
    Write-Host "Нет такого мода: $Only" -ForegroundColor Red
    exit 1
}

$bad = @()
$passed = 0
$failed = 0
$versions = @{}
foreach ($name in $names) {
    $dir = Join-Path $root $name
    Write-Host "== $name" -ForegroundColor Cyan
    $versions[$name] = (Get-Content -Raw -Encoding UTF8 (Join-Path $dir '.claude-plugin\plugin.json') | ConvertFrom-Json).version

    claude plugin validate $dir | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { $bad += "$name (валидация)" }

    # Итог тестов печатается в stderr: cmd сливает потоки, чтобы его прочитать.
    $lines = @(cmd /c "claude plugin test `"$dir`" 2>&1")
    $code = $LASTEXITCODE
    $lines | ForEach-Object { Write-Host $_ }
    foreach ($line in $lines) {
        if ("$line" -match '^\s*(\d+) pass\s*$') { $passed += [int]$Matches[1] }
        if ("$line" -match '^\s*(\d+) fail\s*$') { $failed += [int]$Matches[1] }
    }
    if ($code -ne 0) { $bad += "$name (тесты)" }
}

if ($Only -eq '') {
    # Бейджи лежат в репозитории файлами, чтобы GitHub не ходил за ними на shields.io.
    # Файл скачивается заново, только когда число на нём поменялось.
    function Save-Badge([string]$file, [string]$url, [string]$title) {
        $path = Join-Path $root ".github\badges\$file"
        if ((Test-Path $path) -and ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)).Contains("<title>$title</title>")) { return }
        curl.exe -sf --max-time 20 -o $path $url
        if ($LASTEXITCODE -ne 0) { Write-Host "Бейдж не обновился: $title" -ForegroundColor Yellow }
    }
    $total = $passed + $failed
    $color = if ($failed -eq 0) { 'brightgreen' } else { 'red' }
    Save-Badge 'tests.svg' "https://img.shields.io/badge/%D1%82%D0%B5%D1%81%D1%82%D1%8B-$passed%2F$total-$color" "тесты: $passed/$total"
    Save-Badge 'mods.svg' "https://img.shields.io/badge/%D0%BC%D0%BE%D0%B4%D1%8B-$($names.Count)-8A2BE2" "моды: $($names.Count)"

    # Версии модов в таблице README.
    $readme = Join-Path $root 'README.md'
    $text = [IO.File]::ReadAllText($readme, [Text.Encoding]::UTF8)
    foreach ($name in $names) {
        $text = $text -replace "(?m)^(\|[^|\n]*\b$([regex]::Escape($name))\b[^|\n]*\|\s*)v\d+\.\d+\.\d+", "`${1}v$($versions[$name])"
    }
    [IO.File]::WriteAllText($readme, $text, (New-Object Text.UTF8Encoding($false)))
    Write-Host "README и бейджи: модов $($names.Count), тестов $passed из $total" -ForegroundColor DarkGray
}

Write-Host ''
if ($bad.Count -gt 0) {
    Write-Host "Есть проблемы: $($bad -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "Все моды в порядке: $($names.Count), тестов $passed" -ForegroundColor Green
