#!/usr/bin/env node
/**
 * ai-attr — 不依赖 DSH 的 AI 归因程序。
 *
 * 任何 AI 编程工具（或手工）产生的提交，都通过 post-commit hook 在提交时
 * 把新增行写进 git-ai authorship note（refs/notes/ai-tob）；企业上报由带
 * TRAE 凭据的 git-ai daemon 完成；本地看板是一个独立网页。
 *
 * 用法：
 *   ai-attr init [--root <目录>]... [--repo <仓库>]... [--port <端口>]
 *       写配置、给发现的仓库安装 post-commit hook、启动 daemon 并注册。
 *   ai-attr attribute --repo <仓库> [--sha <sha>]
 *       归因一个提交（post-commit hook 调用；单提交快路径）。
 *   ai-attr sync [--repo <仓库>]... [--dry-run]
 *       全量补录历史提交的 note，然后注册所有仓库触发企业侧扫描。
 *   ai-attr serve [--port <端口>] [--open]
 *       本地网页看板（含 daemon 注册与心跳）。
 *   ai-attr status
 *       查看配置、hook 安装情况、daemon 状态与最近日志。
 *   ai-attr uninstall [--repo <仓库>]...
 *       移除 post-commit hook（配置保留）。
 *
 * 配置：~/.ai-attr/config.json；日志：~/.ai-attr/ai-attr.log。
 * 看板数据全部来自本机 git notes，企业控制台是否入账需 T+1 在 TRAE 后台核对。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCredentials, buildRepoList, collect, mainCheckout, toPosix } from '../lib/core.js'
import { createDaemonManager } from '../lib/daemon.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CONFIG_DIR = process.env.AI_ATTR_HOME ?? join(homedir(), '.ai-attr')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
const LOG_PATH = join(CONFIG_DIR, 'ai-attr.log')
const DEFAULT_PORT = 7788
const CACHE_TTL_MS = 300_000
const BEGIN = '# ai-attr: begin'
const END = '# ai-attr: end'

// ---------- 配置与日志 ----------

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  return cfg
}

function log(line) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // 日志失败绝不能影响归因本身。
  }
}

// ---------- 参数 ----------

const MULTI = new Set(['repo', 'root'])

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        if (MULTI.has(key)) (flags[key] ??= []).push(next)
        else flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, flags }
}

function asArray(value) {
  if (value === undefined || value === true) return []
  return Array.isArray(value) ? value : [value]
}

function pushUnique(list, value) {
  const abs = resolve(value)
  const norm = abs.toLowerCase()
  if (!list.some(p => resolve(p).toLowerCase() === norm)) list.push(abs)
}

/** 本次命令要处理的仓库：显式 --repo 优先，否则用配置扫描。 */
function targetRepos(flags) {
  const explicit = asArray(flags.repo)
  if (explicit.length) return [...new Set(explicit.map(p => mainCheckout(resolve(p))))]
  const cfg = loadConfig()
  return buildRepoList({ extra: cfg.extraRepos ?? [], roots: cfg.repoRoots ?? [] }).map(r => r.path)
}

// ---------- daemon（企业上报） ----------

let managerCache = null

function makeDaemon() {
  if (!managerCache) {
    const cfg = loadConfig()
    managerCache = createDaemonManager({
      daemonHome: cfg.daemonHome ?? join(CONFIG_DIR, 'daemon'),
      credentials: buildCredentials({}),
      trace: line => log(`[daemon] ${line}`),
    })
  }
  return managerCache
}

async function ensureDaemon() {
  const manager = makeDaemon()
  await manager.ensureStarted()
  return manager
}

async function registerAll(manager, repos) {
  const results = await Promise.allSettled(repos.map(r => manager.register(r)))
  for (let i = 0; i < repos.length; i++) {
    const one = results[i]
    if (one.status === 'rejected') log(`register failed repo=${repos[i]}: ${one.reason?.message ?? one.reason}`)
  }
  return results.filter(r => r.status === 'fulfilled').length
}

// ---------- post-commit hook ----------

function hookPathOf(repo) {
  return join(repo, '.git', 'hooks', 'post-commit')
}

