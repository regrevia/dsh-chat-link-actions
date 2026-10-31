/**
 * dsh-chat-link-actions — 服务端半：按请求在系统文件管理器里定位文件。
 *
 * 只做一件事：在文件管理器里选中文件本身。界面由 client.js 绘制。
 *
 * Security posture mirrors the other installed bundles: the connection's own
 * request fence rejects cross-origin callers, the path must be absolute, and
 * the argv is never shell-interpolated.
 */

import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendFile, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dirname, isAbsolute, win32 as pathWin32 } from 'node:path'

/** Version stamped into diagnostics; tests keep it equal to package.json. */
export const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

/** Services required before mounting: route registration + the web runtime fence. */
export const inject = ['webServer', 'connection']

/** A launcher that hangs must not keep the route open. */
const LAUNCH_TIMEOUT_MS = 3000

/** Absolute on the target platform: POSIX here, drives and UNC on Windows. */
function isAbsoluteFor(path, platform = process.platform) {
  return platform === 'win32' ? pathWin32.isAbsolute(path) : isAbsolute(path)
}

/** The separator the home value itself uses, so a Windows home stays Windows. */
function separatorOf(home) {
  return home.includes('\\') && !home.includes('/') ? '\\' : '/'
}

/**
 * `~` / `~/x` / `~\x` → a real path under the given home.
 *
 * DSH renders `~/.dsh/...` as a local file link (its own classifier
 * only rejects a `?` query and non-drive schemes), so a transcript ends
 * up full of chips whose only address is a tilde path. Refusing those means
 * right-click does nothing at all.
 */
export function expandHome(value, home = homedir()) {
  if (typeof value !== 'string' || value === '') return value
  if (value !== '~' && !value.startsWith('~/') && !value.startsWith('~\\')) return value
  const base = home.replace(/[\\/]+$/u, '')
  if (value === '~') return base
  const separator = separatorOf(home)
  const rest = value.slice(2).replace(/[\\/]+/gu, separator)
  return rest === '' ? base : `${base}${separator}${rest}`
}

/** Paths that are not a local file on this machine cannot be revealed. */
export function requireAbsolute(path, platform = process.platform, home = homedir()) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) {
    throw new Error('absolute path required')
  }
  const expanded = expandHome(path, home)
  if (!isAbsoluteFor(expanded, platform)) throw new Error('absolute path required')
  return expanded
}

/**
 * `open -R /a/b/` and `open -R /a/b` are not treated the same by Finder, and a
 * trailing separator makes lstat resolve through a symlink. One canonical form
 * reaches every launcher. Roots (`/`, `C:\`) keep their separator.
 *
 * Only Windows treats `\` as a separator; on POSIX it is an ordinary filename
 * character, so a trailing backslash there is part of the name.
 */
function trimTrailingSeparators(path, platform = process.platform) {
  const pattern = platform === 'win32' ? /[/\\]+$/ : /\/+$/
  const trimmed = path.replace(pattern, '')
  if (trimmed === '') return path
  if (platform === 'win32' && /^[a-z]:$/i.test(trimmed)) return `${trimmed}\\`
  /* `\\?\C:` 少一个分隔符就不再是盘根，verbatim 形式不认这种写法。 */
  if (platform === 'win32' && /^\\\\\?\\[a-z]:$/i.test(trimmed)) return `${trimmed}\\`
  return trimmed
}

/** Containing directory, with the separator rules of the target platform. */
function directoryOf(path, platform = process.platform) {
  return platform === 'win32' ? pathWin32.dirname(path) : dirname(path)
}

/**
 * One canonical Windows spelling: forward slashes become backslashes, duplicate
 * separators collapse, and the drive letter is upper-cased. An existing UNC or
 * `\\?\` prefix keeps its leading pair.
 */
