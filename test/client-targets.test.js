/*!
 * 兼容性矩阵：对话里出现过的各种渲染形态，右键都应当认到同一条路径；
 * 反例（网页链接、相对路径、斜杠命令）必须认不出来，而不是猜一条错的。
 *
 * client.js 是浏览器 IIFE，这里在 vm 里给最小环境，节点用鸭子类型的假对象。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const origin = 'http://127.0.0.1:50937'

function fakeNode(tagName, attrs = {}, extra = {}) {
  const dataset = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('data-')) {
      dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    }
  }
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    parentElement: null,
    dataset,
    getAttribute(name) {
      return name in attrs ? attrs[name] : null
    },
    ...extra
  }
}

/** 子节点挂在祖先链最底下：右键落在子节点上，路径在祖先身上也一样要认出来。 */
function nest(child, ...parents) {
  let cursor = child
  for (const parent of parents) {
    cursor.parentElement = parent
    cursor = parent
  }
  return child
}

function chain(tagName, attrs, extra, ...parents) {
  return nest(fakeNode(tagName, attrs, extra), ...parents)
}

const body = { nodeType: 1, tagName: 'BODY', parentElement: null, dataset: {}, getAttribute: () => null }

async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let api = null
  const document = {
    baseURI: origin + '/',
    body,
    documentElement: { getAttribute: () => 'zh-CN' },
    createElement: (tag) => fakeNode(tag),
    addEventListener() {},
    removeEventListener() {}
  }
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    document,
    location: { origin, protocol: 'http:', href: origin + '/' },
    navigator: { language: 'zh-CN' },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {}
    }
  }
  sandbox.window.__ModuleLoader__ = { load: (definition) => { api = definition.factory(() => ({})) } }
  sandbox.window.window = sandbox.window
  sandbox.window.document = document
  sandbox.window.location = sandbox.location
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(api !== null && api.__paths !== undefined, 'client.js 应当导出 __paths')
  return api.__paths
}

const paths = await loadClient()

/** 认出来的路径；认不出来应当是 null，不能是错的那条。 */
function found(node) {
  return paths.pathFromNode(node, null)
}

/* ── 附件/图片/视频 ───────────────────────────────────────────────────── */

test('图片：file URI 与 data-* 上的磁盘位置都能取到', () => {
  assert.equal(found(chain('img', { src: 'file:///C:/work/a%20b.png' })), 'C:/work/a b.png')
  assert.equal(found(chain('img', { src: '/attachments/abc.png', 'data-path': '/Users/example/照片 1.png' })), '/Users/example/照片 1.png')
  assert.equal(found(nest(fakeNode('span'), chain('img', { src: 'file:///tmp/x.jpg' }))), '/tmp/x.jpg')
})

test('图片：页面地址不当成本机文件', () => {
  const image = chain('img', { src: '/attachments/abc.png' })
  assert.equal(paths.imageFilePath(image), null)
  assert.equal(paths.imageTarget(image), image)
})

test('视频与音频：src、source 子元素、srcset 都能认', () => {
  assert.equal(found(chain('video', { src: 'file:///Users/example/clip.mp4' })), '/Users/example/clip.mp4')
  assert.equal(found(chain('source', { src: 'file:///Users/example/a.webm' })), '/Users/example/a.webm')
  assert.equal(found(chain('img', { srcset: '/attachments/s.png 1x, file:///Users/example/大图@2x.png 2x' })), '/Users/example/大图@2x.png')
})

/* ── 链接与芯片 ────────────────────────────────────────────────────────── */

test('链接：问号路径、显式 file 参数、尾斜杠目录', () => {
  assert.equal(found(chain('a', { href: '?path=%2Ftmp%2Fa%20b.md' })), '/tmp/a b.md')
  assert.equal(found(chain('a', { href: '/open?file=%2FUsers%2Fexample%2Fa.md' })), '/Users/example/a.md')
  assert.equal(found(chain('a', { href: '/Users/example/Documents/' })), '/Users/example/Documents')
  assert.equal(found(chain('a', { href: `/Users/example/${'深目录/'.repeat(3)}说明.md` })), `/Users/example/${'深目录/'.repeat(3)}说明.md`)
})

