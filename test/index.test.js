/**
 * 三端一致性用例：命令行拼装、路径校验，以及路由在真实 ctx 形状下能否挂上。
 *
 * 插件在 apply() 里直接读 `ctx.runLauncher`（不在 inject 里的名字），
 * Cordis 会当场抛错，插件半身整个挂不上 —— 表现就是「点『在文件管理器中
 * 查看』没反应」。这里用会抛错的 ctx 代理把这个回归钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  ACTION_PROTOCOL,
  appLaunchValue,
  customCommand,
  customUrl,
  CUSTOM_KINDS,
  customActionsFile,
  sanitizeCustomActions,
  CUSTOM_SCOPES,
  quoteArgument,
  encodeExplorerSelect,
  encodeWindowsArgument,
  extendedWindowsPath,
  openDirectoryCommand,
  optionalMember,
  probePath,
  requireAbsolute,
  revealCommand,
  runCustomAction,
  succeeded,
} from '../index.js'

/** 一个只认 inject 的 ctx 代理：访问别的名字就像真 Cordis 那样抛错。 */
function contextWith(options = {}) {
  const routes = []
  const launches = []
  const warnings = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection(req) {
        return req.headers.origin === 'https://evil.example' ? new Error('cross-origin') : undefined
      },
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
  }
  const target = {
    effect(callback) {
      return callback()
    },
    get(name, strict = true) {
      if (Object.hasOwn(services, name)) return services[name]
      if (strict) throw new Error(`cannot get required service "${name}" in inactive context`)
      return undefined
    },
    ...services,
  }
  if (typeof options.runLauncher === 'function') target.runLauncher = options.runLauncher
  const ctx = new Proxy(target, {
    get(object, property) {
      if (typeof property === 'symbol') return object[property]
      if (Object.hasOwn(object, property)) return object[property]
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  })
  return { ctx, routes, launches, warnings }
}

function fakeResponse() {
  const state = { status: 0, body: null }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    end(text) {
      state.body = text === undefined ? null : JSON.parse(text)
    },
  }
}

function revealRequest(path, method = 'POST') {
  return {
    method,
    url: `/chat-link-actions?action=reveal&path=${encodeURIComponent(path)}`,
    headers: { origin: 'http://127.0.0.1:49224' },
  }
}