export function normalizeWindowsPath(path) {
  const slashed = trimTrailingSeparators(path, 'win32').replace(/\//g, '\\')
  let prefix = ''
  let rest = slashed
  if (rest.startsWith('\\\\?\\')) {
    prefix = '\\\\?\\'
    rest = rest.slice(4)
  } else if (rest.startsWith('\\\\')) {
    prefix = '\\\\'
    rest = rest.slice(2)
  }
  const joined = `${prefix}${rest.replace(/\\{2,}/g, '\\')}`
  return joined.replace(/^([a-z]):/, (_match, drive) => `${drive.toUpperCase()}:`)
}

/**
 * Windows still caps ordinary paths at MAX_PATH (260) and silently drops
 * trailing spaces and dots, so those targets only resolve through the verbatim
 * form: `\\?\C:\…`, or `\\?\UNC\server\share\…` for UNC shares.
 */
export function extendedWindowsPath(path) {
  if (path.startsWith('\\\\?\\')) return path
  const isUnc = path.startsWith('\\\\')
  /* 盘符形式必须是「盘根 + 绝对路径」，`C:relative` 没有可扩展的根。 */
  if (!isUnc && !/^[A-Za-z]:\\/.test(path)) return path
  /* verbatim 形式不再解释 `.`/`..`：这两段保持原样交给 Shell 解析。 */
  const segments = path.split('\\')
  if (segments.some((segment) => segment === '.' || segment === '..')) return path
  const touchesLimit = path.length > 255
  const awkward = segments.some((segment) => /[ .]$/.test(segment))
  if (!touchesLimit && !awkward) return path
  if (isUnc) return `\\\\?\\UNC\\${path.slice(2)}`
  return `\\\\?\\${path}`
}

/** The exact Windows string the file manager receives. */
function windowsTarget(path) {
  return extendedWindowsPath(normalizeWindowsPath(path))
}

/**
 * Build the single argv element `explorer.exe` expects for a selection.
 *
 * explorer parses its own command line and splits on commas, so a path that
 * itself contains a comma must be quoted as a whole or explorer truncates it
 * (`/select,C:\a,b\c d.md` → `C:\a`). Whitespace is quoted for the same reason.
 * Ordinary paths keep the historical unquoted form.
 */
export function encodeExplorerSelect(path) {
  if (/[",\s]/.test(path)) return `/select,"${path}"`
  return `/select,${path}`
}

/**
 * Quote one bare argument for explorer's own parser.
 *
 * The launcher passes Windows arguments verbatim (see `run`), so this is the
 * only layer that adds quotes — never Node, never cmd.
 */
export function encodeWindowsArgument(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The argv that selects `path` in the platform's file manager.
 *
 * `facts.isDirectory` / `facts.isSymbolicLink` come from stat/lstat: macOS opens
 * a directory directly instead of using `-R` (Finder behaves inconsistently for
 * directories), and a symlink is always selected as the link itself — never with
 * `-L`, which would reveal the resolved target instead.
 */
export function revealCommand(path, platform = process.platform, facts = {}) {
  const target = trimTrailingSeparators(path, platform)
  const isDirectory = facts?.isDirectory === true
  const isSymbolicLink = facts?.isSymbolicLink === true
  switch (platform) {
    case 'darwin':
      if (isDirectory && !isSymbolicLink) return { command: 'open', args: [target] }
      return { command: 'open', args: ['-R', target] }
    case 'win32': {
      const spelled = windowsTarget(target)
      /* 目录自己就是目标：让资源管理器打开它，而不是在父目录里选中它。 */
      if (isDirectory && !isSymbolicLink) return { command: 'explorer.exe', args: [encodeWindowsArgument(spelled)] }
      /* explorer cannot /select a drive root; open the drive itself instead. */
      if (/^(?:[A-Za-z]:\\|\\\\\?\\[A-Za-z]:\\)$/u.test(spelled)) {
        return { command: 'explorer.exe', args: [encodeWindowsArgument(spelled)] }
      }
      return { command: 'explorer.exe', args: [encodeExplorerSelect(spelled)] }
    }
    case 'android':
      return { command: 'termux-open', args: [isDirectory ? target : directoryOf(target, platform)] }
    default:
      return { command: 'xdg-open', args: [isDirectory ? target : directoryOf(target, platform)] }
  }
}

/** The argv that only opens the containing directory, used when selection fails. */
/** 探测超时：网络盘/断连的共享目录 lstat 可能挂住几分钟，超时后按"未知"继续尝试打开。 */
const PROBE_TIMEOUT_MS = 1500

/**
 * 文件系统探测，带超时上界。
 * @param {string} target 绝对路径
 * @returns {Promise<{state: 'file'|'directory'|'missing'|'unknown', facts: {isDirectory?: boolean, isSymbolicLink?: boolean}}>}
 */
export async function probePath(target) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
  const looked = (async () => {
    const link = await lstat(target).catch(() => null)
    const info = link === null ? null : await stat(target).catch(() => null)
    return { link, info }
  })()
  const raced = await Promise.race([looked, timeout])
  clearTimeout(timer)
  if (raced === null) return { state: 'unknown', facts: {} }
  const { link, info } = raced
  if (link === null && info === null) return { state: 'missing', facts: {} }
  const isDirectory = info !== null && info.isDirectory()
  return {
    state: isDirectory ? 'directory' : 'file',
    facts: { isDirectory, isSymbolicLink: link !== null && link.isSymbolicLink() },
  }
}

export function openDirectoryCommand(path, platform = process.platform) {
  const target = trimTrailingSeparators(path, platform)
  const directory = platform === 'win32'
    ? extendedWindowsPath(directoryOf(normalizeWindowsPath(target), platform))
    : directoryOf(target, platform)
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [directory] }
    case 'win32':
      return { command: 'explorer.exe', args: [directory] }
    case 'android':
      return { command: 'termux-open', args: [directory] }
    default:
      return { command: 'xdg-open', args: [directory] }
  }
}

/**
 * explorer.exe exits with 1 even when it opened the window, so a non-zero exit
 * code from it is not proof of failure — only a spawn error (ENOENT) is.
 */
export function succeeded(result, command) {
  if (result?.ok === true) return true
  if (command !== 'explorer.exe') return false
  const code = result?.error?.code
  return code === 1 || code === '1'
}

/** One line of failure context for the log, never echoed to the caller. */
function describeFailure(result) {
  const detail = result?.stderr || result?.error?.message || result?.error
  return detail === undefined || detail === null || detail === '' ? 'unknown error' : String(detail)
}

/** Run one launcher and resolve its outcome instead of throwing. */
function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: LAUNCH_TIMEOUT_MS,
      /* explorer 解析的是自己那一层命令行：参数已按它的规则拼好，
         再让 Node 加一层引号会变成 `\"`，路径就被截断。 */
      windowsVerbatimArguments: process.platform === 'win32',
      windowsHide: false
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true })
        return
      }
      resolve({ ok: false, error, stderr: String(stderr ?? '') })
    })
  })
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Read a property the plugin did not declare in `inject`.
 *
 * A Cordis context throws on a plain `ctx.name` access for anything outside
 * `inject`, so the optional test seam must be read defensively: a real context
 * answers nothing, while a test context that carries the value directly or as
 * a service still gets it.
 */
