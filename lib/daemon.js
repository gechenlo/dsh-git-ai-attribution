/**
 * Owns the DSH-side `git-ai` daemon: discovery, start, registration, identity
 * sync and heartbeats.
 *
 * TRAE starts its own daemon only while the IDE runs. This module starts an
 * independent one whose home lives under the DSH home directory, so attribution
 * keeps working with TRAE closed. The daemon is started at most once; every
 * further repository is added through `bootstrap-sync` with its own client id,
 * because re-using one id per repository replaced the previous lease.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const NOTES_REF = 'refs/notes/ai-tob'

/** Newest installed git-ai runtime, or the configured path. */
export function findGitAiBinary(configuredPath) {
  if (configuredPath) {
    if (!existsSync(configuredPath)) throw new Error(`git-ai not found: ${configuredPath}`)
    return configuredPath
  }
  const root = join(process.env.USERPROFILE ?? homedir(), '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime')
  if (!existsSync(root)) throw new Error(`git-ai runtime directory missing: ${root}`)
  const versions = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  for (const version of versions.reverse()) {
    for (const target of ['windows-x64', 'windows-arm64']) {
      const binary = join(root, version, target, 'host', 'git-ai.exe')
      if (existsSync(binary)) return binary
    }
  }
  throw new Error(`git-ai executable not found under ${root}`)
}

export function clientIdFor(repo) {
  return 'dsh-attribution:' + createHash('sha256').update(repo.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)
}

/** Control pipes of every running git-ai daemon. */
function listControlPipes() {
  try {
    return readdirSync('\\\\.\\pipe\\').filter(name => /^git-ai-.*-control$/.test(name))
  } catch {
    return []
  }
}

function send(socketName, payload, timeoutMs = 8000) {
  return new Promise(resolve => {
    const socket = net.createConnection('\\\\.\\pipe\\' + socketName)
    let settled = false
    let buffer = ''
    const finish = ok => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('\n')) {
        try { finish(JSON.parse(buffer.split('\n')[0]).ok === true) } catch { finish(false) }
      }
    })
    socket.on('error', () => finish(false))
    socket.on('end', () => finish(false))
  })
}

/**
 * Creates the daemon manager for one plugin instance.
 *
 * @param {object} options
 * @param {string} options.daemonHome - `GIT_AI_DAEMON_HOME` for the DSH daemon.
 * @param {() => { appKey?: string, appId?: string, channelDomain?: string, proxyDomain?: string, configPath?: string }} options.credentials
 * @param {(message: string) => void} [options.trace]
 */
