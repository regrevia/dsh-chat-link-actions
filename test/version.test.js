/*!
 * 版本号只有一个真源：package.json。诊断里写死的旧版本号曾经让排查走偏。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { PKG_VERSION } from '../index.js'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('诊断版本号取自 package.json', () => {
  assert.equal(PKG_VERSION, pkg.version)
})

test('客户端 ready 回执与 package.json 版本一致', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const match = source.match(/report\("ready ([0-9.]+)"\)/u)
  assert.ok(match !== null, 'client.js 应当有 ready 回执')
  assert.equal(match[1], pkg.version)
})

test('CHANGELOG 顶部就是当前版本', async () => {
  const log = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const match = log.match(/^## ([0-9.]+)/u)
  assert.ok(match !== null)
  assert.equal(match[1], pkg.version)
})