test('链接：行号后缀不进路径', () => {
  assert.equal(found(chain('a', { href: '/Users/example/repo/file.cjs#L12' })), '/Users/example/repo/file.cjs')
  assert.equal(found(chain('a', { href: '/Users/example/repo/file.cjs#L12-L20' })), '/Users/example/repo/file.cjs')
  assert.equal(found(chain('a', { href: '/Users/example/repo/file.cjs:12:3' })), '/Users/example/repo/file.cjs')
})

test('附件卡片：点在预览图上，路径仍来自外层的链接', () => {
  const card = chain('a', { href: '/open?path=%2Ftmp%2F报告.pdf' })
  const preview = nest(fakeNode('img', { src: '/attachments/report-1.png' }), card)
  assert.equal(found(preview), '/tmp/报告.pdf')
  assert.equal(paths.linkTarget(preview), origin + '/open?path=%2Ftmp%2F报告.pdf')
})

test('停在 body 处：不把整页当成一个链接', () => {
  const node = nest(fakeNode('span'), body)
  assert.equal(paths.pathFromNode(node, null), null)
})

test('芯片：路径只在 title 上，或只在组件 props 里', () => {
  assert.equal(found(chain('span', { title: '/Users/example/a.md' })), '/Users/example/a.md')
  const fiber = { memoizedProps: { file: { path: 'C:\\work\\报告.pdf' } }, return: null }
  const chip = chain('span', {}, { __reactFiber$1: fiber })
  assert.equal(found(chip), 'C:\\work\\报告.pdf')
  const deepFiber = { memoizedProps: {}, return: { memoizedProps: { path: '/Users/example/b.md' }, return: null } }
  assert.equal(found(chain('span', {}, { __reactFiber$2: deepFiber })), '/Users/example/b.md')
})

test('Windows：盘符、UNC、带空格与中文', () => {
  assert.equal(found(chain('div', { 'data-path': 'C:\\work\\v1.2 final.md' })), 'C:\\work\\v1.2 final.md')
  assert.equal(found(chain('div', { 'data-path': 'C:/work/混合 目录/a.md' })), 'C:/work/混合 目录/a.md')
  assert.equal(found(chain('div', { title: '\\\\server\\share\\a.md' })), '\\\\server\\share\\a.md')
})

/* ── 反例：宁可没有菜单，也不要指向错的文件 ───────────────────────────── */

test('反例：网页链接、协议、锚点、斜杠命令一律不认', () => {
  for (const href of [
    'https://example.com/a.md',
    'http://example.com/a.md',
    'mailto:someone@example.com',
    'javascript:void(0)',
    'blob:http://127.0.0.1:50937/abc',
    'data:text/plain,hello',
    '#L12',
    '/help',
    '/settings'
  ]) {
    assert.equal(found(chain('a', { href })), null, href)
  }
})

test('反例：相对路径不折算成根目录的文件', () => {
  for (const href of ['./a.md', '../a.md', '~/Documents/a.md', 'docs/a.md', 'a.md']) {
    assert.equal(found(chain('a', { href })), null, href)
  }
})

test('反例：非路径属性的文字不认', () => {
  assert.equal(found(chain('div', { title: '按钮' })), null)
  assert.equal(found(chain('div', { 'data-id': '12345' })), null)
})

/* ── 边界与稳定性 ─────────────────────────────────────────────────────── */

test('畸形百分号、控制字符、超长值都不抛错', () => {
  assert.equal(found(chain('div', { 'data-path': '/tmp/a%E0%A4%A.md' })), '/tmp/a%E0%A4%A.md')
  assert.equal(found(chain('a', { href: '/tmp/%E0%A4%A.md' })), '/tmp/%E0%A4%A.md')
  const long = '/tmp/' + 'a'.repeat(4000) + '.md'
  assert.equal(found(chain('div', { 'data-path': long })), long)
  assert.equal(found(chain('div', { 'data-path': '/tmp/a\u0000b.md' })), '/tmp/a\u0000b.md')
})

test('属性不是字符串时不抛错', () => {
  const weird = chain('div', {}, { getAttribute: () => 42, dataset: { path: 42 } })
  assert.equal(found(weird), null)
})

test('目录判断：形状与数据属性两种来源', () => {
  assert.equal(paths.guessDirectory('/Users/example/Documents'), true)
  assert.equal(paths.guessDirectory('/Users/example/a.md'), false)
  assert.equal(paths.guessDirectory('/Users/example/.config'), true)
  assert.equal(paths.directoryHint(chain('div', { 'data-appearance': 'folder' })), true)
  assert.equal(paths.directoryHint(chain('div', { 'data-type': 'file' })), false)
  const fiber = { memoizedProps: { reference: { appearance: 'directory' } }, return: null }
  assert.equal(paths.directoryHint(chain('span', {}, { __reactFiber$3: fiber })), true)
})