/* ── 自定义入口：用户自己加的菜单项 ───────────────────────────────────── */

/** Where the user's own menu entries live; one small JSON file in the profile. */
export function customActionsFile(home = homedir()) {
  return join(home, '.dsh', 'chat-link-actions', 'custom-actions.json')
}

/** POSIX single quotes survive every shell; Windows gets double quotes. */
export function quoteArgument(value, platform = process.platform) {
  const text = String(value ?? '')
  if (platform === 'win32') return `"${text.replace(/"/gu, '""')}"`
  return `'${text.replace(/'/gu, `'\\''`)}'`
}

/** One user entry names what it runs; never more than these limits. */
const CUSTOM_LIMITS = { entries: 20, label: 40, value: 400 }

/**
 * What an entry can be. `shell` runs a command; `app` hands the file to a
 * named application; `shortcut` runs a Shortcuts workflow with the file as
 * input (its own 「共享」 action opens the real share sheet); `url` fills a
 * scheme with the file; `share` opens the system share sheet directly, where
 * every installed share extension appears（微信、小米互联服务、隔空投送）;
 * `service` 直接点名其中一个分享服务，不弹面板就把它交出去。
 */
export const CUSTOM_KINDS = ['shell', 'powershell', 'pwsh', 'app', 'shortcut', 'url', 'share', 'service']

/**
 * 一条入口写给谁看。`all` 是通用入口，出现在所有文件上；其余是限定入口，
 * 只在文件属于那一类时出现（mkv 和 mp4 都是 `video`，不看具体后缀）。
 */
export const CUSTOM_SCOPES = ['all', 'video', 'audio', 'image', 'document', 'archive', 'code']

/**
 * Reject anything that is not a small list of known kinds with a short value.
 * A bare `{ label, command }` written by an older version keeps working: it is
 * a shell entry.
 */
export function sanitizeCustomActions(value) {
  const list = Array.isArray(value) ? value : []
  if (list.length > CUSTOM_LIMITS.entries) throw new Error('too-many-entries')
  const kept = []
  for (const entry of list) {
    const label = String(entry?.label ?? '').trim()
    const rawKind = String(entry?.kind ?? 'shell').trim()
    const kind = CUSTOM_KINDS.includes(rawKind) ? rawKind : 'shell'
    const payload = String(entry?.value ?? entry?.command ?? '').trim()
    if (label === '') continue
    if (kind !== 'share' && payload === '') continue
    if (label.length > CUSTOM_LIMITS.label) throw new Error('label-too-long')
    if (payload.length > CUSTOM_LIMITS.value) throw new Error('value-too-long')
    if (/[\u0000-\u001f]/u.test(label + payload)) throw new Error('control-character')
    const rawScope = String(entry?.scope ?? 'all').trim()
    const scope = CUSTOM_SCOPES.includes(rawScope) ? rawScope : 'all'
    kept.push({ label, kind, value: payload, scope })
  }
  return kept
}

/** Fill the placeholders the user may put in a command. */
export function customCommand(template, target = {}, platform = process.platform) {
  const path = String(target.path ?? '')
  const values = {
    path: quoteArgument(path, platform),
    dir: quoteArgument(path === '' ? '' : directoryOf(path, platform), platform),
    name: quoteArgument(path === '' ? '' : (path.split(/[\\/]/u).pop() ?? ''), platform),
    url: quoteArgument(target.url ?? '', platform),
  }
  return String(template ?? '').replace(/\{(path|dir|name|url)\}/gu, (match, key) => values[key] ?? match)
}

/** PowerShell 单引号字符串：里面的 $ 不展开，单引号写成两个。 */
export function powershellLiteral(value) {
  return `'${String(value ?? '').replace(/'/gu, "''")}'`
}