function installHook(repo) {
  const file = hookPathOf(repo)
  mkdirSync(dirname(file), { recursive: true })
  const block = [
    BEGIN,
    '# 由 ai-attr init 安装：提交后把本提交新增行归因为 AI；ai-attr uninstall 可移除',
    `AI_ATTR_HOME="${toPosix(CONFIG_DIR)}" "${toPosix(process.execPath)}" "${toPosix(join(ROOT, 'bin', 'ai-attr.js'))}" attribute --repo "${toPosix(repo)}" --sha "$GIT_COMMIT" >> "${toPosix(LOG_PATH)}" 2>&1 &`,
    END,
  ].join('\n')
  // Windows 上 git 直接 spawn 无 shebang 的 hook 会报 cannot spawn ENOENT
  const script = `#!/bin/sh\n${block}\n`
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const had = existing.includes(BEGIN)
  const cleaned = existing
    .replace(/#!\/bin\/sh\r?\n(?=# ai-attr: begin)/, '')
    .replace(/# ai-attr: begin[\s\S]*?# ai-attr: end\n?/g, '')
  const next = cleaned.trim() ? `${cleaned.replace(/\s*$/, '\n')}${script}` : script
  writeFileSync(file, next, { mode: 0o755 })
  return had ? 'updated' : 'installed'
}

function uninstallHook(repo) {
  const file = hookPathOf(repo)
  if (!existsSync(file)) return 'absent'
  const text = readFileSync(file, 'utf8')
  if (!text.includes(BEGIN)) return 'absent'
  const cleaned = text
    .replace(/#!\/bin\/sh\r?\n(?=# ai-attr: begin)/, '')
    .replace(/# ai-attr: begin[\s\S]*?# ai-attr: end\n?/g, '')
    .replace(/\s+$/, '')
  if (!cleaned.trim()) rmSync(file)
  else writeFileSync(file, `${cleaned}\n`, { mode: 0o755 })
  return 'removed'
}

// ---------- 子命令 ----------

async function runNode(args) {
  return new Promise(res => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    })
    child.on('error', err => {
      console.error(err.message)
      res(1)
    })
    child.on('close', code => res(code ?? 1))
  })
}

async function cmdInit(flags) {
  const cfg = loadConfig()
  const roots = [...(cfg.repoRoots ?? [])]
  const extra = [...(cfg.extraRepos ?? [])]
  for (const p of asArray(flags.root)) pushUnique(roots, p)
  for (const p of asArray(flags.repo)) pushUnique(extra, p)
  if (!roots.length && !extra.length) {
    console.error('用法: ai-attr init --root <扫描目录> [--repo <仓库>] [--port <端口>]')
    console.error('例:  ai-attr init --root D:\\work\\lowcode')
    process.exit(1)
  }
  const patch = { repoRoots: roots, extraRepos: extra }
  if (flags.port) patch.port = Number(flags.port)
  saveConfig(patch)

  const repos = buildRepoList({ extra, roots })
  const results = { installed: 0, updated: 0 }
  for (const r of repos) {
    results[installHook(mainCheckout(r.path))] += 1
  }
  console.log(`配置写入 ${CONFIG_PATH}`)
  console.log(`发现 ${repos.length} 个仓库：hook 新装 ${results.installed}、更新 ${results.updated}`)
  for (const r of repos) console.log(`  ${r.label ?? r.path}`)
  if (!repos.length) {
    console.warn('没有发现 Git 仓库，检查 --root 是否指向包含仓库的目录')
    return
  }
  try {
    const daemon = await ensureDaemon()
    const ok = await registerAll(daemon, repos.map(r => r.path))
    console.log(`daemon 已启动，注册 ${ok}/${repos.length} 个仓库（企业上报）`)
  } catch (e) {
    console.warn(`daemon 未就绪（本地 note 归因不受影响）: ${e.message}`)
  }
  console.log('\n下一步: ai-attr serve --open   打开本地看板')
}

async function cmdAttribute(flags) {
  const repoFlag = asArray(flags.repo)
  const repo = mainCheckout(resolve(repoFlag.at(-1) ?? process.cwd()))
  const sha = typeof flags.sha === 'string' && flags.sha ? flags.sha : 'HEAD'
  log(`attribute repo=${repo} sha=${sha}`)
  const args = [join(ROOT, 'scripts', 'backfill-notes.mjs'), '--repo', repo, '--only', sha, '--any-author']
  if (flags['dry-run']) args.push('--dry-run')
  const code = await runNode(args)
  try {
    const daemon = await ensureDaemon()
    await daemon.register(repo)
    log(`attribute registered repo=${repo}`)
  } catch (e) {
    log(`attribute daemon unavailable: ${e.message}`)
  }
  saveConfig({ lastRepo: repo })
  process.exitCode = code
}

async function cmdSync(flags) {
  const repos = targetRepos(flags)
  if (!repos.length) {
    console.error('没有仓库：先 ai-attr init --root <目录>')
    process.exit(1)
  }
  console.log(`补录 ${repos.length} 个仓库的 AI note…`)
  const args = [join(ROOT, 'scripts', 'backfill-notes.mjs'), '--any-author']
  for (const r of repos) args.push('--repo', r)
  if (flags['dry-run']) args.push('--dry-run')
  const code = await runNode(args)
  try {
    const daemon = await ensureDaemon()
    const ok = await registerAll(daemon, repos)
    console.log(`daemon 注册 ${ok}/${repos.length} 个仓库（企业侧扫描，控制台 T+1 生效）`)
  } catch (e) {
    console.warn(`daemon 未就绪（note 已补，企业上报待 daemon 恢复后重跑 ai-attr sync）: ${e.message}`)
  }
  process.exitCode = code
}

async function cmdServe(flags) {
  const cfg = loadConfig()
  const port = Number(flags.port ?? cfg.port ?? DEFAULT_PORT)
  const cache = new Map()
  const inflight = new Set()

  const reposNow = () => {
    const current = loadConfig()
    return buildRepoList({ extra: current.extraRepos ?? [], roots: current.repoRoots ?? [] })
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/') {
        const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
      if (url.pathname !== '/git-ai-attribution.json') {
        json(res, 404, { error: 'not found' })
        return
      }
      const q = url.searchParams
      if (q.get('list')) {
        const repos = reposNow()
        const current = loadConfig().lastRepo
        const list = repos.map(r => ({ path: r.path, label: r.label, all: r.all }))
        json(res, 200, {
          repos: list,
          current: list.some(r => r.path === current) ? current : list[0]?.path,
        })
        return
      }
      const repos = reposNow()
      const repo = q.get('repo') ?? repos[0]?.path
      if (!repo) {
        json(res, 400, { error: '还没有仓库：先运行 ai-attr init --root <目录>' })
        return
      }
      const since = q.get('since') ?? undefined
      const until = q.get('until') ?? undefined
      const all = q.get('all') === '1'
      const key = `${repo}|${since ?? ''}|${until ?? ''}|${all}`
      const hit = cache.get(key)
      const age = hit ? Date.now() - hit.at : Number.POSITIVE_INFINITY
      const forced = q.get('refresh') === '1'
      if (hit && age < CACHE_TTL_MS && !forced) {
        json(res, 200, hit.data)
        return
      }
      if (!inflight.has(key)) {
        inflight.add(key)
        collect(repo, { since, until, all })
          .then(data => cache.set(key, { at: Date.now(), data }))
          .catch(e => log(`collect failed repo=${repo}: ${e.message}`))
          .finally(() => inflight.delete(key))
      }
      if (hit) {
        json(res, 200, hit.data) // stale-while-revalidate：先回旧数据，后台刷新
        return
      }
      const data = await collect(repo, { since, until, all })
      cache.set(key, { at: Date.now(), data })
      json(res, 200, data)
    } catch (e) {
      log(`serve request failed: ${e.message}`)
      json(res, 500, { error: e.message })
    }
  })

  server.on('error', e => {
    console.error(`端口 ${port} 不可用: ${e.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${port}/`
    console.log(`AI 归因看板: ${link}`)
    log(`serve listening :${port}`)
    if (flags.open) {
      spawn('cmd', ['/c', 'start', '""', link], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    }
  })

  // daemon 注册与心跳不阻塞看板启动
  ensureDaemon()
    .then(async daemon => {
      const list = reposNow().map(r => r.path)
      const ok = await registerAll(daemon, list)
      log(`serve registered ${ok}/${list.length} repos`)
      setInterval(() => {
        daemon.heartbeat().catch(() => {})
      }, 60_000).unref()
    })
    .catch(e => log(`serve daemon unavailable: ${e.message}`))
}

async function cmdStatus() {
  const cfg = loadConfig()
  console.log(`配置文件: ${CONFIG_PATH}${existsSync(CONFIG_PATH) ? '' : '（尚未创建）'}`)
  if (existsSync(CONFIG_PATH)) console.log(JSON.stringify(cfg, null, 2))
  const repos = buildRepoList({ extra: cfg.extraRepos ?? [], roots: cfg.repoRoots ?? [] })
  console.log(`\n仓库（${repos.length}）:`)
  for (const r of repos) {
    const file = hookPathOf(mainCheckout(r.path))
    const installed = existsSync(file) && readFileSync(file, 'utf8').includes(BEGIN)
    console.log(`  ${installed ? '[hook]' : '  --  '} ${r.label ?? r.path}`)
  }

  const manager = makeDaemon()
  let env
  try {
    env = { ...process.env, ...manager.environment() }
  } catch (e) {
    console.log(`\ndaemon: TRAE 凭据不可用 — ${e.message}`)
  }
  if (env) {
    const r = spawnSync(manager.binary, ['bg', 'status'], { env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    try {
      const parsed = JSON.parse(r.stdout)
      const d = parsed.data?.daemon_status ?? {}
      console.log(`\ndaemon: running=${parsed.daemon?.daemon_running} clients=${d.active_clients} watched=${d.watched_repo_count} socket=${d.control_socket ?? '-'}`)
      for (const w of (d.watched_repos ?? []).slice(0, 20)) console.log(`  watch ${JSON.stringify(w).slice(0, 160)}`)
    } catch {
      console.log(`\ndaemon status 无法解析: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`)
    }
  }

  if (existsSync(LOG_PATH)) {
    const lines = readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n')
    console.log(`\n最近日志（${LOG_PATH}，共 ${lines.length} 行）:`)
    for (const line of lines.slice(-8)) console.log(`  ${line}`)
  }
}

async function cmdUninstall(flags) {
  const repos = targetRepos(flags)
  let removed = 0
  for (const repo of repos) {
    if (uninstallHook(repo) === 'removed') removed++
  }
  console.log(`已移除 ${removed}/${repos.length} 个 post-commit hook（配置保留在 ${CONFIG_PATH}）`)
}

function printHelp() {
  console.log(`ai-attr — 不依赖 DSH 的 AI 归因程序

用法:
  ai-attr init --root <目录>... [--repo <仓库>]... [--port <端口>]
      写配置、安装 post-commit hook、启动 daemon 并注册仓库
  ai-attr attribute --repo <仓库> [--sha <sha>]
      归因单个提交（post-commit hook 调用）
  ai-attr sync [--repo <仓库>]... [--dry-run]
      全量补录历史 note 并注册仓库（企业侧 T+1 生效）
  ai-attr serve [--port <端口>] [--open]
      本地网页看板 http://127.0.0.1:${DEFAULT_PORT}/
  ai-attr status
      查看配置、hook、daemon 状态
  ai-attr uninstall [--repo <仓库>]...
      移除 post-commit hook

配置: ${CONFIG_PATH}
日志: ${LOG_PATH}`)
}

// ---------- 入口 ----------

const { positional, flags } = parseArgs(process.argv.slice(2))
const command = positional[0]

try {
  switch (command) {
    case 'init':
      await cmdInit(flags)
      break
    case 'attribute':
      await cmdAttribute(flags)
      break
    case 'sync':
      await cmdSync(flags)
      break
    case 'serve':
      await cmdServe(flags)
      break
    case 'status':
      await cmdStatus(flags)
      break
    case 'uninstall':
      await cmdUninstall(flags)
      break
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printHelp()
      break
    default:
      console.error(`未知命令: ${command}\n`)
      printHelp()
      process.exit(1)
  }
} catch (e) {
  console.error(e?.stack ?? String(e))
  log(`fatal: ${e?.stack ?? e}`)
  process.exit(1)
}
