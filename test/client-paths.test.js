/*!
 * 纯路径层的回归测试：只验证「引用里的路径不会被改错」。
 *
 * client.js 是浏览器 IIFE（`window.__ModuleLoader__.load`），这里在 vm 里
 * 提供一个最小运行环境，取出导出的 `__paths` 直接比对结果。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

async function loadPaths() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let api = null
  /* 客户端只有这些地方碰页面；路径层不碰，所以环境可以很小。 */
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    document: { baseURI: 'http://127.0.0.1:50937/' },
    location: { origin: 'http://127.0.0.1:50937' }
  }
  sandbox.window = { __ModuleLoader__: { load: (definition) => { api = definition.factory(() => ({})) } } }
  sandbox.window.window = sandbox.window
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(api !== null && api.__paths !== undefined, 'client.js 应当导出 __paths')
  return api.__paths
}

const paths = await loadPaths()

test('file URI：盘符保留，UNC 主机不丢', () => {
  assert.equal(paths.decodePathFromHref('file:///C:/work/a.txt'), 'C:/work/a.txt')
  assert.equal(paths.decodePathFromHref('file:///Users/example/a%20b.md'), '/Users/example/a b.md')
  assert.equal(paths.decodePathFromHref('file://localhost/Users/example/x'), '/Users/example/x')
  assert.equal(paths.decodePathFromHref('file://server/share/a.md'), '\\\\server\\share\\a.md')
  /* 查询参数里的路径优先于 pathname。 */
  assert.equal(paths.decodePathFromHref('/open?path=%2Ftmp%2Fa%20b.md'), '/tmp/a b.md')
})

test('file URI 不会被当成相对路径丢掉主机名', () => {
  for (const href of ['file:///C:/work/a.txt', 'file://server/share/a.md']) {
    const decoded = paths.decodePathFromHref(href)
    assert.ok(decoded !== null && (decoded.startsWith('C:') || decoded.startsWith('\\\\')), href)
    assert.ok(!decoded.startsWith('/C:'), '盘符前不能多一个 /')
  }
})

test('显式字段：不加分隔符、不删字符', () => {
  /* `C:relative` 是盘符相对路径，不是 `C:/relative`。 */
  assert.equal(paths.normalizeStrict('C:relative.txt'), null)
  assert.equal(paths.normalizeStrict('C:\\work\\important!'), 'C:\\work\\important!')
  assert.equal(paths.normalizeStrict('C:\\work\\v1.2 final.md'), 'C:\\work\\v1.2 final.md')
  assert.equal(paths.normalizeStrict('C:\\work\\..\\report.md'), 'C:\\work\\..\\report.md')
  assert.equal(paths.normalizeStrict('\\\\?\\C:\\work\\a.md'), '\\\\?\\C:\\work\\a.md')
})

test('正文取路径：只修剪句读，不吞文件名中间的字', () => {
  assert.equal(paths.normalizeCandidate('C:\\work\\important!'), 'C:\\work\\important')
  assert.equal(paths.normalizeCandidate('C:\\work\\foo v1.2 final report.md'), 'C:\\work\\foo v1.2 final report.md')
  assert.equal(paths.joinPathWords('C:\\work\\foo', ' v1.2 report.md'), 'C:\\work\\foo v1.2 report.md')
})

test('行号后缀与尾分隔符', () => {
  assert.equal(paths.stripLineSuffix('/tmp/a.md:12:3'), '/tmp/a.md')
  assert.equal(paths.stripLineSuffix('/tmp/a.md#L12-L20'), '/tmp/a.md')
  assert.equal(paths.withoutTrailingSeparator('/tmp/a/'), '/tmp/a')
  assert.equal(paths.withoutTrailingSeparator('/'), '/')
})

test('~ 路径：home 到手后展开成绝对路径，没到手时仍然拒绝', () => {
  paths.setHome(null)
  /* 认不出来也不能把 '~/a' 当路径交出去：这一层只交付绝对路径。 */
  assert.equal(paths.normalizeStrict('~/a.md'), null)

  paths.setHome('C:\\Users\\example')
  /* DSH 把 \`~/.dsh/...\` 渲染成芯片，title 里就是这条波浪号路径。 */
  assert.equal(paths.normalizeStrict('~/.dsh/logs/a.log'), 'C:\\Users\\example\\.dsh\\logs\\a.log')
  assert.equal(paths.normalizeStrict('@~/work/notes.md'), 'C:\\Users\\example\\work\\notes.md')
  assert.equal(paths.normalizeStrict('~'), 'C:\\Users\\example')

  /* POSIX home 走正斜杠，不跟着运行平台走。 */
  paths.setHome('/home/example')
  assert.equal(paths.normalizeStrict('~/.dsh/logs/a.log'), '/home/example/.dsh/logs/a.log')

  /* 别人家的 home、波浪号开头的普通文件名都不算。 */
  assert.equal(paths.normalizeStrict('~someone/a.md'), null)
  assert.equal(paths.normalizeStrict('a~b/c.md'), null)
  paths.setHome(null)
})

test('expandHomePath 只碰波浪号前缀，分隔符跟随 home', () => {
  paths.setHome('/home/example')
  assert.equal(paths.expandHomePath('~'), '/home/example')
  assert.equal(paths.expandHomePath('~/x'), '/home/example/x')
  assert.equal(paths.expandHomePath('~\\x'), '/home/example/x')
  assert.equal(paths.expandHomePath('~x/y'), '~x/y')
  assert.equal(paths.expandHomePath('C:\\a\\b.md'), 'C:\\a\\b.md')

  paths.setHome('C:\\Users\\example')
  assert.equal(paths.expandHomePath('~\\x'), 'C:\\Users\\example\\x')
  assert.equal(paths.expandHomePath('~/a/b.md'), 'C:\\Users\\example\\a\\b.md')

  paths.setHome(null)
  assert.equal(paths.expandHomePath('~/x'), '~/x')
})