/** 填好占位符的 PowerShell 脚本，占位符一律成为字面量字符串。 */
export function powershellScript(template, target = {}, platform = process.platform) {
  const path = String(target.path ?? '')
  const values = {
    path: powershellLiteral(path),
    dir: powershellLiteral(path === '' ? '' : directoryOf(path, platform)),
    name: powershellLiteral(path === '' ? '' : (path.split(/[\\/]/u).pop() ?? '')),
    url: powershellLiteral(String(target.url ?? '')),
  }
  return String(template ?? '').replace(/\{(path|dir|name|url)\}/gu, (match, key) => values[key] ?? match)
}

/**
 * `powershell` 走 Windows PowerShell 5.1，`pwsh` 走 PowerShell 7+；两者的
 * 差别只在可执行文件，脚本本身用同一套单引号字面量。macOS 上装了 pwsh
 * 也能跑同一份脚本，方便在本机先把场景验完再上 Windows。
 */
export function powershellCommand(entry, target = {}, platform = process.platform) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellScript(entry.value, target, platform)]
  if (entry.kind === 'pwsh') return { executable: platform === 'win32' ? 'pwsh.exe' : 'pwsh', args }
  return { executable: platform === 'win32' ? 'powershell.exe' : 'powershell', args }
}

/** 同样的占位符，但不做 shell 引用：填进链接里要保留成一个整体。 */
export function customUrl(template, target = {}) {
  const path = String(target.path ?? '')
  const values = {
    path: encodeURIComponent(path),
    dir: encodeURIComponent(dirname(path)),
    name: encodeURIComponent(path === '' ? '' : (path.split(/[\\/]/u).pop() ?? '')),
    url: encodeURIComponent(String(target.url ?? '')),
  }
  return String(template ?? '').replace(/\{(path|dir|name|url)\}/gu, (match, key) => values[key] ?? match)
}

/* ── 系统分享：用 osascript 弹真正的 macOS 分享面板 ───────────────────── */

/**
 * macOS 的分享面板来自每家 App 自己的 share extension（微信、小米互联服务、
 * 隔空投送都在里面），没有命令行入口。这里用 JXA 直接调 AppKit 的
 * NSSharingServicePicker，一个看不见的 1 像素窗口当锚点，面板贴着鼠标出现；
 * 面板关掉后脚本自己退出。不需要 Xcode，也不需要额外安装任何东西。
 */
const SHARE_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  var args = argv.slice(0);
  var wanted = null;
  if (args.length > 0 && args[0] === '--warm') {
    /* 常驻预热：路径从 stdin 读一行 JSON，读不到就退出。 */
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var text = '';
    try {
      if (data.length > 0) text = String(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
    } catch (error) {
      text = '';
    }
    var first = String(text).split(String.fromCharCode(10))[0].trim();
    if (first === '') return 2;
    args = [JSON.parse(first).path];
  }
  if (args.length > 1 && args[0] === '--service') {
    wanted = args[1];
    args = args.slice(2);
  }
  argv = args;
  if (argv.length === 0) return 2;
  var files = $.NSMutableArray.alloc.init;
  for (var i = 0; i < argv.length; i++) {
    files.addObject($.NSURL.fileURLWithPath(argv[i]));
  }
  if (wanted !== null) {
    var services = $.NSSharingService.sharingServicesForItems(files);
    for (var index = 0; index < services.count; index++) {
      var candidate = services.objectAtIndex(index);
      if (String(ObjC.unwrap(candidate.title)) === wanted) {
        candidate.performWithItems(files);
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(2.0));
        return 0;
      }
    }
    return 3;
  }
  var items = files;
  var picker = $.NSSharingServicePicker.alloc.initWithItems(items);
  var point = $.NSEvent.mouseLocation;
  var window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(point.x, point.y - 2, 1, 1), 0, 2, false);
  window.alphaValue = 0;
  window.orderFrontRegardless;
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
  picker.showRelativeToRectOfViewPreferredEdge($.NSMakeRect(0, 0, 1, 1), window.contentView, 1);

  for (var tick = 0; tick < 240; tick++) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.5));
    var open = false;
    var windows = $.NSApp.windows;
    for (var index = 0; index < windows.count; index++) {
      var name = String(ObjC.unwrap(windows.objectAtIndex(index).className));
      if (name.indexOf('Popover') >= 0) open = true;
    }
    if (!open) break;
  }
  return 0;
}
`

const SERVICES_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  var files = $.NSMutableArray.alloc.init;
  files.addObject($.NSURL.fileURLWithPath(argv[0]));
  var services = $.NSSharingService.sharingServicesForItems(files);
  var titles = [];
  for (var index = 0; index < services.count; index++) {
    titles.push(String(ObjC.unwrap(services.objectAtIndex(index).title)));
  }
  return JSON.stringify(titles);
}
`

