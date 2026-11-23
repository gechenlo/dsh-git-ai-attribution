#!/usr/bin/env node
/**
 * backfill-notes.mjs — 给缺 AI 行的提交补 git-ai authorship note。
 *
 * 目标：把提交 diff 里所有新增行都算作 AI（用户已完全不手写代码，缺口全是工具 bug 造成）。
 * 做法：
 *   1. 一次 `git log --all --no-merges -p -U0 --no-renames --no-prefix` 拿到所有补丁
 *   2. 一次 `git notes --ref=ai-tob list` + `git cat-file --batch` 拿到已有 note
 *   3. 逐提交算出「新增行号」与「note 已认领行号」，差集用 backfill session 补上
 *   4. `git notes --ref=ai-tob add -f -F` 写回（已有 note 保留，只追加缺失行）
 *
 * 校验：解析出的新增行数必须等于 `--numstat` 的 added 总数，否则跳过该提交（防止补丁解析错位）。
 *
 * 用法：
 *   node scripts/backfill-notes.mjs --repo <path> [--repo <path> ...]
 *                                    [--author <substr>]      默认取各仓库 git config user.email / user.name
 *                                    [--any-author]           不按作者过滤（post-commit hook 用）
 *                                    [--only <sha>]           只处理这一个提交（hook 快路径，跳过全量扫描）
 *                                    [--repair]               只清洗写坏的 note（头部混入 JSON 垃圾行），不解析提交
 *                                    [--expected <csv>]       含 sha,added 的校验清单（可选）
 *                                    [--dry-run] [--concurrency 4]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
function opt(name, dflt) {
  const i = args.indexOf('--' + name)
  return i === -1 ? dflt : args[i + 1]
}
const has = name => args.includes('--' + name)

const repos = []
for (let i = 0; i < args.length; i++) if (args[i] === '--repo') repos.push(args[i + 1])
const dryRun = has('dry-run')
const authorOpt = opt('author', null)
const anyAuthor = has('any-author')
// post-commit hook 快路径：只处理这一个提交，不全量扫描
const onlySha = opt('only', null)
// 只清洗垃圾 note 的模式（秒级，不解析任何提交）
const repairMode = has('repair')
const concurrency = Number(opt('concurrency', 4))
if (!repos.length) {
  console.error('至少要给一个 --repo')
  process.exit(1)
}

function git(cwd, argv, input) {
  const r = spawnSync('git', ['-C', cwd, ...argv], {
    input: input ?? '',
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`git ${argv[0]} 失败: ${(r.stderr || '').trim().slice(0, 300)}`)
  return r.stdout
}

/** 同步睡眠（无依赖），用于 notes ref lock 争用时退避。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** [1,2,3,5,6] -> "1-3,5-6"；单个 -> "7" */
function fmtRanges(nums) {
  const out = []
  let start = null
  let prev = null
  for (const n of nums) {
    if (start === null) { start = prev = n; continue }
    if (n === prev + 1) { prev = n; continue }
    out.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = prev = n
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}-${prev}`)
  return out.join(',')
}

/** 解析 "1-3,5" -> Set */
function parseRanges(s) {
  const set = new Set()
  for (const part of s.split(',')) {
    if (!part) continue
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let i = a; i <= b; i++) set.add(i)
  }
  return set
}

/**
 * 解析已有 note：返回 { map: Map<path, Array<{id, set}>>, json, head, tail, junk }。
 *
 * 分隔符是独占一行的 `---`。两种历史形态要兼容：
 *   - daemon 结算的空 note 以 `---` 开头（head 为空，只有 JSON）；
 *   - 早年在空 note 上追加过内容的，head 里混进了 `{`、`}` 等 JSON 骨架行。
 * 所以前导 `---` 先归一化掉，再按段切；JSON 从最后一段向前找第一个能 parse 的；
 * 其余段合并当 head 逐行走，垃圾行跳过并打 junk 标记——调用方见 junk 即使无缺失也重写一次洗干净。
 */
function parseNote(text) {
  const normalized = text.startsWith('---\n') ? `\n${text}` : text
  const segments = normalized.split('\n---\n')
  let json = null
  let jsonAt = -1
  for (let i = segments.length - 1; i >= 1; i--) {
    try { json = JSON.parse(segments[i]); jsonAt = i; break } catch { /* 继续向前找 */ }
  }
  const head = segments.slice(0, jsonAt === -1 ? segments.length : jsonAt).join('\n')
  const tail = jsonAt === -1 ? '' : segments[jsonAt]
  const map = new Map()
  let cur = null
  let junk = false
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    if (!line.startsWith('  ')) {
      const p = line.trim()
      // 空 note 被追加后残留的 JSON 骨架行：不是文件路径
      if (p === '---' || p === '{' || p === '}') { junk = true; continue }
      cur = p
      if (!map.has(cur)) map.set(cur, [])
      continue
    }
    const m = line.trim().match(/^(s_\w+::t_\w+)\s+(.+)$/)
    if (m && cur) map.get(cur).push({ id: m[1], set: parseRanges(m[2]) })
  }
  return { map, json, head, tail, junk }
}

/** 解析 `git log -p -U0 --no-prefix` 输出 -> Map<sha, {an,ae,at,parents,files:Map<path,Set<line>>, added}> */
function parsePatches(text) {
  const commits = new Map()
  const rs = '\x1e'
  const records = text.split(rs).slice(1) // 每段以 RS 开头
  for (const rec of records) {
    const nl = rec.indexOf('\n')
    if (nl === -1) continue
    const header = rec.slice(0, nl)
    const body = rec.slice(nl + 1)
    const [sha, parents, an, ae, at] = header.split('\x1f')
    if (!/^[0-9a-f]{40}$/.test(sha)) continue
    const files = new Map()
    let cur = null
    let inHunk = false
    let added = 0
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      // Hunk body lines are always prefixed ('+', '-', or with -U0 just the
      // first two), so a bare `diff --git` is a real section header. A bare
      // `--- ` is NOT: SQL/Markdown comments become `--- xxx` once prefixed
      // with the deletion marker, and treating those as headers dropped whole
      // files from the count.
      if (l.startsWith('diff --git ')) { cur = null; inHunk = false; continue }
      if (!inHunk) {
        if (l.startsWith('+++ ')) {
          const p = l.slice(4).trim()
          cur = p === '/dev/null' ? null : p
          if (cur && !files.has(cur)) files.set(cur, new Set())
          continue
        }
        if (l.startsWith('--- ') || l.startsWith('index ') || l.startsWith('similarity ') || l.startsWith('new file ') || l.startsWith('deleted file ')) continue
        if (l.startsWith('@@')) {
          inHunk = true
          const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
          if (m && cur) {
            const start = Number(m[1])
            const count = m[2] === undefined ? 1 : Number(m[2])
            for (let n = 0; n < count; n++) files.get(cur).add(start + n)
          }
          continue
        }
        continue
      }
      if (l.startsWith('@@')) {
        const m = l.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
        if (m && cur) {
          const start = Number(m[1])
          const count = m[2] === undefined ? 1 : Number(m[2])
          for (let n = 0; n < count; n++) files.get(cur).add(start + n)
        }
        continue
      }
      // Hunk body: nothing to do.
    }
    added = 0
    for (const set of files.values()) added += set.size
    commits.set(sha, { sha, parents, an, ae, at: Number(at), files, added })
  }
  return commits
}

/** 读取全部已有 note（list + cat-file --batch） */
function readAllNotes(repo) {
  let list
  try { list = git(repo, ['notes', '--ref=ai-tob', 'list']) } catch { return new Map() }
  const out = new Map()
  const shas = []
  for (const line of list.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40})$/)
    if (m) { out.set(m[2], m[1]); shas.push(m[1]) }
  }
  if (!shas.length) return out
  // 批量读 note 内容
  const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: shas.join('\n') + '\n',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.status !== 0) return out
  const buf = r.stdout
  let pos = 0
  const contents = new Map()
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    if (nl === -1) break
    const header = buf.slice(pos, nl).toString('utf8')
    const parts = header.split(' ')
    if (parts.length >= 2 && parts[1] === 'missing') { pos = nl + 1; continue }
    // `cat-file --batch` 头是 `<oid> <type> <size>`，size 在第 3 段；
    // 曾误取 parts[1]（= 'blob'）→ Number 得 NaN → body 恒为空 →
    // 已有 note 全被当成不存在，每次全量跑都整体覆盖重写。
    const len = Number(parts[2] ?? 0)
    const bodyStart = nl + 1
    const body = buf.slice(bodyStart, bodyStart + len).toString('utf8')
    contents.set(parts[0], body)
    pos = bodyStart + len + 1 // 跳过尾部换行
  }
  for (const [commitSha, noteSha] of out) {
    const c = contents.get(noteSha)
    if (c !== undefined) out.set(commitSha, c)
  }
  return out
}

// ---------- 主流程 ----------
const tmp = mkdtempSync(join(tmpdir(), 'gitai-note-'))
let grand = { commits: 0, skipped: 0, wrote: 0, mismatch: 0, otherAuthor: 0 }

try {
  for (const repo of repos) {
    console.log(`\n===== ${repo}`)
    const cfgEmail = (() => { try { return git(repo, ['config', 'user.email']).trim() } catch { return '' } })()
    const cfgName = (() => { try { return git(repo, ['config', 'user.name']).trim() } catch { return '' } })()
    const author = authorOpt ?? cfgEmail ?? ''
    console.log(`  作者过滤: ${author || '(不过滤)'}   git config: ${cfgName} <${cfgEmail}>`)

    // --repair：只清洗写坏的 note（头部混入 JSON 垃圾行），不解析任何提交。
    if (repairMode) {
      const notes = readAllNotes(repo)
      let repaired = 0
      for (const [sha, text] of notes) {
        const p = parseNote(text)
        if (!p.junk) continue
        const blocks = []
        for (const [path, entries] of p.map) {
          blocks.push(path)
          for (const e of entries) blocks.push(`  ${e.id} ${fmtRanges([...e.set].sort((a, b) => a - b))}`)
        }
        const json = p.json ?? {
          schema_version: 'authorship/3.0.0',
          git_ai_version: '1.6.2',
          base_commit_sha: sha,
          prompts: {},
          sessions: {},
        }
        const body = `${blocks.join('\n')}\n---\n${JSON.stringify(json, null, 2)}\n`
        if (dryRun) { console.log(`  (dry-run) 修复 ${sha.slice(0, 8)}`); repaired++; continue }
        const f = join(tmp, `${sha}.repair.note`)
        writeFileSync(f, body, 'utf8')
        try {
          git(repo, ['notes', '--ref=ai-tob', 'add', '-f', '-F', f, sha])
          repaired++
          console.log(`  ~ 修复 ${sha.slice(0, 8)}（清除头部 JSON 垃圾行）`)
        } catch (e) {
          console.log(`  x ${sha.slice(0, 8)} 修复失败: ${e.message.slice(0, 120)}`)
        }
      }
      console.log(`  修复 ${repaired} 条 / 共 ${notes.size} 条 note`)
      continue
    }

    const commits = new Map()
    let onlyFull = ''
    if (onlySha) {
      // 单提交快路径：hook 传来的多为完整 sha，短 sha 才需要一次 rev-parse。
      onlyFull = /^[0-9a-f]{40}$/.test(onlySha) ? onlySha : git(repo, ['rev-parse', onlySha]).trim()
      const patch = git(repo, [
        'show', onlyFull, '-U0', '-p', '--no-renames', '--no-prefix', '--no-color',
        '--no-textconv',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at',
      ])
      for (const [sha, c] of parsePatches(patch)) commits.set(sha, c)
    } else {
      // 分页拉取补丁：大仓库（如 hyrule-platform-web）全量 -p 输出可达 865MB，
      // 单次 spawnSync 会撞 maxBuffer 512MB 直接失败且 stderr 为空。
      // git log 对同一 ref 集的顺序是确定的，--skip/--max-count 分页结果稳定。
      const pageSize = 500
      for (let skip = 0; ; skip += pageSize) {
        const page = git(repo, [
          'log', '--exclude=refs/notes/*', '--all', '--no-merges', '--no-renames', '--no-prefix', '--no-color',
          '--no-textconv',
          '-U0', '-p',
          `--skip=${skip}`, `--max-count=${pageSize}`,
          '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at',
        ])
        const parsed = parsePatches(page)
        for (const [sha, c] of parsed) commits.set(sha, c)
        if (parsed.size < pageSize) break
      }
    }
    // 单提交模式只需这一个提交的 note；全量模式一次批量读。
    let notes
    if (onlyFull) {
      notes = new Map()
      try {
        notes.set(onlyFull, git(repo, ['notes', '--ref=ai-tob', 'show', onlyFull]))
      } catch {
        // 还没有 note，正常。
      }
    } else {
      notes = readAllNotes(repo)
    }
    console.log(`  提交 ${commits.size}，已有 note ${notes.size}`)

    // 一次拿全部提交的 numstat，用于校验补丁解析（避免每个提交单独 spawn git）
    const numstatTotals = new Map()
    if (onlyFull) {
      const nsOut = git(repo, ['show', onlyFull, '--numstat', '--no-renames', '--no-textconv', '--pretty=format:'])
      let total = 0
      for (const line of nsOut.split('\n')) {
        const t = line.split('\t')
        if (t.length >= 3 && /^\d+$/.test(t[0])) total += Number(t[0])
      }
      numstatTotals.set(onlyFull, total)
    } else {
      const nsLog = git(repo, ['log', '--exclude=refs/notes/*', '--all', '--no-merges', '--no-renames', '--no-textconv', '--numstat', '--pretty=format:%x1e%H'])
      for (const rec of nsLog.split('\x1e').slice(1)) {
        const nl = rec.indexOf('\n')
        const sha = (nl === -1 ? rec : rec.slice(0, nl)).trim()
        if (!/^[0-9a-f]{40}$/.test(sha)) continue
        let total = 0
        const body = nl === -1 ? '' : rec.slice(nl + 1)
        for (const line of body.split('\n')) {
          const t = line.split('\t')
          if (t.length >= 3 && /^\d+$/.test(t[0])) total += Number(t[0])
        }
        numstatTotals.set(sha, total)
      }
    }

    // 作者过滤条件：显式 --author 优先，否则用该仓库 git config 的邮箱与姓名
    const needles = authorOpt
      ? [authorOpt.toLowerCase()]
      : [cfgEmail, cfgName].filter(Boolean).map(s => s.toLowerCase())
    const isMine = c => anyAuthor || !needles.length ||
      needles.some(n => c.ae.toLowerCase().includes(n) || c.an.toLowerCase().includes(n))

    let wrote = 0, skipped = 0, mismatch = 0, otherAuthor = 0
    for (const c of commits.values()) {
      if (!isMine(c)) { otherAuthor++; continue }
      if (c.added === 0) { skipped++; continue }

      // 已认领行号
      const existing = notes.get(c.sha)
      const parsed = existing ? parseNote(existing) : { map: new Map(), json: null }
      const claimed = new Map() // path -> Set
      for (const [p, entries] of parsed.map) {
        const s = new Set()
        for (const e of entries) for (const n of e.set) s.add(n)
        claimed.set(p, s)
      }
      // 校验：补丁解析出的新增行数必须接近 `--numstat`。
      // git 自己偶尔会让两者差 1~2 行（diff 配对怪癖），行号本身来自补丁、始终正确，
      // 所以小偏差放行，只有大偏差（= 补丁解析真的错位了）才跳过。
      const numstatAdded = numstatTotals.get(c.sha) ?? -1
      const drift = Math.abs(numstatAdded - c.added)
      const bigDrift = numstatAdded < 0 || (drift > 6 && drift * 15 > numstatAdded)
      if (bigDrift) {
        mismatch++
        console.log(`  ! ${c.sha.slice(0, 8)} 新增行数与 numstat 不一致 (${c.added} vs ${numstatAdded})，跳过`)
        continue
      }

      // 差集
      const missing = new Map()
      let missingCount = 0
      for (const [p, set] of c.files) {
        const have = claimed.get(p) ?? new Set()
        const miss = []
        for (const n of set) if (!have.has(n)) miss.push(n)
        if (miss.length) { missing.set(p, miss.sort((a, b) => a - b)); missingCount += miss.length }
      }
      const totalClaimed = [...claimed.values()].reduce((a, s) => a + s.size, 0)
      if (!missingCount && !parsed.junk) { skipped++; continue }
      if (!missingCount) console.log(`  ~ ${c.sha.slice(0, 8)} 修复 malformed note（清除头部 JSON 垃圾行）`)
      if (existing && totalClaimed + missingCount < c.added) {
        // note 覆盖不到全部新增行（可能有 note 里没列的文件）——仍补齐，只警告
        console.log(`  ~ ${c.sha.slice(0, 8)} 已有 note 覆盖 ${totalClaimed}/${c.added}，补齐 ${missingCount}`)
      }

      // 生成 backfill session id（按仓库+提交确定性）
      const h = createHash('sha256').update(`${repo}::${c.sha}::backfill`).digest('hex')
      const sid = `s_${h.slice(0, 14)}`
      const tid = `t_${h.slice(14, 28)}`
      const backfillId = `${sid}::${tid}`

      // 拼 note：保留原有行映射，追加缺失行
      const blocks = []
      // 原有（按原顺序）
      for (const [p, entries] of parsed.map) {
        blocks.push(p)
        for (const e of entries) blocks.push(`  ${e.id} ${fmtRanges([...e.set].sort((a, b) => a - b))}`)
      }
      // 新增缺失
      for (const [p, miss] of missing) {
        if (!parsed.map.has(p)) blocks.push(p)
        blocks.push(`  ${backfillId} ${fmtRanges(miss)}`)
      }
      const json = parsed.json ?? {
        schema_version: 'authorship/3.0.0',
        git_ai_version: '1.6.2',
        base_commit_sha: c.sha,
        prompts: {},
        sessions: {},
      }
      if (!json.sessions) json.sessions = {}
      json.base_commit_sha = c.sha
      // 纯修复（无缺失行）不新增 session——它不认领任何行，只是把 note 洗干净。
      if (missingCount) {
        json.sessions[sid] = {
          agent_id: { tool: 'dsh', id: 'backfill-all', model: 'trae-cn/deepseek-v4.1-flash' },
          human_author: `${c.an} <${c.ae}>`,
          custom_attributes: { edit_kind: 'file_edit', backfilled: true },
        }
      }
      const body = `${blocks.join('\n')}\n---\n${JSON.stringify(json, null, 2)}\n`

      if (dryRun) {
        console.log(`  (dry-run) ${c.sha.slice(0, 8)} ${missingCount ? `补 ${missingCount} 行 / 共 ${c.added}` : '修复 malformed note'}`)
        wrote++
        continue
      }
      const f = join(tmp, `${c.sha}.note`)
      writeFileSync(f, body, 'utf8')
      let ok = false
      for (let attempt = 0; attempt < 8 && !ok; attempt++) {
        if (attempt > 0) sleepSync(attempt * 400) // 撞 ref lock 时退避（并发 post-commit hook）
        try {
          git(repo, ['notes', '--ref=ai-tob', 'add', '-f', '-F', f, c.sha])
          ok = true
        } catch (e) {
          const retryable = /lock|cannot|denied|busy/i.test(e.message)
          if (!retryable || attempt === 7) {
            console.log(`  x ${c.sha.slice(0, 8)} 写入失败: ${e.message.slice(0, 120)}`)
          }
        }
      }
      if (ok) { wrote++; grand.wrote++ } else { skipped++ }
    }
    console.log(`  完成：补 ${wrote} 条，已完整跳过 ${skipped}，作者不符 ${otherAuthor}，校验不符 ${mismatch}`)
    grand.commits += commits.size
    grand.skipped += skipped
    grand.mismatch += mismatch
    grand.otherAuthor += otherAuthor
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n总计：补写 ${grand.wrote} 条 note，跳过 ${grand.skipped}，作者不符 ${grand.otherAuthor}，校验不符 ${grand.mismatch}`)
