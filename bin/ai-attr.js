#!/usr/bin/env node
/**
 * ai-attr — 不依赖 DSH 的 AI 归因程序。
 *
 * 任何 AI 编程工具（或手工）产生的提交，都通过 pre-commit hook 在提交前声明为 AI 编辑
 * （写 git-ai checkpoint），daemon 结算时自己写 note（refs/notes/ai-tob）并把 ai>0
 * 上报企业后台（带 TRAE 凭据）；post-commit hook 只做延迟兜底补 note；本地看板是独立网页。
 *
 * 用法：
 *   ai-attr init [--root <目录>]... [--repo <仓库>]... [--port <端口>]
 *       写配置、安装 pre-commit + post-commit hook、启动 daemon 并注册。
 *   ai-attr checkpoint --repo <仓库>
 *       把暂存区改动声明为 AI 编辑（pre-commit hook 调用；daemon 结算后上报企业后台）。
 *   ai-attr attribute --repo <仓库> [--sha <sha>]
 *       归因一个提交（post-commit hook 兜底调用；单提交快路径）。
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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// ---------- git hooks（pre-commit 写 checkpoint、post-commit 兜底补 note） ----------

function hookPathOf(repo, kind = 'post-commit') {
  return join(repo, '.git', 'hooks', kind)
}

function writeHookBlock(file, blockLines) {
  mkdirSync(dirname(file), { recursive: true })
  // Windows 上 git 直接 spawn 无 shebang 的 hook 会报 cannot spawn ENOENT
  const script = `#!/bin/sh\n${blockLines.join('\n')}\n`
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const had = existing.includes(BEGIN)
  const cleaned = existing
    .replace(/#!\/bin\/sh\r?\n(?=# ai-attr: begin)/, '')
    .replace(/# ai-attr: begin[\s\S]*?# ai-attr: end\n?/g, '')
  const next = cleaned.trim() ? `${cleaned.replace(/\s*$/, '\n')}${script}` : script
  writeFileSync(file, next, { mode: 0o755 })
  return had
}

function installHook(repo) {
  const head = `AI_ATTR_HOME="${toPosix(CONFIG_DIR)}" "${toPosix(process.execPath)}" "${toPosix(join(ROOT, 'bin', 'ai-attr.js'))}"`
  const toLog = `>> "${toPosix(LOG_PATH)}" 2>&1`
  const hadPre = writeHookBlock(hookPathOf(repo, 'pre-commit'), [
    BEGIN,
    '# 由 ai-attr init 安装：提交前把暂存改动声明为 AI 编辑，daemon 结算后写 note 并上报企业后台。',
    '# 同步执行（不 &）：先发 human 基线再发 ai_agent，轮询 daemon 日志等',
    '# `checkpoint: saved kind=AiAgent` 才放行——保存必须早于提交（生产实测保存',
    '# 晚于提交 14.7 秒则结算 attestations=0）。保存通常在受理后 15~20 秒，总时长',
    '# 约 40 秒（最长 75 秒）；超时记 SAVE-TIMEOUT 继续，不阻塞提交。',
    `${head} checkpoint --repo "${toPosix(repo)}" ${toLog}`,
    END,
  ])
  const hadPost = writeHookBlock(hookPathOf(repo, 'post-commit'), [
    BEGIN,
    '# 由 ai-attr init 安装：延迟兜底补 note。有 checkpoint 时 daemon 约 75 秒后自己写 note',
    '# 并上报（ai>0）；立即写 note 会打断结算（preserved note is invalid），',
    '# 所以只在 240 秒后补写——note 已完整则跳过。',
    `( sleep 240 ; ${head} attribute --repo "${toPosix(repo)}" --sha "$GIT_COMMIT" ) ${toLog} &`,
    END,
  ])
  return hadPre || hadPost ? 'updated' : 'installed'
}

function uninstallHook(repo) {
  let removed = 'absent'
  for (const kind of ['pre-commit', 'post-commit']) {
    const file = hookPathOf(repo, kind)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes(BEGIN)) continue
    const cleaned = text
      .replace(/#!\/bin\/sh\r?\n(?=# ai-attr: begin)/, '')
      .replace(/# ai-attr: begin[\s\S]*?# ai-attr: end\n?/g, '')
      .replace(/\s+$/, '')
    if (!cleaned.trim()) rmSync(file)
    else writeFileSync(file, `${cleaned}\n`, { mode: 0o755 })
    removed = 'removed'
  }
  return removed
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

/**
 * 把暂存区改动声明为 AI 编辑（pre-commit hook 同步调用）。
 * 完全复刻插件时序：先发 human 基线、再发 ai_agent，然后**等 daemon 日志出现
 * `checkpoint: saved … kind=AiAgent` 才放行提交**。生产实测（dc7b0db）：确认
 * 只等 `checkpoint start` 时 git 在确认后 1.3s 就建了提交、而保存晚于提交 14.7s
 * → 结算 attestations=0；成功的轮次与插件时代窗口全部是 saved 早于提交。
 * 另：working log 里没有任何 Human 记录时（生产首提交）结算拿不到基线 → att=0，
 * 所以 human 必发（human 不占行 additions=0，只做基线标记）。
 * 客户端 10 秒被杀无妨：stdin 写完即送达，daemon 异步处理；exit=1 不代表失败。
 */