test('引用文字：带空格用 @""，不带空格用 @', () => {
  assert.equal(paths.referenceText('/Users/example/a.md'), '@/Users/example/a.md')
  assert.equal(paths.referenceText('/Users/example/a b.md'), '@"/Users/example/a b.md"')
})

test('网址目标：站内补全、协议相对补全', () => {
  assert.equal(paths.linkTarget(chain('a', { href: '/x/y' })), origin + '/x/y')
  assert.equal(paths.linkTarget(chain('a', { href: '//cdn.example.com/x' })), 'http:' + '//cdn.example.com/x')
  assert.equal(paths.linkTarget(chain('a', { href: '/t?path=%2Ftmp%2Fa.md' })), origin + '/t?path=%2Ftmp%2Fa.md')
  assert.equal(paths.linkTarget(chain('a', { href: 'mailto:a@b.c' })), null)
})

/* ── 更多附件/芯片形态 ────────────────────────────────────────────────── */

test('JSON 形状的 data-*：附件对象序列化进属性也认', () => {
  assert.equal(found(chain('div', { 'data-file': '{"path":"/Users/example/报告.pdf"}' })), '/Users/example/报告.pdf')
  assert.equal(found(chain('div', { 'data-attachment': '{"file":{"absolutePath":"C:\\\\work\\\\a.md"}}' })), 'C:\\work\\a.md')
  assert.equal(found(chain('img', { src: '/attachments/x.png', 'data-asset': '[{"src":"/attachments/y.png"},{"path":"/tmp/z.png"}]' })), '/tmp/z.png')
  assert.equal(found(chain('div', { 'data-file': '{"id":"abc"}' })), null)
  assert.equal(found(chain('div', { 'data-file': '{坏掉的 JSON' })), null)
})

test('aria-label 与图片 alt 上的路径也认', () => {
  assert.equal(found(chain('span', { 'aria-label': '/Users/example/a.md' })), '/Users/example/a.md')
  assert.equal(found(chain('img', { src: '/attachments/p.png', alt: '/Users/example/原图.png' })), '/Users/example/原图.png')
  assert.equal(paths.imageFilePath(chain('img', { src: '/attachments/p.png', alt: '/Users/example/原图.png' })), '/Users/example/原图.png')
  assert.equal(found(chain('span', { 'aria-label': '附件 a.md' })), null)
})

test('正文标点：顿号与全角收尾括号不进路径', () => {
  assert.equal(paths.normalizeCandidate('/Users/example/a.md、'), '/Users/example/a.md')
  assert.equal(paths.normalizeCandidate('（/Users/example/a.md）'), '/Users/example/a.md')
  assert.equal(paths.normalizeCandidate('「/Users/example/a.md」'), '/Users/example/a.md')
  /* 路径自己带的括号不能被当成句子括号 */
  assert.equal(paths.normalizeCandidate('/Users/example/草稿(1).md）'), '/Users/example/草稿(1).md')
})

/* ── 稳定性：脏属性、深链、随机输入都不能抛错 ─────────────────────────── */

test('属性值不是字符串时目录判断也不抛错', () => {
  const weird = chain('div', {}, { getAttribute: () => 42 })
  assert.equal(paths.directoryHint(weird), undefined)
})

test('深链正常结束：500 层祖先不会卡住', () => {
  let node = fakeNode('span', { title: '/Users/example/深处.md' })
  for (let i = 0; i < 500; i += 1) node = nest(node, fakeNode('div'))
  assert.equal(found(node), '/Users/example/深处.md')
})

