/*!
 * 右键入口的冒烟测试：菜单入口不能因为一个未定义的标识符就整体失效。
 *
 * 这里在 vm 里给 client.js 一个最小的页面环境，直接调用右键入口，
 * 断言普通正文不会抛错、输入框能被认出来。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let api = null
  const notes = []
  class Element {}
  class HTMLElementStub extends Element {}
  class ElementStub extends HTMLElementStub {
    constructor(tagName, attributes = {}) {
      super()
      this.tagName = tagName
      this.nodeType = 1
      this.parentElement = null
      this.dataset = {}
      this.className = ''
      this._attributes = attributes
      this.children = []
      this.style = {}
    }
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    }
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child)
      return child
    }
    addEventListener() {}
    removeEventListener() {}
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 210, bottom: 110, width: 200, height: 100, x: 10, y: 10 }
    }
    setAttribute(name, value) {
      this._attributes[name] = String(value)
    }
    hasAttribute(name) {
      return Object.hasOwn(this._attributes, name)
    }
    getAttribute(name) {
      return Object.hasOwn(this._attributes, name) ? this._attributes[name] : null
    }
  }
  const document = {
    baseURI: 'http://127.0.0.1:50937/',
    documentElement: new ElementStub('HTML', { lang: 'zh-CN' }),
    body: new ElementStub('BODY'),
    head: { appendChild() {} },
    createElement: (tagName) => new ElementStub(String(tagName).toUpperCase()),
    createElementNS: () => new ElementStub('svg'),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {}
  }
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Element,
    HTMLElement: HTMLElementStub,
    document,
    location: { origin: 'http://127.0.0.1:50937' },
    navigator: { language: 'zh-CN' },
    fetch: async (url) => {
      notes.push(String(url))
      return { ok: true, status: 200, text: async () => '' }
    }
  }
  sandbox.window = {
    innerWidth: 1280,
    innerHeight: 800,
    __ModuleLoader__: { load: (definition) => { api = definition.factory(() => ({})) } },
    addEventListener() {},
    removeEventListener() {}
  }
  sandbox.window.window = sandbox.window
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(api !== null && api.__paths !== undefined, 'client.js 应当导出 __paths')
  return { paths: api.__paths, ElementStub, notes, sandbox }
}

const { paths, ElementStub, notes, sandbox } = await loadClient()

function makeEvent(target) {
  return {
    target,
    clientX: 10,
    clientY: 10,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {}
  }
}

test('输入框能认出来，正文不算输入区', () => {
  assert.equal(paths.editableField(new ElementStub('INPUT', { type: 'text' })), true)
  assert.equal(paths.editableField(new ElementStub('TEXTAREA')), true)
  assert.equal(paths.editableField(new ElementStub('DIV', { contenteditable: 'true' })), true)
  assert.equal(paths.editableField(new ElementStub('DIV')), false)
  assert.equal(paths.editableField(new ElementStub('BUTTON')), false)
})

test('普通正文上右键不抛错，也不拦原生菜单', () => {
  const paragraph = new ElementStub('P')
  const event = makeEvent(paragraph)
  assert.doesNotThrow(() => paths.contextMenu(event))
  assert.equal(event.defaultPrevented, false)
})

test('图片上右键会接管原生菜单', () => {
  const image = new ElementStub('IMG', { src: '/attachments/v1/a.png' })
  const event = makeEvent(image)
  assert.doesNotThrow(() => paths.contextMenu(event))
  assert.equal(event.defaultPrevented, true, notes.join(' | '))
  const layer = sandbox.document.body.children[0]
  const panel = layer.children[0]
  const captions = panel.children.filter((child) => child.className === "dcla-path")
  const items = panel.children.filter((child) => child.className === "dcla-item")
  assert.equal(captions.length, 0, "图片菜单不该再顶一行类型说明")
  assert.equal(items.length, 1, "图片菜单只有复制图片")
})

test('站内相对链接补成可复制的绝对地址', () => {
  assert.equal(paths.linkTarget(new ElementStub('A', { href: '/attachments/v1/a.pdf' })), 'http://127.0.0.1:50937/attachments/v1/a.pdf')
  assert.equal(paths.linkTarget(new ElementStub('A', { href: 'https://x.test/p' })), 'https://x.test/p')
  assert.equal(paths.linkTarget(new ElementStub('A', { href: 'mailto:a@b.c' })), null)
  assert.equal(paths.linkTarget(new ElementStub('VIDEO', { src: '/media/v.mp4' })), 'http://127.0.0.1:50937/media/v.mp4')
})

/* linkTarget 只认 http(s)，邮件地址由单独一层认，不能混进路径。 */
test('邮箱地址整形与识别', () => {
  assert.equal(paths.normalizeEmail('yc@regevia.com'), 'yc@regevia.com')
  assert.equal(paths.normalizeEmail('mailto:yc@regevia.com'), 'yc@regevia.com')
  assert.equal(paths.normalizeEmail('mailto:yc@regevia.com?subject=hi'), 'yc@regevia.com')
  assert.equal(paths.normalizeEmail('（yc@regevia.com）'), 'yc@regevia.com')
  assert.equal(paths.normalizeEmail('yc@regevia.com。'), 'yc@regevia.com')
  assert.equal(paths.normalizeEmail('yc@regevia'), null, '顶级域名缺失不算邮箱')
  assert.equal(paths.normalizeEmail('/Users/apple/a.md'), null)
  assert.equal(paths.normalizeEmail(''), null)
  assert.equal(paths.normalizeEmail(null), null)
})

test('mailto 链接被认成邮件收件人', () => {
  assert.equal(paths.emailTarget(new ElementStub('A', { href: 'mailto:yc@regevia.com' })), 'yc@regevia.com')
  const child = new ElementStub('SPAN')
  const anchor = new ElementStub('A', { href: 'mailto:yc@regevia.com' })
  anchor.appendChild(child)
  child.parentElement = anchor
  assert.equal(paths.emailTarget(child), 'yc@regevia.com', '子元素里点也要认到链接')
  assert.equal(paths.emailTarget(new ElementStub('A', { href: 'https://x.test/p' })), null)
})

test('邮件地址上右键给出复制与发信两项', () => {
  const anchor = new ElementStub('A', { href: 'mailto:yc@regevia.com' })
  const event = makeEvent(anchor)
  assert.doesNotThrow(() => paths.contextMenu(event))
  assert.equal(event.defaultPrevented, true, notes.join(' | '))
  const layer = sandbox.document.body.children[0]
  const panel = layer.children[0]
  const captions = panel.children.filter((child) => child.className === 'dcla-path')
  const items = panel.children.filter((child) => child.className === 'dcla-item')
  assert.equal(captions.length, 0, '邮箱不该顶一行路径说明')
  assert.equal(items.length, 2, '复制邮箱 + 发信')
})

test("菜单里用到的图标都画得出来", async () => {
  const source = await readFile(new URL("../client.js", import.meta.url), "utf8");
  const icons = /var ICONS = \{([\s\S]*?)\n    \};/.exec(source)[1];
  const known = new Set([...icons.matchAll(/^\s{6}([a-zA-Z]+):/gmu)].map((row) => row[1]));
  const used = [...source.matchAll(/icon:\s*"([a-zA-Z]+)"/gu)].map((row) => row[1]);
  const missing = used.filter((name) => !known.has(name));
  assert.deepEqual(missing, []);
});
