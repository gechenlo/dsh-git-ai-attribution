'use strict';

/**
 * Smoke check without DSH: verifies TRAE discovery, credential decryption,
 * git-ai discovery and daemon readiness. Prints flags only, never secrets.
 *
 *   node scripts/check.mjs
 */
import { existsSync } from 'node:fs'
import { createDaemonManager } from '../lib/daemon.js'
import { findTraeBundle, readDataFinderConfig, readIdentity } from '../lib/credentials.js'

const report = { traeBundle: false, appKey: false, gitAi: false, daemon: false, registered: false }

let bundle
try {
  bundle = findTraeBundle()
  report.traeBundle = true
} catch (error) {
  console.log(JSON.stringify({ ...report, error: error.message }))
  process.exit(1)
}

let credentials
try {
  credentials = readDataFinderConfig({ traeBundlePath: bundle })
  report.appKey = Boolean(credentials.appKey)
} catch (error) {
  console.log(JSON.stringify({ ...report, error: error.message }))
  process.exit(1)
}

const tenantRoot = `${process.env.USERPROFILE}\\.trae-cn\\.git-ai-tob`
const tenant = existsSync(tenantRoot)
  ? (await import('node:fs')).readdirSync(tenantRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(entry => `${tenantRoot}\\${entry.name}`)[0]
  : undefined
const identity = readIdentity(tenant)
const daemonHome = `${process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`}\\git-ai-daemon`

let daemon
try {
  daemon = createDaemonManager({
    daemonHome,
    credentials: () => ({ ...credentials, ...identity }),
    trace: () => {},
  })
  report.gitAi = true
} catch (error) {
  console.log(JSON.stringify({ ...report, error: error.message }))
  process.exit(1)
}

try {
  await daemon.ensureStarted()
  report.daemon = true
} catch (error) {
  console.log(JSON.stringify({ ...report, error: error.message }))
  process.exit(1)
}

const repo = process.argv[2]
if (repo) {
  report.registered = await daemon.register(repo)
}

console.log(JSON.stringify(report))
process.exit(report.daemon && (!repo || report.registered) ? 0 : 1)