test('随机脏属性：不抛错，认出来的也一定是绝对路径', () => {
  const values = [
    '', ' ', '?', '#', '/', '//', '\\\\', 'C:', 'C:', 'http://', 'file://', 'file:///',
    '/tmp/a.md', 'C:\\a.md', '\\\\srv\\share\\a.md', '~/a', './a', '../a', '/a?path=%2Fb',
    '%E0%A4%A', '\u0000', 'a'.repeat(300), '中文 路径.md', '😀/x.png', 'data:text/plain,x',
    'javascript:1', 'mailto:a@b', 'blob:x', 'srcset', 'a, b, c', '/+/%2F'
  ]
  let seed = 20251028
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed
  }
  const attrs = ['href', 'src', 'srcset', 'title', 'data-path', 'data-file-path', 'data-href', 'data-src', 'data-id']
  for (let round = 0; round < 2000; round += 1) {
    const picked = {}
    const count = 1 + (next() % 3)
    for (let i = 0; i < count; i += 1) {
      picked[attrs[next() % attrs.length]] = values[next() % values.length]
    }
    const tag = ['a', 'img', 'video', 'source', 'div', 'span'][next() % 6]
    const target = chain(tag, picked)
    const value = paths.pathFromNode(target, null)
    assert.ok(value === null || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'), JSON.stringify(picked) + ' → ' + value)
    paths.imageFilePath(target)
    paths.imageTarget(target)
    paths.linkTarget(target)
    paths.directoryHint(target)
    paths.srcsetPath(target)
  }
})

test('图片：没有明确磁盘来源时，不把页面地址当成本机路径', () => {
  const plain = chain('img', { src: '/attachments/abc.png' })
  assert.equal(paths.pathFromNode(plain, null), '/attachments/abc.png')
  assert.equal(paths.pathFromNode(plain, { strict: true }), null)
  const explicit = chain('img', { src: '/attachments/abc.png', 'data-file': '{"path":"/Users/example/abc.png"}' })
  assert.equal(paths.pathFromNode(explicit, { strict: true }), '/Users/example/abc.png')
  const linked = chain('img', { src: '/attachments/abc.png', href: '?path=%2FUsers%2Fexample%2Fabc.png' })
  assert.equal(paths.pathFromNode(linked, { strict: true }), '/Users/example/abc.png')
  assert.equal(paths.pathFromNode(linked, { strict: true, allowProse: false }), '/Users/example/abc.png')
})

test('图片外层链接：只认 <a href>，图片地址不冒充链接', () => {
  const body = fakeNode('body')
  const anchor = fakeNode('a', { href: '/files/report.pdf?x=1' })
  const img = fakeNode('img', { src: '/attachments/abc.png' })
  nest(img, anchor); nest(anchor, body)
  assert.equal(paths.outerLinkHref(img), origin + '/files/report.pdf?x=1')
  const lone = fakeNode('img', { src: '/attachments/abc.png' })
  nest(lone, body)
  assert.equal(paths.outerLinkHref(lone), null)
})

/* ── 附件卡片（视频/文件收成一张卡） ─────────────────────────────────── */

/** 卡片：host 只把文件名写在 title 上，没有 href，也没有地址。 */
function cardNode(name, extra = {}) {
  const meta = fakeNode('span', {}, { className: 'x_fileMeta', textContent: 'MP4 12.4 MB' })
  const label = fakeNode('span', {}, { className: 'x_fileName', textContent: name })
  return fakeNode('span', extra.attrs ?? { title: name }, {
    className: 'x_fileCard',
    children: [label, meta],
    textContent: name + 'MP4 12.4 MB',
    ...extra
  })
}

test('附件卡片：文件名从 title 或名称行取，卡片本身能被认出来', () => {
  const card = cardNode('录屏 2026-02-11.mp4')
  assert.equal(paths.cardFileName(card), '录屏 2026-02-11.mp4')
  const inner = nest(fakeNode('span', {}, { className: 'x_fileIcon' }), card)
  assert.equal(paths.attachmentCard(inner), card)
  assert.equal(paths.cardFileName(fakeNode('span', {}, { className: 'x_fileCard', children: [fakeNode('span', {}, { className: 'x_fileName', textContent: 'b.mov' })] })), 'b.mov')
  assert.equal(paths.baseNameOf('/Users/example/a/b.mp4'), 'b.mp4')
  assert.equal(paths.baseNameOf('C:\\work\\b.mp4'), 'b.mp4')
})

test('附件卡片：同一条消息里的同名绝对路径就是这张卡片', () => {
  const message = fakeNode('div', {}, { textContent: '视频做好了 [录屏 2026-02-11.mp4](/Users/example/videos/录屏 2026-02-11.mp4)' })
  const card = cardNode('录屏 2026-02-11.mp4')
  nest(card, message); nest(message, body)
  assert.equal(paths.pathForCardName(card, '录屏 2026-02-11.mp4'), '/Users/example/videos/录屏 2026-02-11.mp4')
})