export function createDaemonManager({ daemonHome, binaryPath, credentials, trace = () => {} }) {
  const binary = findGitAiBinary(binaryPath)
  /** @type {Set<string>} */
  const registered = new Set()
  /** @type {Map<string, number>} */
  const heartbeatMisses = new Map()
  let starting = Promise.resolve()
  let socketName

  const env = () => {
    const config = credentials()
    if (!config.appKey) throw new Error('TRAE login state has no DataFinder app key')
    if (!config.appId || !config.channelDomain) throw new Error('TRAE reporting identity unavailable')
    return {
      ...process.env,
      GIT_AI_DAEMON_HOME: daemonHome,
      GIT_AI_NOTES_REF: NOTES_REF,
      GIT_AI_DATAFINDER_APP_ID: config.appId,
      GIT_AI_DATAFINDER_CHANNEL_DOMAIN: config.channelDomain,
      GIT_AI_DATAFINDER_APP_KEY: config.appKey,
    }
  }

  /**
   * Control pipe of OUR daemon, read from `bg status` under our own env.
   *
   * `undefined` = status ran but nothing listens for this home (a foreign
   * daemon must not be mistaken for ours: it would answer ping yet never see
   * our registrations or DataFinder credentials). `null` = status itself
   * failed (e.g. no credentials yet), so the caller falls back to discovery.
   */
  function statusSocket() {
    return new Promise(resolve => {
      let environment
      try {
        environment = env()
      } catch {
        resolve(null)
        return
      }
      let child
      try {
        child = spawn(binary, ['bg', 'status'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        resolve(null)
        return
      }
      let out = ''
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* Already gone. */ }
        finish(null)
      }, 8_000)
      timer.unref?.()
      child.stdout?.on('data', chunk => { out += chunk.toString('utf8') })
      child.on('error', () => finish(null))
      child.on('close', () => {
        const match = out.match(/git-ai-[\w-]+-control/)
        if (match && out.includes('"daemon_running": true')) finish(match[0])
        else if (out.trim().startsWith('{')) finish(undefined)
        else finish(null)
      })
    })
  }

  async function resolveControl() {
    if (socketName) return socketName
    const own = await statusSocket()
    if (own) {
      socketName = own
      return socketName
    }
    if (own === undefined) return undefined
    const pipes = listControlPipes()
    if (pipes.length === 1) {
      socketName = pipes[0]
      return socketName
    }
    for (const pipe of pipes) {
      if (await send(pipe, { method: 'ping' }, 2000)) {
        socketName = pipe
        return socketName
      }
    }
    return undefined
  }

  async function waitUntilReady(attempts = 15) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const pipe = await resolveControl()
      if (pipe && await send(pipe, { method: 'ping' }, 3000)) return pipe
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    throw new Error('git-ai daemon did not become ready')
  }

  /** Starts the daemon once and syncs TRAE's reporting identity into it. */
  async function ensureStarted() {
    starting = starting.then(async () => {
      if (await resolveControl() && await send(socketName, { method: 'ping' }, 2000)) return
      const child = spawn(binary, ['bg', 'start', '--ingestion=file-watch'], {
        env: env(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      const pipe = await waitUntilReady()
      const config = credentials()
      if (config.configPath) {
        await send(pipe, { method: 'datafinder.config_sync', params: { config_path: config.configPath } })
      }
      trace('daemon started')
    }).catch(error => {
      trace(`daemon start failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    })
    return starting
  }

  /** Registers one repository with its own client id. */
  async function register(repo) {
    if (registered.has(repo)) return true
    await ensureStarted()
    const pipe = await resolveControl()
    if (!pipe) return false
    const child = spawn(binary, [
      'bg', 'bootstrap-sync',
      '--ingestion=file-watch',
      `--client-id=${clientIdFor(repo)}`,
      '--client-type=dsh',
      `--repo=${repo}`,
    ], { env: env(), stdio: 'ignore', windowsHide: true })
    const code = await new Promise(resolve => child.on('exit', resolve).on('error', () => resolve(1)))
    if (code !== 0) {
      trace(`bootstrap-sync failed repo=${repo}`)
      return false
    }
    registered.add(repo)
    return true
  }

  /** Keeps leases alive; a daemon without heartbeats exits after its grace period. */
  async function heartbeat() {
    for (const repo of registered) {
      const pipe = await resolveControl()
      const ok = pipe ? await send(pipe, { method: 'client.heartbeat', params: { client_id: clientIdFor(repo) } }) : false
      if (ok) {
        heartbeatMisses.delete(repo)
        continue
      }
      const misses = (heartbeatMisses.get(repo) ?? 0) + 1
      heartbeatMisses.set(repo, misses)
      if (misses < 2) continue
      heartbeatMisses.delete(repo)
      registered.delete(repo)
      socketName = undefined
      trace(`daemon heartbeat lost repo=${repo}`)
      await ensureStarted().catch(() => undefined)
      await register(repo).catch(() => undefined)
    }
  }

  return {
    binary,
    ensureStarted,
    register,
    heartbeat,
    isRegistered: repo => registered.has(repo),
    environment: env,
    notesRef: NOTES_REF,
  }
}

export { NOTES_REF }
