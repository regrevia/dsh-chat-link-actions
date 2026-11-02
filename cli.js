#!/usr/bin/env node
/**
 * 命令行入口：给 agent 用的那份接口，和菜单读写同一份文件。
 * agent 的主入口是 `apply --json`（一次配好），其余命令用于查看与单条增删。
 * 用法见 `node cli.js protocol`。
 */
import {
  ACTION_PROTOCOL,
  CUSTOM_KINDS,
  CUSTOM_SCOPES,
  actionIdentity,
  customActionsFile,
  detectTargets,
  inspectCustomActions,
  launchFailure,
  loadCustomActions,
  removeCustomActions,
  runCustomAction,
  sanitizeCustomActions,
  saveCustomActions,
  selectCustomAction
} from './index.js'
import { readFileSync } from 'node:fs'

function parse(argv) {
  const [command = 'protocol', ...rest] = argv
  const flags = {}
  const words = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]  // ui-copy-ignore
    if (token.startsWith('--')) {  // ui-copy-ignore
      const key = token.slice(2)  // ui-copy-ignore
      const value = rest[index + 1] !== undefined && !rest[index + 1].startsWith('--') ? rest[++index] : ''
      flags[key] = value
    } else {
      words.push(token)  // ui-copy-ignore
    }
  }
  return { command, flags, words }
}

async function read() {
  try {
    return await loadCustomActions(customActionsFile())
  } catch (error) {
    throw new Error(explainConfigError(error))
  }
}

/** 配置读不动时给一句能照着做的话，不要只吐错误码。 */
function explainConfigError(error) {
  const code = String(error?.message ?? error)
  const file = customActionsFile()
  if (code === 'config-corrupt') return `入口配置坏了：${file}。改好 JSON 或删掉它再试（没动过原文件）`
  if (code === 'config-unreadable') return `读不了入口配置：${file}。看一眼文件权限再试`
  return code
}

/** One sentence for "which one did you mean": the caller must be able to fix it. */
function explainSelection(label, picked) {
  const scopes = Array.isArray(picked?.scopes) && picked.scopes.length > 0 ? picked.scopes.join(' / ') : '（没有同名入口）'
  if (picked?.error === 'ambiguous') return `「${label}」有多个同名入口：${scopes}。用 --scope 指定要操作哪一个`
  return `没有这条入口：${label}（已有 scope：${scopes}）。可用 scope：${CUSTOM_SCOPES.join(' / ')}`
}

function requireScope(scope) {
  if (scope === undefined || scope === '') return ''
  if (!CUSTOM_SCOPES.includes(scope)) throw new Error(`不认识的 --scope：${scope}。可用：${CUSTOM_SCOPES.join(' / ')}`)
  return scope
}

async function write(actions) {
  const saved = sanitizeCustomActions(actions)
  await saveCustomActions(customActionsFile(), saved)
  return saved
}

const { command, flags, words } = parse(process.argv.slice(2))

try {
  if (command === 'protocol') {
    console.log(JSON.stringify(ACTION_PROTOCOL, null, 2))
  } else if (command === 'list') {
    console.log(JSON.stringify(await read(), null, 2))
  } else if (command === 'detect') {
    console.log(JSON.stringify(await detectTargets(), null, 2))
  } else if (command === 'add') {
    const label = flags.label ?? words[0]
    const kind = flags.kind ?? words[1] ?? 'shell'
    const value = flags.value ?? words.slice(2).join(' ') ?? ''
    const scope = requireScope(flags.scope ?? 'all') || 'all'
    if (label === undefined || label === '') throw new Error('缺少 --label')
    if (!CUSTOM_KINDS.includes(kind)) throw new Error(`不认识的 --kind：${kind}。可用：${CUSTOM_KINDS.join(' / ')}`)
    const current = await read()
    /* 身份是 (label, scope)：同名但不同 scope 是两条，同名同 scope 才覆盖。 */
    const entry = { label, kind, value, scope }
    const index = current.findIndex((item) => actionIdentity(item) === actionIdentity(entry))
    if (index >= 0) current[index] = entry
    else current.push(entry)
    console.log(JSON.stringify(await write(current), null, 2))
  } else if (command === 'apply') {
    /* 一次性配好：给 agent 用的主入口，读 JSON 数组，写完就返回最终结果。 */
    const raw = flags.json ?? (flags.file !== undefined ? readFileSync(flags.file, 'utf8') : '')
    if (String(raw).trim() === '') throw new Error('缺少 --json 或 --file')
    let incoming = []
    try {
      const parsed = JSON.parse(String(raw))
      incoming = Array.isArray(parsed) ? parsed : parsed.actions
    } catch (error) {
      throw new Error('JSON 解析失败：' + String(error?.message ?? error))
    }
    const current = flags.replace === 'true' ? [] : await read()
    const merged = current.slice()
    for (const entry of sanitizeCustomActions(incoming)) {
      const index = merged.findIndex((item) => actionIdentity(item) === actionIdentity(entry))
      if (index >= 0) merged[index] = entry
      else merged.push(entry)
    }
    console.log(JSON.stringify(await write(merged), null, 2))
  } else if (command === 'validate') {
    const raw = flags.json ?? (flags.file !== undefined ? readFileSync(flags.file, 'utf8') : '[]')
    let parsed
    try {
      parsed = JSON.parse(String(raw))
    } catch (error) {
      throw new Error('JSON 解析失败：' + String(error?.message ?? error))
    }
    /* 结构错误非零退出；坏条目逐条列出，不写成「ok: true」。 */
    const inspected = inspectCustomActions(parsed)
    const ok = inspected.errors.length === 0
    console.log(JSON.stringify({ ok, entries: inspected.entries, errors: inspected.errors }, null, 2))
    if (!ok) process.exitCode = 1
  } else if (command === 'remove') {
    const label = flags.label ?? words[0]
    if (label === undefined || label === '') throw new Error('缺少要删除的 label')
    const scope = requireScope(flags.scope)
    const current = await read()
    const request = scope === '' ? { labels: words.length > 0 ? words : [label] } : { items: [{ label, scope }] }
    const removal = removeCustomActions(current, request)
    if (removal.ok !== true) throw new Error(explainSelection(label, removal))
    console.log(JSON.stringify(await write(removal.actions), null, 2))
  } else if (command === 'run') {
    const label = flags.label ?? words[0]
    if (label === undefined || label === '') throw new Error('缺少要运行的 label')
    const scope = requireScope(flags.scope)
    const actions = await read()
    const picked = selectCustomAction(actions, label, scope === '' ? undefined : scope)
    if (picked.ok !== true) throw new Error(explainSelection(label, picked))
    const outcome = await runCustomAction(picked.entry, { path: flags.path, url: flags.url })
    if (outcome?.ok !== true) {
      const failure = launchFailure(outcome)
      throw new Error(`启动失败：${failure.detail}${typeof failure.code === 'number' ? `（退出码 ${failure.code}）` : ''}`)
    }
    console.log(`已执行 ${picked.entry.label}（${picked.entry.kind}）`)
  } else {
    throw new Error(`不认识的命令：${command}。可用：protocol / list / detect / apply / validate / add / remove / run`)
  }
} catch (error) {
  console.error(String(error?.message ?? error))
  process.exitCode = 1
}