test('附件卡片：文件名对不上就不猜；同名出现两条路径也不猜', () => {
  const other = fakeNode('div', {}, { textContent: '另一次 [别的.mp4](/Users/example/videos/别的.mp4)' })
  const card = cardNode('录屏.mp4')
  nest(card, other); nest(other, body)
  assert.equal(paths.pathForCardName(card, '录屏.mp4'), null)

  const twice = fakeNode('div', {}, { textContent: '/tmp/旧/录屏.mp4 之后 /Users/example/新/录屏.mp4' })
  const twiceCard = cardNode('录屏.mp4')
  nest(twiceCard, twice); nest(twice, body)
  /* 两条都同名时「取最近」是猜；猜错会打开错的文件，所以宁可不认。 */
  assert.equal(paths.pathForCardName(twiceCard, '录屏.mp4'), null)
})

test('附件卡片：Windows 盘符上的同名文件也能对上', () => {
  const message = fakeNode('div', {}, { textContent: 'C:\\work\\videos\\clip.mp4' })
  const card = cardNode('clip.mp4')
  nest(card, message); nest(message, body)
  assert.equal(paths.pathForCardName(card, 'clip.mp4'), 'C:\\work\\videos\\clip.mp4')
})

test('附件卡片：同一条消息里的同名链接也算（链接文字只有文件名时靠 href）', () => {
  const message = fakeNode('div', {})
  const anchor = fakeNode('a', { href: 'file:///Users/example/videos/%E5%BD%95%E5%B1%8F.mp4' })
  nest(anchor, message)
  message.querySelectorAll = (selector) => (selector === 'a[href]' ? [anchor] : [])
  const card = cardNode('录屏.mp4')
  nest(card, message); nest(message, body)
  assert.equal(paths.pathForCardName(card, '录屏.mp4'), '/Users/example/videos/录屏.mp4')
})

test('自定义入口：按文件类别筛，认不出的只给通用', () => {
  const entries = [
    { label: '通用', kind: 'app', value: 'WPS', scope: 'all' },
    { label: '视频', kind: 'app', value: 'VLC', scope: 'video' },
    { label: '图片', kind: 'app', value: 'Preview', scope: 'image' },
    { label: '没写范围', kind: 'app', value: 'Old' }
  ]
  const labels = (target) => paths.menuEntriesFor(entries, target).map((entry) => entry.label)
  assert.deepEqual(labels({ path: '/tmp/电影.mkv' }), ['通用', '视频', '没写范围'])
  assert.deepEqual(labels({ path: '/tmp/clip.mp4' }), ['通用', '视频', '没写范围'])
  assert.deepEqual(labels({ path: '/tmp/a.MP3' }), ['通用', '没写范围'].filter((label) => label !== '视频'))
  assert.deepEqual(labels({ path: '/tmp/photo.png' }), ['通用', '图片', '没写范围'])
  assert.deepEqual(labels({ path: '/tmp/mystery.xyz' }), ['通用', '没写范围'])
  assert.deepEqual(labels({ path: '', url: 'https://x.test/a' }), ['通用', '没写范围'])
  assert.deepEqual(labels({ path: '', name: '报告.pdf' }), ['通用', '没写范围'])
  assert.deepEqual(labels({ path: '', name: '视频.mkv' }), ['通用', '视频', '没写范围'])
})

test('自定义入口：后缀归到种类，不认识返回 null', () => {
  assert.equal(paths.kindOfName('a.mkv'), 'video')
  assert.equal(paths.kindOfName('A.MP4'), 'video')
  assert.equal(paths.kindOfName('/tmp/x.flac'), 'audio')
  assert.equal(paths.kindOfName('p.HEIC'), 'image')
  assert.equal(paths.kindOfName('r.docx'), 'document')
  assert.equal(paths.kindOfName('b.7z'), 'archive')
  assert.equal(paths.kindOfName('m.tsx'), 'code')
  assert.equal(paths.kindOfName('noext'), null)
  assert.equal(paths.kindOfName('.gitignore'), null)
  assert.equal(paths.kindOfName('a.'), null)
  assert.equal(paths.kindOfName(null), null)
  assert.equal(paths.kindOfTarget({ path: '/tmp/a.webm' }), 'video')
  assert.equal(paths.kindOfTarget({ path: '', name: 'a.webm' }), 'video')
})