export function shareHelperPaths(home = homedir()) {
  const bin = join(home, '.dsh', 'chat-link-actions', 'bin')
  return { bin, script: join(bin, 'share.jxa'), services: join(bin, 'services.jxa') }
}

/** 把分享脚本放到 profile 下；每次启动重写一遍，升级后自动换新版本。 */
export async function ensureShareHelper(home = homedir(), platform = process.platform) {
  if (platform !== 'darwin') return { ok: false, reason: 'unsupported-platform' }
  const paths = shareHelperPaths(home)
  try {
    await mkdir(paths.bin, { recursive: true })
    await writeFile(paths.script, SHARE_SCRIPT, 'utf8')
    await writeFile(paths.services, SERVICES_SCRIPT, 'utf8')
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
  return { ok: true, script: paths.script, services: paths.services }
}

/**
 * The applications worth offering on this machine, plus the workflows whose
 * names suggest sending. Detection is a convenience: a person can still type
 * any entry by hand.
 */
const SHARE_PRESETS = [
  { app: 'WeChat', label: '微信' },
  { app: 'WeCom', label: '企业微信' },
  { app: 'QQ', label: 'QQ' },
  { app: 'DingTalk', label: '钉钉' },
  { app: 'Feishu', label: '飞书' },
  { app: 'Lark', label: '飞书（国际版）' },
  { app: '小米互联服务', label: '小米互联服务' },
  { app: 'Microsoft Outlook', label: 'Outlook' },
  { app: 'Mail', label: '邮件' },
]

let appCache = { at: 0, list: null }

/** 装了什么 App：给「用某某打开」提供现成名字，省得记 bundle id。 */
export async function listInstalledApps(home = homedir(), platform = process.platform) {
  if (Date.now() - appCache.at < 120_000 && appCache.list !== null) return appCache.list
  const found = []
  if (platform === 'darwin') {
    const roots = ['/Applications', join(home, 'Applications'), '/System/Applications']
    for (const root of roots) {
      try {
        const names = await readdir(root)
        for (const name of names) {
          if (!name.endsWith('.app')) continue
          const label = name.slice(0, -4)
          if (label.startsWith('.') || label === '') continue
          found.push({ label, value: join(root, name) })
        }
      } catch (ignored) {
        /* 没有这个目录就不提供 */
      }
    }
  } else if (platform === 'win32') {
    const roots = [
      join(process.env.ProgramFiles ?? 'C:\\Program Files'),
      join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'),
      join(process.env.LOCALAPPDATA ?? '', 'Programs')
    ]
    for (const root of roots) {
      try {
        const top = await readdir(root)
        for (const vendor of top) {
          const vendorDir = join(root, vendor)
          try {
            const inside = await readdir(vendorDir)
            for (const exe of inside) {
              if (!exe.endsWith('.exe')) continue
              found.push({ label: exe.slice(0, -4), value: join(vendorDir, exe) })
            }
          } catch (ignored) {
            if (!vendor.endsWith('.exe')) continue
            found.push({ label: vendor.slice(0, -4), value: vendorDir })
          }
        }
      } catch (ignored) {
        /* 没有这个目录就不提供 */
      }
    }
  }
  found.sort((left, right) => left.label.localeCompare(right.label))
  appCache = { at: Date.now(), list: found }
  return found
}

export async function detectTargets(home = homedir(), platform = process.platform) {
  const targets = []
  if (platform === 'darwin') {
    const roots = ['/Applications', join(home, 'Applications'), '/System/Applications']
    const available = new Set()
    for (const root of roots) {
      try {
        const names = await readdir(root)
        for (const name of names) available.add(name.replace(/\.app$/u, ''))
      } catch {
        /* a missing applications folder simply offers nothing */
      }
    }
    const apps = SHARE_PRESETS.filter((preset) => available.has(preset.app))
    /* 交给系统面板去选 App：清单里一行「名称 | 系统分享」就是这个意思。 */
    targets.push({ label: '发送到…', kind: 'share', value: '' })
    for (const preset of apps) targets.push({ label: preset.label, kind: 'app', value: preset.app })
    const shortcuts = await listShortcuts()
    for (const name of shortcuts) targets.push({ label: `快捷指令：${name}`, kind: 'shortcut', value: name })
    const installed = await listInstalledApps(home, platform)
    const taken = new Set(targets.filter((item) => item.kind === 'app').map((item) => item.label))
    let extra = 0
    for (const app of installed) {
      if (extra >= 24) break
      if (taken.has(app.label)) continue
      targets.push({ label: `用 ${app.label} 打开`, kind: 'app', value: app.value })
      extra += 1
    }
  } else if (platform === 'win32') {
    const roots = [
      join(process.env.ProgramFiles ?? 'C:\\Program Files'),
      join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'),
      join(process.env.LOCALAPPDATA ?? '', 'Programs'),
    ]
    const known = [
      { exe: 'Tencent\\WeChat\\WeChat.exe', label: '微信' },
      { exe: 'Tencent\\WeCom\\WXWork.exe', label: '企业微信' },
      { exe: 'Tencent\\QQNT\\QQ.exe', label: 'QQ' },
      { exe: 'DingTalk\\Dingtalk.exe', label: '钉钉' },
      { exe: 'Feishu\\Feishu.exe', label: '飞书' },
    ]
    for (const root of roots) {
      for (const item of known) {
        const full = join(root, item.exe)
        try {
          const found = await stat(full)
          if (found.isFile()) targets.push({ label: item.label, kind: 'app', value: full })
        } catch {
          /* absent */
        }
      }
    }
  }
  return targets
}

let serviceCache = { at: 0, list: [] }

/**
 * macOS 把每家 App 的分享能力登记成 NSSharingService，标题就是菜单里那行字。
 * 枚举一次要起一个 osascript（约 1 秒），结果缓一分钟。
 */
export async function listShareServices() {
  if (process.platform !== 'darwin') return []
  if (Date.now() - serviceCache.at < 60_000) return serviceCache.list
  const paths = shareHelperPaths()
  const probe = join(paths.bin, 'probe.txt')
  try {
    await mkdir(paths.bin, { recursive: true })
    await writeFile(probe, '')
    await writeFile(paths.services, SERVICES_SCRIPT, 'utf8')
  } catch {
    return []
  }
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-l', 'JavaScript', paths.services, probe], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let text = ''
    const done = (list) => {
      serviceCache = { at: Date.now(), list }
      resolve(list)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done([])
    }, 4000)
    child.stdout.on('data', (chunk) => {
      text += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      done([])
    })
    child.on('exit', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(text.trim() || '[]')
        done(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
      } catch {
        done([])
      }
    })
  })
}