async function withTempFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-link-actions-'))
  try {
    const file = join(directory, 'note.md')
    await writeFile(file, '# hi\n')
    await run({ directory, file })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** 启动规格展平成 [命令, ...参数]，断言里就不出现键值对。 */
function flat(spec) {
  return [spec.command, ...spec.args]
}

test('macOS：文件用 -R 选中，目录直接打开，符号链接始终指向自身', () => {
  assert.deepEqual(flat(revealCommand('/a/b.md', 'darwin')), ['open', '-R', '/a/b.md'])
  assert.deepEqual(flat(revealCommand('/a/b/', 'darwin', { isDirectory: true })), ['open', '/a/b'])
  assert.deepEqual(
    flat(revealCommand('/a/link', 'darwin', { isDirectory: true, isSymbolicLink: true })),
    ['open', '-R', '/a/link'],
  )
})

test('Windows：目录自带、逗号与空白加引号、盘符根不再 /select', () => {
  assert.deepEqual(flat(revealCommand('C:\\a\\b', 'win32', { isDirectory: true })), ['explorer.exe', 'C:\\a\\b'])
  assert.deepEqual(flat(revealCommand('C:\\a\\b.md', 'win32')), ['explorer.exe', '/select,C:\\a\\b.md'])
  assert.equal(encodeExplorerSelect('C:\\a,b\\c d.md'), '/select,"C:\\a,b\\c d.md"')
  assert.equal(encodeExplorerSelect('C:\\a\\b.md'), '/select,C:\\a\\b.md')
  assert.deepEqual(flat(revealCommand('C:\\', 'win32')), ['explorer.exe', 'C:\\'])
  assert.deepEqual(flat(revealCommand('\\\\server\\share\\x.md', 'win32')), [
    'explorer.exe',
    '/select,\\\\server\\share\\x.md',
  ])
})

test('Linux：没有选中协议，打开所在目录', () => {
  assert.deepEqual(flat(revealCommand('/a/b.md', 'linux')), ['xdg-open', '/a'])
  assert.deepEqual(flat(openDirectoryCommand('/a/b/', 'linux')), ['xdg-open', '/a'])
})

test('Windows 边界：尾分隔符、UNC 目录、盘符根、长路径前缀都按 Windows 规则走', () => {
  assert.deepEqual(flat(revealCommand('C:\\a\\b.md\\', 'win32')), ['explorer.exe', '/select,C:\\a\\b.md'])
  assert.deepEqual(flat(revealCommand('C:\\a\\b\\', 'win32', { isDirectory: true })), ['explorer.exe', 'C:\\a\\b'])
  assert.deepEqual(flat(openDirectoryCommand('C:\\a\\b.md', 'win32')), ['explorer.exe', 'C:\\a'])
  assert.deepEqual(flat(openDirectoryCommand('C:\\', 'win32')), ['explorer.exe', 'C:\\'])
  assert.deepEqual(flat(revealCommand('\\\\srv\\share\\dir\\', 'win32', { isDirectory: true })), [
    'explorer.exe',
    '\\\\srv\\share\\dir',
  ])
  assert.deepEqual(flat(revealCommand('\\\\?\\C:\\long\\x.md', 'win32')), [
    'explorer.exe',
    '/select,\\\\?\\C:\\long\\x.md',
  ])
  assert.equal(requireAbsolute('C:\\a\\b.md', 'win32'), 'C:\\a\\b.md')
  assert.throws(() => requireAbsolute('C:rel\\x.md', 'win32'), /absolute path required/)
  assert.equal(requireAbsolute('\\\\srv\\share', 'win32'), '\\\\srv\\share')
  assert.throws(() => requireAbsolute('..\\up.md', 'win32'), /absolute path required/)
})

test('macOS 边界：带空格、中文、括号、井号的路径原样进 argv', () => {
  const weird = '/Users/example/My Dir/中文 (1) #tag.md'
  assert.deepEqual(flat(revealCommand(weird, 'darwin')), ['open', '-R', weird])
  assert.deepEqual(flat(revealCommand('/Users/example/My Dir/', 'darwin', { isDirectory: true })), [
    'open',
    '/Users/example/My Dir',
  ])
})

test('探测：文件、目录、缺失各有明确状态，缺失才回 404', async () => {
  await withTempFile(async ({ directory, file }) => {
    assert.equal((await probePath(file)).state, 'file')
    assert.equal((await probePath(directory)).state, 'directory')
    assert.deepEqual(await probePath(join(directory, 'nope.md')), { state: 'missing', facts: {} })
    assert.equal((await probePath(file)).facts.isDirectory, false)
    assert.equal((await probePath(directory)).facts.isDirectory, true)
  })
})

test('路径校验：只收本机绝对路径，拒绝相对路径与 NUL', () => {
  assert.equal(requireAbsolute('/a/b.md', 'darwin'), '/a/b.md')
  assert.equal(requireAbsolute('C:\\a\\b.md', 'win32'), 'C:\\a\\b.md')
  assert.throws(() => requireAbsolute('a.md', 'darwin'), /absolute path required/u)
  assert.throws(() => requireAbsolute('a/b.md', 'darwin'), /absolute path required/u)
  assert.throws(() => requireAbsolute('/a\0b.md', 'darwin'), /absolute path required/u)
})

test('explorer.exe 退出码非零不算失败，其它启动器算', () => {
  assert.equal(succeeded({ ok: true }, 'open'), true)
  assert.equal(succeeded({ ok: false, error: { code: 1 } }, 'explorer.exe'), true)
  assert.equal(succeeded({ ok: false, error: { code: 1 } }, 'open'), false)
})

test('不在 inject 里的名字读不到值，但不会炸', () => {
  const throwing = contextWith()
  assert.equal(optionalMember(throwing.ctx, 'runLauncher'), undefined)
  const plain = { get: () => undefined, runLauncher: () => 'launcher' }
  assert.equal(optionalMember(plain, 'runLauncher')(), 'launcher')
})

test('apply 在只认 inject 的 ctx 上能挂上路由', () => {
  const { ctx, routes } = contextWith()
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/chat-link-actions')
})

test('路由：跨站被拒、非 POST 与未知动作被拒', async () => {
  const { ctx, routes } = contextWith()
  apply(ctx)
  const handler = routes[0].handler

  const forbidden = fakeResponse()
  await handler({ ...revealRequest('/a/b.md'), headers: { origin: 'https://evil.example' } }, forbidden)
  assert.equal(forbidden.state.status, 403)

  const getOnly = fakeResponse()
  await handler(revealRequest('/a/b.md', 'GET'), getOnly)
  assert.equal(getOnly.state.status, 405)

  const unknown = fakeResponse()
  await handler({ ...revealRequest('/a/b.md'), url: '/chat-link-actions?action=what&path=%2Fa' }, unknown)
  assert.equal(unknown.state.status, 400)
})

test('路由：文件存在时选中它，目录用另一种拼装', async () => {
  await withTempFile(async ({ directory, file }) => {
    const { ctx, routes, launches } = contextWith({
      runLauncher: async (command, args) => {
        launches.push([command, args])
        return { ok: true }
      },
    })
    apply(ctx)
    const handler = routes[0].handler

    const fileReply = fakeResponse()
    await handler(revealRequest(file), fileReply)
    assert.equal(fileReply.state.status, 200)
    assert.deepEqual(fileReply.state.body, { ok: true })
    if (process.platform === 'darwin') assert.deepEqual(launches[0], ['open', ['-R', file]])
    else assert.ok(launches[0][1].length > 0, '应调用一次启动器')

    const directoryReply = fakeResponse()
    await handler(revealRequest(`${directory}/`), directoryReply)
    assert.equal(directoryReply.state.status, 200)
    if (process.platform === 'darwin') assert.deepEqual(launches[1], ['open', [directory]])
    else assert.ok(launches[1][1].length > 0, '目录应再调用一次启动器')
  })
})

test('路由：路径不存在回 404，选中失败后退到打开目录', async () => {
  await withTempFile(async ({ file }) => {
    const { ctx, routes, launches } = contextWith({
      runLauncher: async (command, args) => {
        launches.push([command, args])
        if (args[0] === '-R') return { ok: false, error: new Error('no select') }
        return { ok: true }
      },
    })
    apply(ctx)
    const handler = routes[0].handler

    const missing = fakeResponse()
    await handler(revealRequest('/definitely/not/here.md'), missing)
    assert.equal(missing.state.status, 404)
    assert.deepEqual(missing.state.body, { ok: false, error: 'not-found' })

    const fallback = fakeResponse()
    await handler(revealRequest(file), fallback)
    assert.equal(fallback.state.status, 200)
    if (process.platform === 'darwin') {
      assert.equal(launches.length, 2)
      assert.deepEqual(launches[1], ['open', [join(file, '..')]])
    } else {
      assert.ok(launches.length >= 1)
    }
  })
})

test('路由：两个启动器都失败时回 500 并只记日志', async () => {
  await withTempFile(async ({ file }) => {
    const { ctx, routes, warnings } = contextWith({
      runLauncher: async () => ({ ok: false, error: new Error('boom') }),
    })
    apply(ctx)
    const handler = routes[0].handler

    const failed = fakeResponse()
    await handler(revealRequest(file), failed)
    assert.equal(failed.state.status, 500)
    assert.deepEqual(failed.state.body, { ok: false, error: 'launch-failed' })
    assert.equal(warnings.length, 2)
  })
})

test('Windows：verbatim 前缀不解释 . 与 ..，盘符相对路径不扩展', () => {
  /* `\\?\` 是 verbatim 形式：../. 会原样交给 Shell，加前缀反而改变含义。 */
  assert.equal(extendedWindowsPath('C:\\work\\..\\report.md'), 'C:\\work\\..\\report.md')
  assert.equal(extendedWindowsPath('C:\\work\\.\\report.md'), 'C:\\work\\.\\report.md')
  /* `C:relative` 没有可扩展的盘根。 */
  assert.equal(extendedWindowsPath('C:relative\\x.md'), 'C:relative\\x.md')
  /* 盘根 + 超长或带尾随空格时才加前缀。 */
  const long = `C:\\work\\${'a'.repeat(260)}\\x.md`
  assert.ok(extendedWindowsPath(long).startsWith('\\\\?\\C:\\'))
  assert.equal(extendedWindowsPath('\\\\server\\share\\x. '), '\\\\?\\UNC\\server\\share\\x. ')
  assert.equal(extendedWindowsPath('\\\\?\\C:\\work\\x.md'), '\\\\?\\C:\\work\\x.md')
})

test('Windows：verbatim 盘根保留分隔符，explorer 只加一层引号', () => {
  assert.deepEqual(flat(revealCommand('C:\\', 'win32')), ['explorer.exe', 'C:\\'])
  assert.deepEqual(flat(revealCommand('\\\\?\\C:\\', 'win32')), ['explorer.exe', '\\\\?\\C:\\'])
  assert.equal(encodeWindowsArgument('C:\\a b\\x.md'), '"C:\\a b\\x.md"')
  assert.equal(encodeWindowsArgument('C:\\a\\x.md'), 'C:\\a\\x.md')
  assert.equal(encodeExplorerSelect('C:\\a b\\x.md'), '/select,"C:\\a b\\x.md"')
  /* 目录自己就是目标：整条路径也要按 explorer 的规则加引号。 */
  assert.deepEqual(flat(revealCommand('C:\\a b', 'win32', { isDirectory: true })), ['explorer.exe', '"C:\\a b"'])
})


test('自定义入口：模板替换按平台引用路径', () => {
  const target = { path: '/Users/example/My Dir/a b.md', url: 'https://x.test/p' }
  assert.equal(
    customCommand('open -a WeChat {path}', target, 'darwin'),
    "open -a WeChat '/Users/example/My Dir/a b.md'"
  )
  assert.equal(customCommand('explorer {dir}', target, 'win32'), 'explorer "/Users/example/My Dir"')
  assert.equal(customCommand('{name}', target, 'darwin'), "'a b.md'")
  assert.equal(customCommand('open {url}', target, 'darwin'), "open 'https://x.test/p'")
  assert.equal(quoteArgument("it's", 'darwin'), "'it'\\''s'")
})

test('自定义入口：类型决定怎么把文件交出去', () => {
  assert.deepEqual(CUSTOM_KINDS, ['shell', 'powershell', 'pwsh', 'app', 'shortcut', 'url', 'share', 'service'])
  assert.deepEqual(
    sanitizeCustomActions([
      { label: ' 发送到微信 ', kind: 'share' },
      { label: '发送到手机', kind: 'app', value: ' 小米互联服务 ' },
      { label: '分享给设备', kind: 'service', value: ' 小米互联服务 ' },
      { label: '快捷发送', kind: 'shortcut', value: '发送到手机' },
      { label: '复制到手机', kind: 'url', value: 'mi://send?p={path}' },
      { label: '打开', command: 'open -a WeChat {path}' },
      { label: '未知类型', kind: 'sudo', value: 'rm -rf' },
      { label: '空的', kind: 'app', value: '  ' }
    ]),
    [
      { label: '发送到微信', kind: 'share', value: '', scope: 'all' },
      { label: '发送到手机', kind: 'app', value: '小米互联服务', scope: 'all' },
      { label: '分享给设备', kind: 'service', value: '小米互联服务', scope: 'all' },
      { label: '快捷发送', kind: 'shortcut', value: '发送到手机', scope: 'all' },
      { label: '复制到手机', kind: 'url', value: 'mi://send?p={path}', scope: 'all' },
      { label: '打开', kind: 'shell', value: 'open -a WeChat {path}', scope: 'all' },
      { label: '未知类型', kind: 'shell', value: 'rm -rf', scope: 'all' }
    ]
  )
  assert.equal(customUrl('mi://send?p={path}', { path: '/tmp/a b.png' }), 'mi://send?p=%2Ftmp%2Fa%20b.png')
})

test('自定义入口：打开方式对文件用路径，对网页链接用地址', async () => {
  assert.equal(appLaunchValue('/Users/example/a.pdf', ''), '/Users/example/a.pdf')
  assert.equal(appLaunchValue('', 'https://x.test/p'), 'https://x.test/p')
  assert.equal(appLaunchValue('', ''), '')
  await assert.rejects(runCustomAction({ kind: 'app', value: '/Applications/Google Chrome.app' }, {}), /app-needs-file/u)
})

test('自定义入口：只收有限的小清单', () => {
  assert.deepEqual(sanitizeCustomActions([{ label: ' A ', command: ' echo {path} ' }, { label: '', command: 'x' }]), [
    { label: 'A', kind: 'shell', value: 'echo {path}', scope: 'all' }
  ])
  assert.deepEqual(sanitizeCustomActions('nope'), [])
  const many = Array.from({ length: 21 }, (_, index) => ({ label: `l${index}`, command: 'true' }))
  assert.throws(() => sanitizeCustomActions(many), /too-many-entries/u)
  assert.throws(() => sanitizeCustomActions([{ label: 'x'.repeat(41), command: 'true' }]), /label-too-long/u)
  assert.throws(() => sanitizeCustomActions([{ label: 'a', command: 'x'.repeat(401) }]), /value-too-long/u)
  assert.throws(() => sanitizeCustomActions([{ label: 'a', command: 'x\ny' }]), /control-character/u)
})

test('自定义入口：限定入口只认已知类别，缺省是通用', () => {
  assert.deepEqual(CUSTOM_SCOPES, ['all', 'video', 'audio', 'image', 'document', 'archive', 'code'])
  assert.deepEqual(
    sanitizeCustomActions([
      { label: '用 VLC 打开', kind: 'app', value: 'VLC', scope: 'video' },
      { label: '老配置', kind: 'app', value: 'WPS' },
      { label: '乱写', kind: 'app', value: 'x', scope: 'gif' }
    ]),
    [
      { label: '用 VLC 打开', kind: 'app', value: 'VLC', scope: 'video' },
      { label: '老配置', kind: 'app', value: 'WPS', scope: 'all' },
      { label: '乱写', kind: 'app', value: 'x', scope: 'all' }
    ]
  )
})

test('自定义入口：配置文件在 profile 下', () => {
  assert.equal(customActionsFile('/home/me'), join('/home/me', '.dsh', 'chat-link-actions', 'custom-actions.json'))
  assert.ok(customActionsFile('/home/me').endsWith('custom-actions.json'))
})

test('对外协议：一份数据说清所有入口类型和调用方式', () => {
  assert.equal(ACTION_PROTOCOL.version, 3)
  assert.deepEqual(ACTION_PROTOCOL.kinds.map((item) => item.kind).sort(), [...CUSTOM_KINDS].sort())
  for (const entry of ACTION_PROTOCOL.kinds) {
    assert.equal(typeof entry.effect, 'string')
    assert.deepEqual(Object.keys(entry.example).sort(), ['kind', 'label', 'value'])
    assert.ok(CUSTOM_KINDS.includes(entry.example.kind))
  }
  assert.deepEqual(ACTION_PROTOCOL.scopes.map((item) => item.scope), [...CUSTOM_SCOPES])
  for (const scope of ACTION_PROTOCOL.scopes) assert.equal(typeof scope.label, 'string')
  assert.ok(ACTION_PROTOCOL.http.routes.some((route) => route.action === 'actions-add'))
  assert.equal(ACTION_PROTOCOL.limits.entries, 20)
})

test('协议里带 agent 配置入口', () => {
  assert.equal(typeof ACTION_PROTOCOL.agent, 'object')
  assert.ok(ACTION_PROTOCOL.agent.fast_path.length >= 2)
  assert.ok(ACTION_PROTOCOL.agent.recipes.length >= 3)
  assert.equal(ACTION_PROTOCOL.storage.file.endsWith('custom-actions.json'), true)
  assert.ok(ACTION_PROTOCOL.cli.some((line) => line.includes('apply')))
})

test('~ 路径：reveal 前展开成真实 home，分隔符跟随 home', () => {
  /* 固定的 home，断言不依赖跑在哪台机器上（CI 三个平台都跑这组用例）。 */
  assert.equal(requireAbsolute('~/.dsh/logs/a.log', 'linux', '/home/example'), '/home/example/.dsh/logs/a.log')
  assert.equal(requireAbsolute('~/work/a.md', 'win32', 'C:\\Users\\example'), 'C:\\Users\\example\\work\\a.md')
  assert.equal(requireAbsolute('~\\work\\a.md', 'win32', 'C:\\Users\\example'), 'C:\\Users\\example\\work\\a.md')
  assert.equal(requireAbsolute('~', 'win32', 'C:\\Users\\example'), 'C:\\Users\\example')
  /* 结尾多一个分隔符也不该拼出双斜杠。 */
  assert.equal(requireAbsolute('~/a.md', 'linux', '/home/example/'), '/home/example/a.md')

  /* 原样透传：绝对路径不受影响；别人家的 home、相对路径仍然拒绝。 */
  assert.equal(requireAbsolute('C:\\a\\b.md', 'win32', 'C:\\Users\\example'), 'C:\\a\\b.md')
  assert.throws(() => requireAbsolute('~someone/a.md', 'linux', '/home/example'), /absolute path required/)
  assert.throws(() => requireAbsolute('a/b.md', 'linux', '/home/example'), /absolute path required/)
})
