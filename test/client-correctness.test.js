/*!
 * 回执与身份：右键动作必须落到「这一条消息、这一个会话、这一个动作」上。
 * 这里锁住 0.7.0 修掉的四类误判：引用串到别的会话、成功被报成失败、
 * 外站链接被当成本机文件、同名卡片跨消息猜路径。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const origin = 'http://127.0.0.1:50937'

function fakeNode(tagName, attrs = {}, extra = {}) {
  const children = []
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    parentElement: null,
    className: attrs.class || '',
    dataset: {},
    children,
    textContent: '',
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name) => name in attrs,
    querySelectorAll: () => [],
    ...extra
  }
  return node
}

function nest(child, ...parents) {
  let cursor = child
  for (const parent of parents) {
    cursor.parentElement = parent
    parent.children.push(cursor)
    cursor = parent
  }
  return child
}

const body = { nodeType: 1, tagName: 'BODY', parentElement: null, className: '', dataset: {}, children: [], textContent: '', getAttribute: () => null, hasAttribute: () => false, querySelectorAll: () => [] }

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob: (callback, type) => callback(new Blob(['png'], { type }))
  }
}

async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let api = null
  const document = {
    baseURI: origin + '/',
    body,
    documentElement: { getAttribute: () => 'zh-CN' },
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? fakeCanvas() : fakeNode(tag)),
    addEventListener() {},
    removeEventListener() {}
  }
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Blob,
    ClipboardItem: class { constructor(items) { this.items = items } },
    createImageBitmap: async (blob) => ({ width: 4, height: 3, close() {}, source: blob }),
    document,
    location: { origin, protocol: 'http:', href: origin + '/' },
    navigator: { language: 'zh-CN' },
    window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
  }
  sandbox.window.__ModuleLoader__ = { load: (definition) => { api = definition.factory(() => ({})) } }
  sandbox.window.window = sandbox.window
  sandbox.window.document = document
  sandbox.window.location = sandbox.location
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(api !== null && api.__paths !== undefined)
  return api.__paths
}

const paths = await loadClient()

/* ── 编辑器：每一种合法 kind 打开再保存都要原样留着 ─────────────────── */

test('编辑器下拉框覆盖服务端认识的每一种 kind', async () => {
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const match = index.match(/CUSTOM_KINDS\s*=\s*\[([^\]]+)\]/u)
  assert.ok(match !== null, 'index.js 里应当有 CUSTOM_KINDS')
  const serverKinds = match[1].split(',').map((piece) => piece.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean)
  const editorKinds = paths.PURPOSE_ORDER()
  for (const kind of serverKinds) assert.ok(editorKinds.includes(kind), `编辑器缺少 kind: ${kind}`)
  assert.deepEqual([...editorKinds].sort(), [...serverKinds].sort())
})

test('编辑器不把不认识的值悄悄改成第一个', () => {
  const keys = paths.PURPOSE_ORDER()
  for (const kind of keys) assert.equal(paths.pickerCurrent(kind, keys), kind)
  assert.equal(paths.pickerCurrent('powershell', keys), 'powershell')
  assert.equal(paths.pickerCurrent('pwsh', keys), 'pwsh')
  assert.equal(paths.pickerCurrent('future-kind', keys), 'future-kind')
  assert.equal(paths.pickerCurrent(undefined, keys), keys[0])
})

/* ── 引用插入：请求只发给来源会话 ───────────────────────────────────── */

function composer(actions, ...spans) {
  return {
    captureInsertion: () => spans.length > 1 ? spans.shift() : spans[0],
    actions
  }
}

test('引用插入带会话作用域：第一个参数是来源会话的上下文', () => {
  const calls = []
  const ctx = {
    emit(...args) {
      calls.push(args)
      return true
    }
  }
  const bindingCalls = []
  paths.setRootContext({
    sessions: {
      binding(id) {
        bindingCalls.push(id)
        return { ctx }
      }
    }
  })
  const actions = composer({}, { start: 3, end: 3 }, { start: 15, end: 15 })
  const ok = paths.insertChip('session-a', actions, '/Users/example/a.md', false)
  paths.setRootContext(null)
  assert.equal(ok, true)
  assert.deepEqual(bindingCalls, ['session-a'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], ctx, '第一个参数必须是作用域上下文，否则请求会落到所有输入框')
  assert.equal(calls[0][1], 'slash/input-insert-reference')
  assert.equal(calls[0][2].reference.ref, '@/Users/example/a.md')
  assert.deepEqual(calls[0][2].span, { start: 3, end: 3 })
})

test('宿主说没插进去时返回 false，不假装成功', () => {
  paths.setRootContext({
    sessions: { binding: () => ({ ctx: { emit: () => false } }) }
  })
  const ok = paths.insertChip('session-b', composer({}, { start: 0, end: 0 }), '/tmp/x.txt', false)
  paths.setRootContext(null)
  assert.equal(ok, false)
})

test('拿不到来源会话就不插，绝不换一个会话兜底', () => {
  let touched = 0
  paths.setRootContext({
    sessions: { binding: () => { touched += 1; throw new Error('unknown session') } }
  })
  const ok = paths.insertChip('missing', composer({}, { start: 0, end: 0 }), '/tmp/x.txt', false)
  paths.setRootContext(null)
  assert.equal(ok, false)
  assert.equal(touched, 1)
})

/* ── 打开回执：四种结果各自的下一步 ─────────────────────────────────── */

