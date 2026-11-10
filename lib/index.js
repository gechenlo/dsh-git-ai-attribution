/**
 * Attributes DSH's own file edits to TRAE's AI contribution report.
 *
 * For each successful `write` / `edit` tool call the plugin sends a human
 * checkpoint before the mutation and an AI checkpoint afterwards, using a
 * DSH-owned git-ai daemon. Commits then settle into `refs/notes/ai-tob`, which
 * TRAE reads, and the daemon reports the commit metrics to the enterprise
 * backend using TRAE's own login credentials.
 *
 * Only observed DSH writes count: shell commands, background jobs and files
 * edited before the plugin loaded are never attributed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createDaemonManager } from './daemon.js'
import { findTraeBundle, readDataFinderConfig, readIdentity } from './credentials.js'

export const name = 'git-ai-attribution'
export const inject = ['sessions', 'tools']

const DEFAULTS = {
  notesRef: 'refs/notes/ai-tob',
  agentName: 'dsh',
  commitLimit: 200,
  cacheTtlMs: 30_000,
  heartbeatMs: 60_000,
  repoRoots: [],
}

/** DSH home, honouring the environment when present. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** TRAE tenant directory holding the runtime reporting config. */
function tenantDir() {
  const root = join(process.env.USERPROFILE ?? homedir(), '.trae-cn', '.git-ai-tob')
  if (!existsSync(root)) return undefined
  const tenants = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(entry => entry.name)
  return tenants.length > 0 ? join(root, tenants[0]) : undefined
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 * @param {boolean} [config.enabled] - Turn attribution on or off.
 * @param {string} [config.traeBundlePath] - TRAE `main.js`; auto-detected.
 * @param {string} [config.traeStoragePath] - TRAE `storage.json`; auto-detected.
 * @param {string} [config.gitAiBinaryPath] - `git-ai.exe`; newest install is used by default.
 * @param {string} [config.daemonHome] - Daemon working directory; defaults under the DSH home.
 * @param {string} [config.agentName] - Authorship tool name recorded in Git notes.
 * @param {number} [config.commitLimit] - Commits shown in the tab.
 * @param {string[]} [config.repoRoots] - Extra directories whose child repositories
 *   the picker should list; repositories DSH touches are always included.
 * @param {string} [config.logPath] - Diagnostic log path.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const settings = { ...DEFAULTS, ...config }
  const logPath = settings.logPath ?? join(dshHome(), 'git-ai-attribution.log')
  const trace = (message) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {
      // Diagnostics must never affect attribution.
    }
  }

  const identity = readIdentity(tenantDir())
  const daemonHome = settings.daemonHome ?? join(dshHome(), 'git-ai-daemon')
  const credentials = () => {
    const local = readDataFinderConfig({
      traeBundlePath: settings.traeBundlePath,
      traeStoragePath: settings.traeStoragePath,
    })
    return {
      appKey: local.appKey,
      appId: local.appId ?? identity.appId,
      channelDomain: local.channelDomain ?? identity.channelDomain,
      proxyDomain: identity.proxyDomain,
      configPath: identity.configPath,
    }
  }

  let daemon
  try {
    daemon = createDaemonManager({ daemonHome, binaryPath: settings.gitAiBinaryPath, credentials, trace })
  } catch (error) {
    trace(`daemon unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  trace(`plugin loaded pid=${process.pid} dsh_home=${dshHome()}`)

  const notesRef = settings.notesRef
  const cache = new Map()
  /** Repositories this instance has actually seen, used by the repo picker. */
  const knownRepos = new Set()
  let lastRepo

  /** @type {Map<string, Promise<unknown>>} */
  const chains = new Map()
  const enqueue = (repo, task) => {
    const previous = chains.get(repo) ?? Promise.resolve()
    const next = previous.then(task, task).catch(() => undefined)
    chains.set(repo, next)
    void next.finally(() => {
      if (chains.get(repo) === next) chains.delete(repo)
    })
    return next
  }

  const heartbeat = setInterval(() => { void daemon.heartbeat() }, settings.heartbeatMs)
  heartbeat.unref?.()
  ctx.effect?.(() => () => clearInterval(heartbeat))
  setTimeout(() => { void daemon.ensureStarted().catch(() => undefined) }, 1_500).unref?.()

  /** Whether a directory is a usable Git work tree (`^` HEAD distinguishes real repos). */
  function isRepo(dir) {
    const dotGit = join(dir, '.git')
    if (!existsSync(dotGit)) return false
    try {
      if (statSync(dotGit).isFile()) return true
      return existsSync(join(dotGit, 'HEAD'))
    } catch {
      return false
    }
  }

  /** Nearest repository containing a file, bounded by the session directory. */
  function repoForFile(file, cwd) {
    const root = resolve(cwd).toLowerCase()
    let current = dirname(file)
    while (current.toLowerCase() === root || current.toLowerCase().startsWith(root + sep)) {
      if (isRepo(current)) return current
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return undefined
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return
    const cwd = session?.header?.cwd
    if (cwd && isRepo(cwd)) {
      lastRepo = cwd
      knownRepos.add(cwd)
    }
  })

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'write' && exec.name !== 'edit') return next()
    const session = exec.agent?.session
    const cwd = session?.header?.cwd
    const argument = exec.arguments?.file_path
    if (!cwd || typeof argument !== 'string' || !argument) return next()
    const file = isAbsolute(argument) ? resolve(argument) : resolve(cwd, argument)
    const repo = repoForFile(file, cwd)
    if (!repo) return next()
    const relFile = relative(repo, file).replace(/\\/g, '/')
    if (!relFile || relFile.startsWith('../')) return next()
    lastRepo = repo
    knownRepos.add(repo)

    const ready = await daemon.register(repo).catch(() => false)
    if (!ready) {
      trace(`skip attribution: daemon unavailable repo=${repo}`)
      return next()
    }
    // The CLI may report a client timeout after the daemon saved the result,
    // so its exit code is not a gate; the recorded outcome is verified below.
    await enqueue(repo, () => checkpoint(repo, { type: 'human', repo_working_dir: toPosix(repo), will_edit_filepaths: [relFile] }))
    const result = await next()
    if (result.isError || result.value?.before === result.value?.after) return result
    if (typeof result.value?.after !== 'string') return result
    await enqueue(repo, () => checkpoint(repo, {
      type: 'ai_agent',
      repo_working_dir: toPosix(repo),
      agent_name: settings.agentName,
      model: resolveModel(session),
      conversation_id: String(session.id),
      edited_filepaths: [relFile],
      transcript: { messages: [{ type: 'user', text: 'dsh turn', timestamp: new Date().toISOString() }] },
    }))
    const recorded = await recordedAiLines(repo)
    trace(`attribution ${recorded > 0 ? 'recorded' : 'unconfirmed'} repo=${repo} file=${relFile} ai_lines=${recorded}`)
    return result
  })

  function checkpoint(repo, payload) {
    return run(daemon.binary, ['checkpoint', 'agent-v1', '--hook-input', 'stdin'], {
      cwd: repo,
      env: { ...daemon.environment(), GIT_AI_NOTES_REF: notesRef },
      input: JSON.stringify(payload),
      timeoutMs: 120_000,
    })
  }

  async function recordedAiLines(repo) {
    const result = await run(daemon.binary, ['status', '--json'], {
      cwd: repo,
      env: daemon.environment(),
      timeoutMs: 60_000,
    })
    if (result.code !== 0) return 0
    try {
      const value = JSON.parse(result.stdout)?.stats?.ai_additions
      return typeof value === 'number' && value > 0 ? value : 0
    } catch {
      return 0
    }
  }

  // ---- Dashboard data ----

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: '/git-ai-attribution.json',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const reply = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        try {
          if (url.searchParams.get('list') === '1') {
            const repos = listRepos()
            const preferred = lastRepo ?? settings.defaultRepo
            const current = preferred ? mainCheckout(preferred) : repos[0]?.path ?? ''
            reply(200, { repos, current: repos.some(item => item.path.toLowerCase() === current.toLowerCase()) ? current : repos[0]?.path ?? '' })
            return
          }
          const repo = url.searchParams.get('repo') ?? lastRepo
          if (!repo) {
            reply(400, { error: '尚未在任何 Git 仓库中工作' })
            return
          }
          const since = url.searchParams.get('since') ?? undefined
          const until = url.searchParams.get('until') ?? undefined
          const all = url.searchParams.get('all') === '1'
          const key = [repo, since ?? '', until ?? '', all ? 'all' : ''].join('|')
          const cached = cache.get(key)
          const fresh = cached && Date.now() - cached.at < settings.cacheTtlMs
          if (fresh && url.searchParams.get('refresh') !== '1') {
            reply(200, cached.payload)
            return
          }
          const payload = await collect(repo, since, until, all)
          cache.set(key, { at: Date.now(), payload })
          reply(200, payload)
        } catch (error) {
          trace(`dashboard query failed: ${error instanceof Error ? error.message : String(error)}`)
          reply(500, { error: '读取归因数据失败' })
        }
      },
    }), 'git-ai-attribution: dashboard route')
  })

  function listRepos() {
    // Repositories this DSH instance actually touched come first: they are the
    // only ones guaranteed to be relevant and correctly located.
    const roots = [...knownRepos]
    if (lastRepo) roots.unshift(lastRepo)
    for (const root of settings.repoRoots) {
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const candidate = join(root, entry.name)
        if (isRepo(candidate)) {
          roots.push(candidate)
          continue
        }
        // Containers such as `_cli-worktrees` hold linked worktrees one level
        // deeper; their `.git` is a file, which `isRepo` already accepts.
        let nested = []
        try {
          nested = readdirSync(candidate, { withFileTypes: true })
        } catch {
          continue
        }
        for (const child of nested) {
          if (!child.isDirectory() || child.name.startsWith('.')) continue
          const worktree = join(candidate, child.name)
          if (isRepo(worktree)) roots.push(worktree)
        }
      }
    }
    // One entry per project: a worktree and its main checkout share a Git
    // directory, so they are grouped under the main checkout.
    const projects = new Map()
    // Git's --git-common-dir may use `/` while directory discovery returns
    // `\` on Windows; canonicalize before grouping and counting worktrees.
    const uniquePaths = new Map(roots.map(path => [resolve(path).toLowerCase(), resolve(path)]))
    for (const path of uniquePaths.values()) {
      const main = mainCheckout(path)
      const key = main.toLowerCase()
      const entry = projects.get(key) ?? { path: main, label: repoLabel(main), worktrees: 0 }
      if (isWorktree(path) && path.toLowerCase() !== key) entry.worktrees += 1
      projects.set(key, entry)
    }
    return [...projects.values()].map(entry => ({
      ...entry,
      label: entry.worktrees > 0 ? `${entry.label} (+${entry.worktrees} worktree)` : entry.label,
      all: entry.worktrees > 0,
    }))
  }

  /** Whether a working directory is a linked worktree (`.git` is a file). */
  function isWorktree(path) {
    try {
      return statSync(join(path, '.git')).isFile()
    } catch {
      return false
    }
  }

  /**
   * Main checkout owning a worktree's object store. Worktrees share one Git
   * directory, so their branches live in the same repository.
   */
  function mainCheckout(path) {
    if (!isWorktree(path)) return resolve(path)
    const result = runSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const common = result.code === 0 ? result.stdout.trim() : ''
    if (!common) return resolve(path)
    // `<repo>/.git` → `<repo>`. resolve() normalizes slash spelling, so the
    // main checkout and linked worktrees share exactly one picker value.
    return common.endsWith('.git') ? resolve(dirname(common)) : resolve(path)
  }

  /**
   * Display name for the picker: a linked worktree and its main checkout share
   * a directory name, so worktrees are marked explicitly.
   */
  function repoLabel(path) {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    return isWorktree(path) ? `${name} (worktree)` : name
  }

  async function collect(repo, since, until, all = false) {
    const args = ['-C', repo, 'log', `-n${settings.commitLimit}`, '--format=%H%x1f%an%x1f%ct%x1f%s', '--numstat']
    if (all) {
      // Worktree commits sit on their own branches, so the project view spans
      // every branch — narrowed to this user's commits, because a merged view
      // would otherwise pull in colleagues' history.
      args.push('--all')
      const email = runSync('git', ['-C', repo, 'config', 'user.email']).stdout.trim()
      if (email) args.push(`--author=${email}`)
    }
    if (since) args.push(`--since=${since} 00:00:00`)
    if (until) args.push(`--until=${until} 23:59:59`)
    const log = await run('git', args, { timeoutMs: 60_000 })
    if (log.code !== 0) throw new Error('git log failed')
    const notes = await readNotes(repo)
    const commits = []
    let current
    for (const line of log.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (line.includes('\x1f')) {
        const [sha, author, timestamp, subject] = line.split('\x1f')
        current = { sha, author, timestamp: Number(timestamp), subject, added: 0, ai: 0, models: [], hasNote: false }
        commits.push(current)
        continue
      }
      const parts = line.split('\t')
      if (current && parts.length === 3 && /^\d+$/.test(parts[0])) current.added += Number(parts[0])
    }
    for (const commit of commits) {
      const note = notes.get(commit.sha)
      if (!note) continue
      const parsed = parseNote(note)
      commit.ai = parsed.ai
      commit.models = parsed.models
      commit.hasNote = parsed.hasNote
    }
    return {
      repo,
      generated: new Date().toISOString(),
      since: since ?? null,
      until: until ?? null,
      totals: {
        ai_lines: commits.reduce((sum, item) => sum + item.ai, 0),
        added_lines: commits.reduce((sum, item) => sum + item.added, 0),
      },
      commits: commits.map(item => ({
        sha: item.sha,
        short: item.sha.slice(0, 8),
        time: new Date(item.timestamp * 1000).toISOString().slice(5, 16).replace('T', ' '),
        subject: item.subject,
        ai_lines: item.ai,
        added_lines: item.added,
        rate: item.added > 0 ? Math.round((item.ai * 1000) / item.added) / 10 : null,
        models: item.models,
        has_note: item.hasNote,
      })),
    }
  }

  async function readNotes(repo) {
    const listing = await run('git', ['-C', repo, 'notes', `--ref=${notesRef}`, 'list'], { timeoutMs: 60_000 })
    if (listing.code !== 0) return new Map()
    const pairs = listing.stdout.split(/\r?\n/).filter(Boolean)
      .map(line => line.trim().split(/\s+/))
      .filter(parts => parts.length === 2)
    if (pairs.length === 0) return new Map()
    const batch = await runBuffer('git', ['-C', repo, 'cat-file', '--batch'], {
      input: pairs.map(([blob]) => blob).join('\n') + '\n',
      timeoutMs: 60_000,
    })
    const result = new Map()
    let offset = 0
    for (const [blob, commit] of pairs) {
      const headerEnd = batch.indexOf(0x0a, offset)
      if (headerEnd < 0) break
      const header = batch.subarray(offset, headerEnd).toString('utf8')
      if (!header.startsWith(blob)) break
      const size = Number(header.split(' ')[2])
      if (!Number.isFinite(size)) break
      const bodyStart = headerEnd + 1
      result.set(commit, batch.subarray(bodyStart, bodyStart + size).toString('utf8'))
      offset = bodyStart + size + 1
    }
    return result
  }

  function parseNote(note) {
    const [text, json] = note.split('\n---')
    let ai = 0
    for (const line of (text ?? '').split('\n')) {
      const match = line.trim().match(/^\S+\s+([\d,\-\s]+)$/)
      if (!match) continue
      for (const chunk of match[1].replace(/\s/g, '').split(',')) {
        if (!chunk) continue
        if (chunk.includes('-')) {
          const [start, end] = chunk.split('-').map(Number)
          if (Number.isFinite(start) && Number.isFinite(end)) ai += Math.max(0, end - start + 1)
        } else if (/^\d+$/.test(chunk)) ai += 1
      }
    }
    let models = []
    try {
      const meta = JSON.parse(json ?? '{}')
      models = [...new Set(Object.values(meta.sessions ?? {})
        .map(session => session?.agent_id?.model)
        .filter(model => typeof model === 'string'))]
    } catch {
      // A note without metadata still contributes its line ranges.
    }
    return { ai, models, hasNote: Boolean((text ?? '').trim() || (json ?? '').trim()) }
  }
}

function toPosix(path) {
  return String(path).replace(/\\/g, '/')
}

function resolveModel(session) {
  try {
    const model = session?.requestHeader?.()?.config?.model
    return typeof model === 'string' && model ? model : 'dsh'
  } catch {
    return 'dsh'
  }
}

/** Runs one child process, optionally feeding stdin. */
function run(command, args, options) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ code: null, stdout: '', stderr: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* Already gone. */ }
      finish(null)
    }, options.timeoutMs ?? 60_000)
    timer.unref?.()
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', () => finish(null))
    child.on('close', code => finish(code))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.input ?? '')
  })
}

/** Runs one short git command synchronously, for path resolution. */
function runSync(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    return { code: result.status ?? 1, stdout: result.stdout ?? '' }
  } catch {
    return { code: 1, stdout: '' }
  }
}

/** Runs one child process and returns raw stdout bytes, for `cat-file --batch`. */
function runBuffer(command, args, options) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true })
    } catch {
      resolve(Buffer.alloc(0))
      return
    }
    const chunks = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* Already gone. */ }
      finish()
    }, options.timeoutMs ?? 60_000)
    timer.unref?.()
    child.stdout?.on('data', chunk => chunks.push(chunk))
    child.on('error', finish)
    child.on('close', finish)
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.input ?? '')
  })
}

export { findTraeBundle }
