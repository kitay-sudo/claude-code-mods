import { expect, test } from 'claude-code/testing'

import { findDeletions, resolvePath } from '../hooks/parse'
import type { Shell } from '../hooks/parse'

const paths = (command: string, shell: Shell) => findDeletions(command, shell).flatMap(d => d.paths.map(p => p.text))
const notes = (command: string, shell: Shell) => findDeletions(command, shell).flatMap(d => d.notes)

test('finds what rm, Remove-Item, del and rd delete, through nested shells too', () => {
  expect(paths('rm -rf build dist', 'bash')).toEqual(['build', 'dist'])
  expect(paths('rm -- -weird', 'bash')).toEqual(['-weird'])
  expect(paths('Remove-Item -Recurse -Force "C:\\x\\y" -ErrorAction SilentlyContinue', 'powershell')).toEqual(['C:\\x\\y'])
  expect(paths('Remove-Item -LiteralPath a,b -Recurse', 'powershell')).toEqual(['a', 'b'])
  expect(paths('ls; ri old.txt 2>$null', 'powershell')).toEqual(['old.txt'])
  expect(paths('cmd /c "rd /s /q build"', 'powershell')).toEqual(['build'])
  expect(paths('powershell -NoProfile -Command "Remove-Item \'x y\' -Force"', 'bash')).toEqual(['x y'])
  expect(paths('bash -lc "rm -f a.txt"', 'powershell')).toEqual(['a.txt'])
  expect(paths('git rm -r old/', 'bash')).toEqual(['old/'])
  expect(paths('[System.IO.File]::Delete("C:\\a.txt")', 'powershell')).toEqual(['C:\\a.txt'])
})

test('lets through commands that only mention deleting', () => {
  const quiet: [string, Shell][] = [
    ['git commit -m "rm old files"', 'bash'],
    ['echo rm -rf /', 'bash'],
    ['grep -rn "Remove-Item" .', 'bash'],
    ['ls -la; npm test 2>&1 > out.log', 'bash'],
    ["git commit -m @'\nrm -rf everything\n'@", 'powershell'],
    ["cat > s.sh <<'EOF'\nrm -rf x\nEOF\necho ok", 'bash'],
    ['git rm --cached secret.txt', 'bash'],
    ['git clean -n', 'bash'],
    ['Get-ChildItem -Recurse | Measure-Object -Sum Length', 'powershell'],
  ]
  for (const [command, shell] of quiet) expect(findDeletions(command, shell)).toEqual([])
})

test('reports what cannot be counted ahead instead of letting it through', () => {
  expect(notes('Get-ChildItem build -Recurse | Remove-Item', 'powershell')[0]).toContain('Get-ChildItem build -Recurse')
  expect(notes('find . -name "*.log" -delete', 'bash')[0]).toContain('find удалит')
  expect(notes('git clean -fdx', 'bash')[0]).toContain('и игнорируемые тоже')
  expect(notes('python -c "import shutil; shutil.rmtree(\'x\')"', 'bash')[0]).toContain('shutil.rmtree')
  expect(notes('Clear-RecycleBin -Force', 'powershell')[0]).toContain('Корзину')
  expect(
    paths("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", 'powershell'),
  ).toEqual(['$p'])
})

test('resolves paths after cd, from ~, Git Bash drives and known variables', () => {
  const ctx = {
    cwd: 'C:\\proj',
    env: (name: string) => (name === 'USERPROFILE' ? 'C:\\Users\\me' : name === 'TEMP' ? 'C:\\Temp' : undefined),
  }
  const [deletion] = findDeletions('cd sub && rm ../a.txt ~/b *.log $p /c/x/y /tmp/z', 'bash')
  expect(deletion?.paths.map(p => resolvePath(p, ctx))).toEqual([
    { kind: 'path', path: 'C:\\proj\\a.txt' },
    { kind: 'path', path: 'C:\\Users\\me\\b' },
    { kind: 'glob', dir: 'C:\\proj\\sub', pattern: '*.log', path: 'C:\\proj\\sub\\*.log' },
    { kind: 'unknown', text: '$p' },
    { kind: 'path', path: 'C:\\x\\y' },
    { kind: 'unknown', text: '/tmp/z' },
  ])
  const [ps] = findDeletions('Remove-Item "$env:TEMP\\cache" -Recurse', 'powershell')
  expect(resolvePath(ps!.paths[0]!, ctx)).toEqual({ kind: 'path', path: 'C:\\Temp\\cache' })
})
