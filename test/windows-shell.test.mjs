// PowerShell 场景：两种版本（5.1 与 7）走同一个脚本模板，占位符必须是字面量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CUSTOM_KINDS,
  customCommand,
  powershellCommand,
  powershellLiteral,
  powershellScript,
  sanitizeCustomActions,
} from '../index.js'

const weird = 'C:\\Program Files\\中文 目录\\100%, it\'s $env:PATH.txt'

test('两种 kind 各自挑对可执行文件', () => {
  assert.equal(powershellCommand({ kind: 'powershell', value: 'x' }, {}, 'win32').executable, 'powershell.exe')
  assert.equal(powershellCommand({ kind: 'pwsh', value: 'x' }, {}, 'win32').executable, 'pwsh.exe')
  assert.equal(powershellCommand({ kind: 'pwsh', value: 'x' }, {}, 'darwin').executable, 'pwsh')
})

test('脚本参数固定：不读 profile、不交互、不卡执行策略', () => {
  const { args } = powershellCommand({ kind: 'powershell', value: 'Get-Location' }, {}, 'win32')
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
  assert.equal(args[5], 'Get-Location')
})

test('单引号字面量：$ 不展开，引号写成两个', () => {
  assert.equal(powershellLiteral('C:\\a $b.txt'), "'C:\\a $b.txt'")
  assert.equal(powershellLiteral("it's"), "'it''s'")
})

test('占位符进 PowerShell 只当字符串，不做 shell 拼接', () => {
  const script = powershellScript('Get-Item -LiteralPath {path} | Select-Object -ExpandProperty FullName', { path: weird })
  assert.equal(script, `Get-Item -LiteralPath '${weird.replace(/'/gu, "''")}' | Select-Object -ExpandProperty FullName`)
  assert.ok(!script.includes('"'))
})

test('四种占位符都填：dir 用反斜杠路径的上一级', () => {
  const script = powershellScript('{dir}|{name}', { path: 'C:\\dev\\中文 目录\\a.txt' }, 'win32')
  assert.equal(script, "'C:\\dev\\中文 目录'|'a.txt'")
})

test('shell 与 PowerShell 是不同 kind，写法互不串味', () => {
  assert.ok(CUSTOM_KINDS.includes('powershell'))
  assert.ok(CUSTOM_KINDS.includes('pwsh'))
  const kept = sanitizeCustomActions([
    { label: '导出清单', kind: 'powershell', value: 'Get-Item -LiteralPath {path}' },
    { label: 'gci', kind: 'pwsh', value: 'Get-ChildItem -LiteralPath {dir}' },
  ])
  assert.deepEqual(kept.map((entry) => entry.kind), ['powershell', 'pwsh'])
  assert.equal(customCommand('x {path}', { path: 'a b' }, 'win32'), 'x "a b"')
})

test('空文件时只挡住用到文件占位符的脚本', () => {
  const entry = { kind: 'powershell', value: 'Get-Date' }
  assert.ok(powershellScript(entry.value, {}).includes('Get-Date'))
})

/** 装了对应可执行文件才真跑；没装就跳过，CI 上没有 pwsh 也不会假成功。 */
function runPowerShell(kind) {
  /* 生产里 powershellCommand 收的是整条入口，这里也按入口传，别绕过 { kind } 分支。 */
  const { executable, args } = powershellCommand({ kind, value: '' }, {}, process.platform)
  const probe = spawnSync(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) return null
  return {
    executable,
    script: (text) => spawnSync(executable, [...args.slice(0, 5), text], { encoding: 'utf8' })
  }
}

for (const kind of ['powershell', 'pwsh']) {
  test(`${kind}：真跑一段脚本，把中文/空格/$ 的路径原样写出来`, (t) => {
    const run = runPowerShell(kind)
    if (!run) return t.skip(`${kind} 不可用`)
    assert.ok(run.executable.toLowerCase().includes(kind), `用到的是 ${run.executable}，不是 ${kind}`)
    const dir = mkdtempSync(join(tmpdir(), 'dcla-ps-'))
    try {
      const target = join(dir, "中文 目录, 100% it's $env:PATH.txt")
      const entry = { kind, value: "Set-Content -LiteralPath {path} -Value 'ok' -NoNewline" }
      const result = run.script(powershellCommand(entry, { path: target }, process.platform).args.at(-1))
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(target, 'utf8'), 'ok')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