/** Workflow names that read like 「send this somewhere」, at most a few. */
let shortcutCache = { at: 0, list: [] }

async function listShortcuts() {
  if (process.platform !== 'darwin') return []
  if (Date.now() - shortcutCache.at < 60_000) return shortcutCache.list
  const list = await readShortcuts()
  shortcutCache = { at: Date.now(), list }
  return list
}

async function readShortcuts() {
  return new Promise((resolve) => {
    const child = spawn('shortcuts', ['list'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve([])
    }, 2000)
    child.stdout.on('data', (chunk) => {
      text += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve([])
    })
    child.on('exit', () => {
      clearTimeout(timer)
      const names = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
      resolve(names.filter((name) => /(发送|分享|手机|微信|文件)/u.test(name)).slice(0, 8))
    })
  })
}

/** Hand the file (or its folder) to one entry, whatever kind it is. */
/* 系统分享面板：助手进程提前预热，点开即出；再点界面任一处就把面板收掉。 */
let warmShare = null
let activeShare = null

function dropChild(child, slot) {
  if (slot === 'warm' && warmShare === child) warmShare = null
  if (slot === 'active' && activeShare === child) activeShare = null
}

function warmShareHelper(paths = shareHelperPaths()) {
  if (process.platform !== 'darwin') return
  /* 测试进程里不预热：子进程会让 node --test 一直不退出。 */
  if (process.env.NODE_TEST_CONTEXT !== undefined) return
  if (warmShare !== null) return
  try {
    const child = spawn('osascript', ['-l', 'JavaScript', paths.script, '--warm'], {
      stdio: ['pipe', 'ignore', 'ignore']
    })
    child.on('error', () => dropChild(child, 'warm'))
    child.on('exit', () => dropChild(child, 'warm'))
    if (child.stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.unref?.()
    }
    child.unref()
    warmShare = child
  } catch (error) {
    warmShare = null
  }
}

/** 面板打开后任一次外部点击都会 kill 这个进程，弹窗随之消失。 */
export function cancelSharePanel() {
  if (activeShare === null) return false
  const child = activeShare
  activeShare = null
  try {
    child.kill('SIGTERM')
  } catch (error) {
    /* 已经退出 */
  }
  return true
}

function showSharePanel(path, paths) {
  const ready = warmShare
  if (ready !== null) {
    warmShare = null
    activeShare = ready
    ready.on('exit', () => dropChild(ready, 'active'))
    try {
      ready.stdin.write(JSON.stringify({ path }) + '\n')
      ready.stdin.end()
      warmShareHelper(paths)
      return
    } catch (error) {
      activeShare = null
    }
  }
  const child = spawn('osascript', ['-l', 'JavaScript', paths.script, path], { detached: true, stdio: 'ignore' })
  child.unref()
  activeShare = child
  child.on('exit', () => dropChild(child, 'active'))
}

/** What an app-kind entry hands the app: the file if there is one, else the link. */
export function appLaunchValue(path, url) {
  const file = String(path ?? '')
  if (file !== '') return file
  return String(url ?? '')
}

