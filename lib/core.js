/**
 * Shared git plumbing for the ai-attr CLI: process helpers, repository
 * discovery, Git-notes reading, the commit query behind the dashboard, and
 * the TRAE credential assembly the reporting daemon needs.
 *
 * Extracted from the DSH plugin (lib/index.js) so the standalone program and
 * the plugin agree on what an attributed commit looks like. No DSH APIs here.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readDataFinderConfig, readIdentity } from './credentials.js'

/** Notes ref TRAE reads for the AI contribution report. */
export const NOTES_REF = 'refs/notes/ai-tob'

// ---- Process helpers ----

/** Runs one child process, optionally feeding stdin. */
export function run(command, args, options = {}) {
  return new Promise(resolvePromise => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      resolvePromise({ code: null, stdout: '', stderr: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
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
export function runSync(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    return { code: result.status ?? 1, stdout: result.stdout ?? '' }
  } catch {
    return { code: 1, stdout: '' }
  }
}

/** Runs one child process and returns raw stdout bytes, for `cat-file --batch`. */
export function runBuffer(command, args, options = {}) {
  return new Promise(resolvePromise => {
    let child
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true })
    } catch {
      resolvePromise(Buffer.alloc(0))
      return
    }
    const chunks = []
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(Buffer.concat(chunks))
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

// ---- Repository discovery ----

/** Whether a directory is a usable Git work tree (`.git` file = linked worktree). */
export function isRepo(dir) {
  const dotGit = join(dir, '.git')
  if (!existsSync(dotGit)) return false
  try {
    if (statSync(dotGit).isFile()) return true
    return existsSync(join(dotGit, 'HEAD'))
  } catch {
    return false
  }
}

/**
 * Nearest repository containing a file.
 *
 * Walks to the filesystem root rather than stopping at a session cwd:
 * sessions routinely edit files outside their own directory, and bounding
 * the walk silently dropped those edits — that is what zeroed out whole days
 * of attribution.
 */
export function repoForFile(file) {
  let current = dirname(file)
  for (;;) {
    if (isRepo(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Whether a working directory is a linked worktree (`.git` is a file). */
export function isWorktree(path) {
  try {
    return statSync(join(path, '.git')).isFile()
  } catch {
    return false
  }
}

/** Worktree → main checkout, resolved once because each answer costs a spawn. */
const mainCache = new Map()

/**
 * Main checkout owning a worktree's object store. Worktrees share one Git
 * directory, so their branches live in the same repository.
 */
export function mainCheckout(path) {
  const resolved = resolve(path)
  const key = resolved.toLowerCase()
  const memo = mainCache.get(key)
  if (memo) return memo
  let answer = resolved
  if (isWorktree(resolved)) {
    const result = runSync('git', ['-C', resolved, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const common = result.code === 0 ? result.stdout.trim() : ''
    // `<repo>/.git` → `<repo>`. resolve() normalizes slash spelling, so the
    // main checkout and linked worktrees share exactly one picker value.
    if (common) answer = common.endsWith('.git') ? resolve(dirname(common)) : resolved
  }
  mainCache.set(key, answer)
  return answer
}

/**
 * Display name for the picker: a linked worktree and its main checkout share
 * a directory name, so worktrees are marked explicitly.
 */
export function repoLabel(path) {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  return isWorktree(path) ? `${name} (worktree)` : name
}

/** Every checkout (main + linked worktrees) sharing one repository. */
const worktreeCache = new Map()
export function checkoutsOf(repo) {
  const main = mainCheckout(repo)
  const key = main.toLowerCase()
  const memo = worktreeCache.get(key)
  if (memo) return memo
  let list = [main]
  try {
    const result = runSync('git', ['-C', main, 'worktree', 'list', '--porcelain'])
    if (result.code === 0) {
      const paths = result.stdout
        .split('\n')
        .filter(line => line.startsWith('worktree '))
        .map(line => resolve(line.slice('worktree '.length).trim()))
        .filter(Boolean)
      if (paths.length) list = [...new Set(paths)]
    }
  } catch {
    // A single checkout is the normal case; the list command is only a lookup.
  }
  // Keep the checkout the edit actually happened in first: callers mirror the
  // remaining ones in the background and must not reorder the primary path.
  const ordered = [repo, ...list.filter(p => p.toLowerCase() !== repo.toLowerCase())]
  worktreeCache.set(key, ordered)
  return ordered
}

/**
 * Repositories shown in the picker, one entry per project: a worktree and its
 * main checkout share a Git directory, so they are grouped under the main
 * checkout. `extra` holds paths already known to be relevant (they come
 * first); `roots` are directories scanned for child repositories.
 */
export function buildRepoList({ extra = [], roots = [] } = {}) {
  const discovered = [...extra]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const candidate = join(root, entry.name)
      if (isRepo(candidate)) {
        discovered.push(candidate)
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
        if (isWorktree(worktree) || isRepo(worktree)) discovered.push(worktree)
      }
    }
  }
  const projects = new Map()
  // Git's --git-common-dir may use `/` while directory discovery returns
  // `\` on Windows; canonicalize before grouping and counting worktrees.
  const uniquePaths = new Map(discovered.map(path => [resolve(path).toLowerCase(), resolve(path)]))
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

/** `user.email` never changes mid-session; each lookup costs a spawn. */
const emailCache = new Map()
export async function userEmail(repo) {
  if (emailCache.has(repo)) return emailCache.get(repo)
  // Async on purpose: a spawnSync here would block the event loop, and 21
  // parallel collects then starve their own git children's stdout pipes —
  // big outputs hit the 60s timeout and collect throws "git log failed".
  const result = await run('git', ['-C', repo, 'config', 'user.email'], { timeoutMs: 20_000 })
  const email = (result.stdout ?? '').trim()
  emailCache.set(repo, email)
  return email
}

// ---- Git notes ----

/** All notes under `notesRef`, keyed by commit sha. */
export async function readNotes(repo, notesRef = NOTES_REF) {
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

/** Line ranges claimed by a note, plus the models recorded in its metadata. */
export function parseNote(note) {
  const [text, json] = note.split('\n---')
  // Ranges are unioned per file: a daemon checkpoint and a backfill can both
  // claim the same lines (settlement runs after the hook), and summing both
  // would double-count a line into ai_lines beyond the commit's added lines.
  const byFile = new Map()
  let current = ''
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    const entry = line.match(/^\s+\S+\s+([\d,\-\s]+)$/)
    if (entry) {
      if (!byFile.has(current)) byFile.set(current, [])
      for (const chunk of entry[1].replace(/\s/g, '').split(',')) {
        if (!chunk) continue
        if (chunk.includes('-')) {
          const [start, end] = chunk.split('-').map(Number)
          if (Number.isFinite(start) && Number.isFinite(end) && end >= start) byFile.get(current).push([start, end])
        } else if (/^\d+$/.test(chunk)) {
          const n = Number(chunk)
          byFile.get(current).push([n, n])
        }
      }
      continue
    }
    current = line.trim() // 文件路径行
  }
  let ai = 0
  for (const intervals of byFile.values()) {
    if (!intervals.length) continue
    intervals.sort((a, b) => a[0] - b[0])
    let start = intervals[0][0]
    let end = intervals[0][1]
    for (let i = 1; i < intervals.length; i++) {
      const [s2, e2] = intervals[i]
      if (s2 <= end + 1) {
        if (e2 > end) end = e2
      } else {
        ai += end - start + 1
        start = s2
        end = e2
      }
    }
    ai += end - start + 1
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

// ---- Dashboard query ----

/**
 * Recent commits of `repo` with their AI line counts, for the dashboard.
 * `all` spans every branch (worktrees commit on their own branches), narrowed
 * to the configured author so colleagues' history stays out of the view.
 */
export async function collect(repo, options = {}) {
  const { since, until, all = false, commitLimit = 200, notesRef = NOTES_REF } = options
  const args = ['-C', repo, 'log', `-n${commitLimit}`, '--format=%H%x1f%an%x1f%ct%x1f%s', '--numstat', '--no-renames']
  if (all) {
    // `--all` also walks notes refs: every `git notes add` creates a commit
    // there ("Notes added by 'git notes add'"), so a backfill floods the
    // newest-commits window with note blobs instead of code — exclude them.
    // Must precede `--all` (git applies exclusions to subsequent ref globs).
    args.push('--exclude=refs/notes/*')
    args.push('--all')
    const email = await userEmail(repo)
    if (email) args.push(`--author=${email}`)
  }
  if (since) args.push(`--since=${since} 00:00:00`)
  if (until) args.push(`--until=${until} 23:59:59`)
  // The two reads are independent, and on this host every git spawn costs
  // over a second, so running them together halves the wait.
  const [log, notes] = await Promise.all([
    run('git', args, { timeoutMs: 60_000 }),
    readNotes(repo, notesRef),
  ])
  if (log.code !== 0) throw new Error('git log failed')
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

export function toPosix(path) {
  return String(path).replace(/\\/g, '/')
}

// ---- TRAE credentials for the reporting daemon ----

/** TRAE tenant directory holding the runtime reporting config. */
export function tenantDir() {
  const root = join(process.env.USERPROFILE ?? homedir(), '.trae-cn', '.git-ai-tob')
  if (!existsSync(root)) return undefined
  const tenants = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(entry => entry.name)
  return tenants.length > 0 ? join(root, tenants[0]) : undefined
}

/**
 * Credentials function for `createDaemonManager`: DataFinder app key from the
 * TRAE bundle plus identity fields from the tenant directory. Read lazily so
 * a TRAE upgrade mid-session is picked up on the next daemon (re)start.
 */
export function buildCredentials({ traeBundlePath, traeStoragePath } = {}) {
  const identity = readIdentity(tenantDir())
  return () => {
    const local = readDataFinderConfig({ traeBundlePath, traeStoragePath })
    return {
      appKey: local.appKey,
      appId: local.appId ?? identity.appId,
      channelDomain: local.channelDomain ?? identity.channelDomain,
      proxyDomain: identity.proxyDomain,
      configPath: identity.configPath,
    }
  }
}
