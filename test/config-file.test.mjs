/**
 * 入口配置文件：缺文件才是空清单。损坏 / 读不动 / 一条都不认识都要报错，
 * 保存不能覆盖掉读不动的原文件。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCustomActions, saveCustomActions } from '../index.js'

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dcla-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, file: join(dir, 'custom-actions.json') }
}

test('配置文件不存在就是空清单', async (t) => {
  const { file } = await scratch(t)
  assert.deepEqual(await loadCustomActions(file), [])
})

test('JSON 损坏时报错，不假装是空清单', async (t) => {
  const { file } = await scratch(t)
  await writeFile(file, '[{"label": "x", ', 'utf8')
  await assert.rejects(loadCustomActions(file), /config-corrupt/u)
})

test('一条都不认识的配置报错，不返回空清单', async (t) => {
  const { file } = await scratch(t)
  await writeFile(file, JSON.stringify([{ label: 'x', kind: 'sudo', value: 'rm -rf' }]), 'utf8')
  await assert.rejects(loadCustomActions(file), /config-corrupt/u)
})

test('部分条目坏了：留住能认的，不整份丢', async (t) => {
  const { file } = await scratch(t)
  await writeFile(
    file,
    JSON.stringify([{ label: '好的', kind: 'shell', value: 'echo {path}' }, { label: '坏', kind: 'sudo', value: 'x' }]),
    'utf8'
  )
  assert.deepEqual(await loadCustomActions(file), [{ label: '好的', kind: 'shell', value: 'echo {path}', scope: 'all' }])
})

test('老结构 {version, actions} 仍能读', async (t) => {
  const { file } = await scratch(t)
  await writeFile(
    file,
    JSON.stringify({ version: 1, actions: [{ label: '旧的', kind: 'url', value: 'https://x.test/{path}', scope: 'all' }] }),
    'utf8'
  )
  assert.deepEqual(await loadCustomActions(file), [
    { label: '旧的', kind: 'url', value: 'https://x.test/{path}', scope: 'all' }
  ])
})

test('权限不足时报的是读不动，不是空清单', { skip: process.platform === 'win32' }, async (t) => {
  const { file } = await scratch(t)
  await writeFile(file, '[]', 'utf8')
  await chmod(file, 0o000)
  await assert.rejects(loadCustomActions(file), /config-unreadable/u)
})

test('保存写裸数组、不留临时文件，能原样读回', async (t) => {
  const { dir, file } = await scratch(t)
  const actions = [{ label: '发送到微信', kind: 'share', value: '', scope: 'all' }]
  await saveCustomActions(file, actions)
  assert.deepEqual(await loadCustomActions(file), actions)
  const raw = await readFile(file, 'utf8')
  assert.ok(raw.trimStart().startsWith('['), '文件是裸数组')
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [])
})

test('覆盖前把损坏的原文件另存一份', async (t) => {
  const { dir, file } = await scratch(t)
  await writeFile(file, '[{"label": "手写的', 'utf8')
  const actions = [{ label: '新的', kind: 'shell', value: 'echo hi', scope: 'all' }]
  await saveCustomActions(file, actions)
  assert.deepEqual(await loadCustomActions(file), actions)
  const backups = (await readdir(dir)).filter((name) => name.includes('.broken-'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), '[{"label": "手写的')
})