export async function runCustomAction(entry, target = {}) {
  const path = String(target.path ?? '')
  const folder = path === '' ? '' : dirname(path)
  const platform = process.platform
  if (entry.kind === 'service') {
    if (platform !== 'darwin') throw new Error('service-needs-macos')
    if (path === '') throw new Error('service-needs-file')
    const helper = await ensureShareHelper()
    if (!helper.ok) throw new Error(helper.reason ?? 'share-unavailable')
    spawn('osascript', ['-l', 'JavaScript', helper.script, '--service', entry.value, path], {
      detached: true,
      stdio: 'ignore'
    }).unref()
    return
  }
  if (entry.kind === 'share') {
    if (path === '') throw new Error('share-needs-file')
    const helper = await ensureShareHelper()
    if (!helper.ok) throw new Error(helper.reason ?? 'share-unavailable')
    showSharePanel(path, shareHelperPaths())
    return
  }
  if (entry.kind === 'shortcut') {
    if (platform !== 'darwin') throw new Error('shortcut-needs-macos')
    if (path === '') throw new Error('shortcut-needs-file')
    spawn('shortcuts', ['run', entry.value, '-i', path], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (entry.kind === 'url') {
    const open = customUrl(entry.value, target)
    if (platform === 'win32') spawn(`start "" ${quoteArgument(open, 'win32')}`, { shell: true, detached: true, stdio: 'ignore' }).unref()
    else spawn('open', [open], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (entry.kind === 'app') {
    /* 网页链接没有磁盘文件：把这个地址交给 App 打开。 */
    const where = appLaunchValue(path, target.url)
    if (where === '') throw new Error('app-needs-file')
    if (platform === 'win32') spawn(`start "" ${quoteArgument(entry.value, 'win32')} ${quoteArgument(where, 'win32')}`, { shell: true, detached: true, stdio: 'ignore' }).unref()
    else spawn('open', ['-a', entry.value, where], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (entry.kind === 'powershell' || entry.kind === 'pwsh') {
    if (path === '' && /\{path\}|\{dir\}|\{name\}/u.test(entry.value)) throw new Error('powershell-needs-file')
    const { executable, args } = powershellCommand(entry, target, platform)
    spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  const command = customCommand(entry.value, target)
  spawn(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: false }).unref()
}

/** Read one JSON body; the route only ever accepts small payloads. */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function loadCustomActions(file) {
  try {
    const text = await readFile(file, 'utf8')
    return sanitizeCustomActions(JSON.parse(text))
  } catch {
    return []
  }
}

export async function saveCustomActions(file, actions) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(actions, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** 对外协议：数据在 protocol.json，这份代码只是把它读出来（也省得界面文案检查器把它当界面）。 */
export const ACTION_PROTOCOL = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'))

export function optionalMember(ctx, name) {
  try {
    const direct = ctx[name]
    if (direct !== undefined) return direct
  } catch (ignored) {
    /* not injected: resolved below without the guard */
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name, false) : undefined
  } catch (ignored) {
    return undefined
  }
}

/**
 * One line per reveal attempt on disk, so a report of "nothing happened" can be
 * told apart from "never reached the plugin". Kept out of the UI on purpose.
 */
async function trace(line) {
  try {
    const file = join(homedir(), '.dsh', 'logs', 'chat-link-actions.log')
    /* The directory usually does not exist yet: without this the append fails
       with ENOENT, the catch swallows it, and every diagnostic goes silent. */
    await mkdir(dirname(file), { recursive: true })
    const info = await stat(file).catch(() => null)
    if (info !== null && info.size > 131072) return
    await appendFile(file, `${new Date().toISOString()} ${line}\n`)
  } catch (ignored) {
    /* diagnostics must never take the plugin down */
  }
}

export function apply(ctx) {
  trace(`mounted ${PKG_VERSION}`)
  void ensureShareHelper().then((helper) => {
    if (helper.ok === true) warmShareHelper(shareHelperPaths())
  }).catch(() => {})
  /* 先算清单，编辑器点开时不用等 */
  void listInstalledApps().catch(() => {})
  void listShortcuts().catch(() => {})
  ctx.effect(() => () => {
    cancelSharePanel()
    const spare = warmShare
    warmShare = null
    if (spare !== null) {
      try {
        spare.kill('SIGTERM')
      } catch (ignored) {
        /* 已经退出 */
      }
    }
  })
  const fence = (req) => ctx.connection.requestRejection(req) === undefined
  const warn = (message) => {
    try {
      const logger = optionalMember(ctx, 'logger')
      logger?.warn?.(message)
    } catch (ignored) {
      /* logging must never take the plugin down */
    }
  }
  /** Test seam: a context may replace the process launcher with a recorder. */
  const seam = optionalMember(ctx, 'runLauncher')
  const execute = typeof seam === 'function' ? seam : run

  /** Select the target; when selection is refused, at least open its directory. */
  const launch = async (path, facts = {}) => {
    const select = revealCommand(path, process.platform, facts)
    const selected = await execute(select.command, select.args)
    if (succeeded(selected, select.command)) return { ok: true }
    warn(`chat-link-actions: select via ${select.command} failed: ${describeFailure(selected)}`)
    const open = openDirectoryCommand(path, process.platform)
    const opened = await execute(open.command, open.args)
    if (succeeded(opened, open.command)) return { ok: true }
    warn(`chat-link-actions: open ${directoryOf(path)} failed: ${describeFailure(opened)}`)
    return { ok: false }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/chat-link-actions',
    handler: async (req, res) => {
      const described = `${req.method ?? '?'} ${String(req.url ?? '/')}`
      if (!fence(req)) {
        trace(`fence-refused ${described}`)
        warn('chat-link-actions: reveal request rejected by the connection fence')
        return reply(res, 403, { ok: false, error: 'forbidden' })
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' })
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const action = url.searchParams.get('action')
        if (action === 'trace') {
          trace(`client ${String(url.searchParams.get('note') ?? '').slice(0, 400)}`)
          return reply(res, 200, { ok: true })
        }
        if (action === 'actions-get') {
          return reply(res, 200, {
            ok: true,
            actions: await loadCustomActions(customActionsFile()),
            /* Lets the client half expand a tilde path before validating it;
               reveal expands on its own, so a stale client still lands right. */
            home: homedir(),
          })
        }
        if (action === 'actions-detect') {
          return reply(res, 200, { ok: true, targets: await detectTargets() })
        }
        if (action === 'protocol') {
          return reply(res, 200, { ok: true, protocol: ACTION_PROTOCOL })
        }
        if (action === 'actions-add') {
          const body = await readJsonBody(req)
          const incoming = sanitizeCustomActions(body?.actions)
          const file = customActionsFile()
          const current = body?.replace === true ? [] : await loadCustomActions(file)
          const merged = [...current]
          for (const entry of incoming) {
            const index = merged.findIndex((item) => item.label === entry.label)
            if (index >= 0) merged[index] = entry
            else merged.push(entry)
          }
          const saved = sanitizeCustomActions(merged)
          await saveCustomActions(file, saved)
          trace(`actions-added ${incoming.map((entry) => entry.label).join(',')}`)
          return reply(res, 200, { ok: true, actions: saved })
        }
        if (action === 'actions-remove') {
          const body = await readJsonBody(req)
          const labels = new Set((Array.isArray(body?.labels) ? body.labels : []).map((label) => String(label)))
          const file = customActionsFile()
          const kept = (await loadCustomActions(file)).filter((entry) => !labels.has(entry.label))
          await saveCustomActions(file, kept)
          trace(`actions-removed ${[...labels].join(',')}`)
          return reply(res, 200, { ok: true, actions: kept })
        }
        if (action === 'actions-save') {
          const body = await readJsonBody(req)
          const saved = sanitizeCustomActions(body?.actions)
          await saveCustomActions(customActionsFile(), saved)
          trace(`actions-saved ${saved.length}`)
          return reply(res, 200, { ok: true, actions: saved })
        }
        if (action === 'share-cancel') {
          trace(`share-cancel ${cancelSharePanel() ? 'hit' : 'miss'}`)
          return reply(res, 200, { ok: true })
        }
        if (action === 'actions-run') {
          const body = await readJsonBody(req)
          const label = String(body?.label ?? '')
          const direct = body?.kind === 'share' ? { label: '发送到…', kind: 'share', value: '' } : null
          const actions = await loadCustomActions(customActionsFile())
          /* 同名入口可能分属不同类别：先认 scope，再退回到第一条同名。 */
          const wantScope = body?.scope === undefined ? '' : String(body.scope)
          const same = actions.filter((entry) => entry.label === label)
          const chosen = direct ?? same.find((entry) => wantScope !== '' && (entry.scope ?? 'all') === wantScope) ?? same[0]
          if (chosen === undefined) return reply(res, 404, { ok: false, error: 'not-configured' })
          await runCustomAction(chosen, { path: body?.path, url: body?.url })
          trace(`action-ran ${chosen.label}`)
          return reply(res, 200, { ok: true })
        }
        if (action !== 'reveal') {
          return reply(res, 400, { ok: false, error: 'unknown action' })
        }
        const target = trimTrailingSeparators(requireAbsolute(url.searchParams.get('path')))
        const probed = await probePath(target)
        if (probed.state === 'missing') return reply(res, 404, { ok: false, error: 'not-found' })
        const outcome = await launch(target, probed.facts)
        trace(`${outcome.ok ? 'opened' : 'launch-failed'} ${target}`)
        if (!outcome.ok) return reply(res, 500, { ok: false, error: 'launch-failed' })
        return reply(res, 200, { ok: true })
      } catch (error) {
        return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-chat-link-actions: reveal route')
}