async function cmdCheckpoint(flags) {
  const repoFlag = asArray(flags.repo)
  if (!repoFlag.length) {
    console.error('用法: ai-attr checkpoint --repo <仓库>')
    process.exitCode = 1
    return
  }
  const repo = mainCheckout(resolve(repoFlag.at(-1)))
  const t0 = Date.now()
  const staged = spawnSync('git', ['-C', repo, 'diff', '--cached', '--name-only', '-z'], { timeout: 20_000, windowsHide: true })
  const t1 = Date.now()
  const files = staged.status === 0 ? staged.stdout.toString('utf8').split('\0').filter(Boolean).map(toPosix) : []
  if (!files.length) {
    log(`checkpoint skip repo=${repo} (暂存区为空或 diff 失败 exit=${staged.status})`)
    process.exitCode = staged.status === 0 ? 0 : 1
    return
  }
  const payload = {
    type: 'ai_agent',
    repo_working_dir: toPosix(repo),
    agent_name: 'ai-attr',
    model: 'trae-cn/deepseek-v4.1-flash',
    conversation_id: `ai-attr-${Date.now().toString(36)}-${process.pid}`,
    edited_filepaths: files,
    transcript: { messages: [{ type: 'user', text: 'ai-attr: commit declared as AI-authored', timestamp: new Date().toISOString() }] },
  }
  const humanPayload = { type: 'human', repo_working_dir: toPosix(repo), will_edit_filepaths: files }
  // daemon 可能已死（租约过期会自停，第六轮实测 5 分钟无心跳即 drain 后 shutdown）。
  // 不 ensure 的话连接直接被拒、请求静默丢失——提交照样成功但结算拿不到 checkpoint。
  await ensureDaemon()
  // daemon 受理日志：投递完成的客观信号。轮询它（而非傻等固定秒数）决定何时
  // 放行提交——git 在 hook 返回后 <1s 就创建提交，客户端受理要 8~16s，等固定
  // 秒数永远在赌运气（第三、四轮输：提交先于受理创建 → 结算 attestations=0）。
  const daemonHome = loadConfig().daemonHome ?? join(CONFIG_DIR, 'daemon')
  const logDir = join(daemonHome, 'internal', 'daemon', 'logs')
  // daemon 启动时打开的日志文件名 = 启动日期，跨天不滚动（生产 daemon 11-23 启动，
  // 11-24 的 saved 行仍写在 11-23 文件里）——按当天日期猜文件名永远找不到，必须
  // 每轮挑"最新被修改"的 git-ai-daemon-*.log。
  const pickLogFile = () => {
    try {
      let best = null, bestM = -1
      for (const f of readdirSync(logDir)) {
        if (!f.startsWith('git-ai-daemon-') || !f.endsWith('.log')) continue
        const m = statSync(join(logDir, f)).mtimeMs
        if (m > bestM) { bestM = m; best = join(logDir, f) }
      }
      return best
    } catch { return null }
  }
  const fileOffsets = new Map()
  const readNew = () => {
    const f = pickLogFile()
    if (!f) return ''
    let off = fileOffsets.get(f) ?? 0 // 首次见到该文件从头读；base 唯一，旧行不会误匹配
    try {
      const size = statSync(f).size
      if (size < off) off = 0
      if (size > off) { const chunk = readFileSync(f).subarray(off).toString('utf8'); fileOffsets.set(f, size); return chunk }
      fileOffsets.set(f, off)
      return ''
    } catch { return '' }
  }
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  try {
    const daemon = makeDaemon()
    const env = { ...process.env, ...daemon.environment(), GIT_AI_NOTES_REF: 'refs/notes/ai-tob' }
    const t2 = Date.now()
    // 客户端 10 秒被杀无妨：请求已投递（stdin 写完即送达），daemon 异步处理
    // （单个 save ~15-20 秒）。真正的放行条件在下面的 saved 轮询。
    const human = spawnSync(daemon.binary, ['checkpoint', 'agent-v1', '--hook-input', 'stdin'], {
      input: JSON.stringify(humanPayload), env, cwd: repo, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    })
    const sent = spawnSync(daemon.binary, ['checkpoint', 'agent-v1', '--hook-input', 'stdin'], {
      input: JSON.stringify(payload), env, cwd: repo, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    })
    const t3 = Date.now()
    log(`checkpoint sent repo=${repo} files=${files.length} human_exit=${human.status} ai_exit=${sent.status} stages start->diff=${t1 - t0}ms ->env=${t2 - t1}ms ->client=${t3 - t2}ms${sent.stderr ? ` err=${sent.stderr.trim().slice(0, 200)}` : ''}`)
    // 等 `checkpoint: saved … kind=AiAgent` 才放行提交——git 在 hook 返回后 <1s
    // 创建提交，而保存要再花 15~20 秒；保存晚于提交则结算 attestations=0（生产
    // dc7b0db 实测晚 14.7 秒 → att=0）。注意：saved 行不含 repo 路径，只有
    // `base=<父提交前7位>`——pre-commit 时的 HEAD 就是 daemon 要记的 base，按它匹配。
    const headSha = (() => {
      try { return spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? '' } catch { return '' }
    })()
    const wantBase = headSha ? `base=${headSha.slice(0, 7)}` : null
    const deadline = Date.now() + 75_000
    let confirmed = false
    while (!confirmed && Date.now() < deadline) {
      const chunk = readNew()
      if (chunk) for (const line of chunk.split('\n')) {
        if (line.includes('checkpoint: saved') && line.includes('kind=AiAgent') && (!wantBase || line.includes(wantBase))) { confirmed = true; break }
      }
      if (!confirmed) sleepSync(400)
    }
    log(`checkpoint ${confirmed ? 'saved' : 'SAVE-TIMEOUT'} repo=${repo} ${wantBase ?? ''} saved-after=${Date.now() - t3}ms`)
  } catch (e) {
    log(`checkpoint send failed repo=${repo}: ${e.message}`)
  }
  // 不在这里做 register（bootstrap-sync 单次要 ~9 秒）：init 与 serve 的心跳
  // 已经维持注册；实验也证明结算与上报不依赖提交时刻的租约刷新。
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
  if (flags.daemon === true) {
    // 后台常驻：另起一个 detached 进程跑真正的 serve，本进程立即退出（开机自启/计划任务用）
    const port = Number(flags.port ?? loadConfig().port ?? DEFAULT_PORT)
    const logFd = openSync(LOG_PATH, 'a')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: process.cwd(),
    })
    child.unref()
    closeSync(logFd)
    console.log(`看板已在后台启动 pid=${child.pid}  http://127.0.0.1:${port}  日志=${LOG_PATH}`)
    return
  }
  const cfg = loadConfig()
  const port = Number(flags.port ?? cfg.port ?? DEFAULT_PORT)
  const cache = new Map()
  const inflight = new Map() // key -> Promise：同 key 只算一次，杜绝并发重复 collect

  let listCache = null
  const reposNow = () => {
    if (listCache && Date.now() - listCache.at < 60_000) return listCache.data
    const current = loadConfig()
    const data = buildRepoList({ extra: current.extraRepos ?? [], roots: current.repoRoots ?? [] })
    listCache = { at: Date.now(), data }
    return data
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  // stale-while-revalidate：命中期内直接回；过半期/强制时后台重算但先回旧数据；未命中等首算
  const cached = async (key, forced, compute) => {
    const hit = cache.get(key)
    const age = hit ? Date.now() - hit.at : Number.POSITIVE_INFINITY
    if (hit && age < CACHE_TTL_MS && !forced) return hit.data
    if (!inflight.has(key)) {
      const pending = Promise.resolve()
        .then(compute)
        .then(data => {
          cache.set(key, { at: Date.now(), data })
          return data
        })
        .catch(e => {
          log(`collect failed key=${key}: ${e.message}`)
          return null
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    if (hit) return hit.data // stale：立即回旧数据，后台已在刷新
    const data = await inflight.get(key)
    if (data == null) throw new Error('查询失败，详见 ai-attr.log')
    return data
  }

  // 全部项目合计：分批并行 collect 每个仓库，按同时间窗求和
  const computeTotal = (since, until, all) => async () => {
    const list = reposNow()
    const results = []
    const CONCURRENCY = 6
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const chunk = list.slice(i, i + CONCURRENCY)
      const done = await Promise.all(chunk.map(r => collect(r.path, { since, until, all })
        .catch(e => { log(`total collect failed repo=${r.path}: ${e.message}`); return null })))
      results.push(...done)
    }
    let ai = 0
    let added = 0
    let commits = 0
    const per = []
    for (let i = 0; i < list.length; i++) {
      const d = results[i]
      if (!d) continue
      ai += d.totals.ai_lines
      added += d.totals.added_lines
      commits += d.commits.length
      if (d.commits.length) {
        per.push({ label: list[i].label, path: list[i].path, ai_lines: d.totals.ai_lines, added_lines: d.totals.added_lines, commits: d.commits.length })
      }
    }
    per.sort((a, b) => b.added_lines - a.added_lines)
    return {
      generated: new Date().toISOString(),
      since: since ?? null,
      until: until ?? null,
      repo_count: list.length,
      totals: {
        ai_lines: ai,
        added_lines: added,
        commit_count: commits,
        rate: added ? Math.round(ai * 1000 / added) / 10 : null,
      },
      repos: per,
    }
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
      const since = q.get('since') ?? undefined
      const until = q.get('until') ?? undefined
      const all = q.get('all') === '1'
      const forced = q.get('refresh') === '1'
      if (q.get('total')) {
        const data = await cached(`total|${since ?? ''}|${until ?? ''}|${all}`, forced, computeTotal(since, until, all))
        json(res, 200, data)
        return
      }
      const repos = reposNow()
      const repo = q.get('repo') ?? repos[0]?.path
      if (!repo) {
        json(res, 400, { error: '还没有仓库：先运行 ai-attr init --root <目录>' })
        return
      }
      const key = `${repo}|${since ?? ''}|${until ?? ''}|${all}`
      const data = await cached(key, forced, () => collect(repo, { since, until, all }))
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
    const main = mainCheckout(r.path)
    const installed = ['pre-commit', 'post-commit'].every((kind) => {
      const f = hookPathOf(main, kind)
      return existsSync(f) && readFileSync(f, 'utf8').includes(BEGIN)
    })
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
      写配置、安装 pre-commit + post-commit hook、启动 daemon 并注册仓库
  ai-attr checkpoint --repo <仓库>
      把暂存区改动声明为 AI 编辑（pre-commit hook 调用）
  ai-attr attribute --repo <仓库> [--sha <sha>]
      归因单个提交（post-commit hook 兜底调用）
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
    case 'checkpoint':
      await cmdCheckpoint(flags)
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