test('回执：成功、明确失败、不支持、无回执分别走不同的路', () => {
  assert.equal(paths.revealVerdict(true, null), 'opened')
  assert.equal(paths.revealVerdict({ ok: true }, null), 'opened')
  assert.equal(paths.revealVerdict({ opened: true }, null), 'opened')
  assert.equal(paths.revealVerdict({ revealed: true }, null), 'opened')

  assert.equal(paths.revealVerdict({ ok: false, message: '打开失败' }, null), 'failed')
  assert.equal(paths.revealVerdict(false, null), 'failed')
  assert.equal(paths.revealVerdict(undefined, new Error('boom')), 'failed')

  assert.equal(paths.revealVerdict(undefined, new Error('method not supported')), 'unsupported')
  assert.equal(paths.revealVerdict({ code: 'not-implemented' }, null), 'unsupported')

  assert.equal(paths.revealVerdict(undefined, null), 'pending')
  assert.equal(paths.revealVerdict(null, null), 'pending')
  assert.equal(paths.revealVerdict({ done: true }, null), 'pending')
})

/* ── 本机文件判定：外站链接里的 path 参数不算 ───────────────────────── */

function anchor(href, text = '') {
  return fakeNode('a', { href }, { textContent: text })
}

test('外站链接的 ?path= 不当成本机文件', () => {
  const external = anchor('https://external.example/open?path=%2Ftmp%2Freport.pdf', '/tmp/report.pdf')
  assert.equal(paths.pathFromNode(external, null), null)
  assert.equal(paths.linkTarget(external), 'https://external.example/open?path=%2Ftmp%2Freport.pdf')

  const local = anchor(origin + '/open?path=%2Ftmp%2Freport.pdf', '/tmp/report.pdf')
  assert.equal(paths.pathFromNode(local, null), '/tmp/report.pdf')
})

test('React 属性：页面地址字段不冒充磁盘路径', () => {
  const pageAddress = { src: '/attachments/v1/a.png', href: '/attachments/v1/a.png' }
  assert.equal(paths.pathFromProps(pageAddress), null)
  assert.equal(
    paths.pathFromProps({ memoizedProps: { src: '/attachments/v1/a.png' } }),
    null,
    '把同一个页面地址再塞进 memoizedProps 也不能变成文件路径'
  )
  assert.equal(paths.pathFromProps({ file: { path: '/Users/example/a.png' } }), '/Users/example/a.png')
  assert.equal(paths.pathFromProps({ src: 'file:///Users/example/a.png' }), '/Users/example/a.png')
})

/* ── 附件卡片：同名不猜、不跨消息 ───────────────────────────────────── */

function cardWith(name, ...parents) {
  const card = fakeNode('div', { title: name })
  return nest(card, ...parents)
}

test('同一条消息里同名文件有两个路径时不猜', () => {
  const message = fakeNode('div', { 'data-message-id': 'm1' }, {
    textContent: '对比 /Users/example/a/clip.mp4 和 /tmp/b/clip.mp4'
  })
  const card = cardWith('clip.mp4', message)
  assert.equal(paths.pathForCardName(card, 'clip.mp4'), null)
})

test('同名文件只在当前消息里找，不拿相邻消息的路径', () => {
  const message = fakeNode('div', { 'data-message-id': 'm1' }, { textContent: '这条消息只提到别的文件 /tmp/other.mp4' })
  const card = cardWith('clip.mp4', message)
  assert.equal(paths.pathForCardName(card, 'clip.mp4'), null)
})

test('剪贴板图片统一转成 PNG，webp/jpeg 不再直接写进去', async () => {
  const webp = new Blob(['webp'], { type: 'image/webp' })
  const converted = await paths.toPngBlob(webp)
  assert.equal(converted.type, 'image/png')
  const png = new Blob(['png'], { type: 'image/png' })
  assert.equal(await paths.toPngBlob(png), png)
  const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' })
  assert.equal((await paths.toPngBlob(svg)).type, 'image/png')
})

test('波浪号芯片：真实 title 走完整叶子层，右键不再静默 return', () => {
  /* DSH 渲染成 <button data-ref-chip="file" title="@~/.dsh/logs/x.log">x.log</button> */
  const chip = fakeNode('button', { 'data-ref-chip': 'file', title: '@~/.dsh/logs/x.log' }, { textContent: 'x.log' })
  nest(chip, body)

  paths.setHome('/home/example')
  assert.equal(paths.pathFromNode(chip, null), '/home/example/.dsh/logs/x.log')
  paths.setHome('C:\\Users\\example')
  assert.equal(paths.pathFromNode(chip, null), 'C:\\Users\\example\\.dsh\\logs\\x.log')

  /* home 还没到：宁可没有菜单，也不把 '~/...' 当绝对路径交出去。 */
  paths.setHome(null)
  assert.equal(paths.pathFromNode(chip, null), null)
})

test('自定义入口失败按原因说话，不都说剪贴板不可用', () => {
  const words = { actionNeedsFile: '文件', managerFailed: '失败' }
  assert.equal(paths.customFailureText(new Error('app-needs-file'), words), '文件')
  assert.equal(paths.customFailureText(new Error('share-needs-file'), words), '文件')
  assert.equal(paths.customFailureText(new Error('launch-failed'), words), '失败')
})

test('当前消息里只有一条同名路径时就认它', () => {
  const message = fakeNode('div', { 'data-message-id': 'm1' }, { textContent: '已保存 /Users/example/clip.mp4' })
  const card = cardWith('clip.mp4', message)
  assert.equal(paths.pathForCardName(card, 'clip.mp4'), '/Users/example/clip.mp4')
})
