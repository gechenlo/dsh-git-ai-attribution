/**
 * Reads the DataFinder app key from TRAE's locally encrypted login state.
 *
 * TRAE stores the whole account object (including the key) encrypted with a
 * fixed AES-128 scheme whose tables ship inside its `main.js`. This module
 * reproduces that scheme so the key can be handed to a child process without
 * ever being written to disk or printed. Only the app key leaves the module;
 * tokens stay inside the decrypted object and are discarded with it.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STORAGE_ENTRY = 'iCubeAuthInfo://icube.cloudide'
const HEADER_STANDARD = Buffer.from([116, 99, 5, 16, 0, 0])
const HEADER_PRIVATE = Buffer.from([18, 57, 32, 32, 2, 3])
const CHECKSUM_SIZE = 64
const SALT_SIZE = 32
const MAX_INPUT_BYTES = 1024 * 1024

/** Candidate TRAE installations, most specific first. */
const TRAE_CANDIDATES = [
  () => join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Trae CN', 'resources', 'app', 'out', 'main.js'),
  () => join('C:', 'Program Files', 'Trae CN', 'resources', 'app', 'out', 'main.js'),
  () => join('C:', 'Program Files (x86)', 'Trae CN', 'resources', 'app', 'out', 'main.js'),
]

function sha512(buffer) {
  return createHash('sha512').update(buffer).digest()
}

/** Locates TRAE's `main.js`, which carries the crypto tables. */
export function findTraeBundle(configuredPath) {
  if (configuredPath) {
    if (!existsSync(configuredPath)) throw new Error(`TRAE bundle not found: ${configuredPath}`)
    return configuredPath
  }
  for (const candidate of TRAE_CANDIDATES) {
    const path = candidate()
    if (path && existsSync(path)) return path
  }
  const roots = ['C:\\', 'D:\\', 'E:\\']
  for (const root of roots) {
    for (const dir of ['software', 'Program Files', 'Apps']) {
      const path = join(root, dir, 'Trae CN', 'Trae CN', 'resources', 'app', 'out', 'main.js')
      if (existsSync(path)) return path
    }
  }
  throw new Error('TRAE installation not found; set traeBundlePath in the plugin config')
}

/** Extracts the four byte tables the installed bundle uses for AES material. */
function readTables(bundlePath) {
  const source = readFileSync(bundlePath, 'utf8')
  const tables = ['ehe', 'the', 'ihe', 'rhe'].map(name => {
    const match = source.match(new RegExp(`\\b${name}=(?:new Uint8Array|Uint8Array\\.from)\\(\\[([\\d,\\s]+)\\]\\)`))
    if (!match) throw new Error('Unsupported TRAE crypto table layout')
    const values = match[1].split(',').map(value => Number(value.trim()))
    if (values.length !== 64 || values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new Error('Unsupported TRAE crypto table values')
    }
    return Buffer.from(values)
  })
  return { privateA: tables[0], privateB: tables[1], standardA: tables[2], standardB: tables[3] }
}

function derive(salt, variant, tables) {
  const base = variant === 'standard' ? tables.standardA : tables.privateA
  const mask = variant === 'standard' ? tables.standardB : tables.privateB
  const combined = Buffer.alloc(128)
  sha512(salt).copy(combined, 0)
  for (let index = 0; index < 64; index += 1) combined[64 + index] = base[index] ^ mask[index]
  const result = sha512(combined)
  return { key: result.subarray(0, 16), iv: result.subarray(16, 32) }
}

function decrypt(encoded, tables) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > MAX_INPUT_BYTES * 2) {
    throw new Error('Unsupported TRAE login entry')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length < HEADER_STANDARD.length + SALT_SIZE + 16) throw new Error('Truncated TRAE login entry')
  let variant
  if (bytes.subarray(0, 6).equals(HEADER_STANDARD)) variant = 'standard'
  else if (bytes.subarray(0, 6).equals(HEADER_PRIVATE)) variant = 'private'
  else throw new Error('Unknown TRAE login entry version')
  const salt = bytes.subarray(6, 6 + SALT_SIZE)
  const ciphertext = bytes.subarray(6 + SALT_SIZE)
  const { key, iv } = derive(salt, variant, tables)
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (plaintext.length < CHECKSUM_SIZE) throw new Error('Truncated TRAE login payload')
  if (!sha512(plaintext.subarray(CHECKSUM_SIZE)).equals(plaintext.subarray(0, CHECKSUM_SIZE))) {
    throw new Error('TRAE login payload checksum mismatch')
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(CHECKSUM_SIZE)))
}

function storagePath(configuredPath) {
  if (configuredPath) return configuredPath
  return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Trae CN', 'User', 'globalStorage', 'storage.json')
}

/**
 * Resolves the reporting credentials TRAE would give its own git-ai daemon.
 *
 * @param {{ traeBundlePath?: string, traeStoragePath?: string }} [options]
 * @returns {{ appKey?: string, appId?: string, channelDomain?: string }}
 */
export function readDataFinderConfig(options = {}) {
  const tables = readTables(findTraeBundle(options.traeBundlePath))
  const file = storagePath(options.traeStoragePath)
  if (!existsSync(file)) throw new Error(`TRAE login state not found: ${file}`)
  const storage = JSON.parse(readFileSync(file, 'utf8'))
  const entry = storage[STORAGE_ENTRY]
  if (!entry) throw new Error(`TRAE login entry missing: ${STORAGE_ENTRY}`)
  const userInfo = decrypt(entry, tables)
  const dataFinder = userInfo?.account?.saasBootConfig?.dataFinder ?? {}
  return {
    appKey: typeof dataFinder.appKey === 'string' ? dataFinder.appKey : undefined,
    appId: typeof dataFinder.appId === 'string' ? dataFinder.appId : undefined,
    channelDomain: typeof dataFinder.channelDomain === 'string' ? dataFinder.channelDomain : undefined,
  }
}

/**
 * Non-secret reporting identity from the newest runtime config TRAE wrote.
 * These fields are plain text in TRAE's own working directory.
 *
 * @param {string} tenantDirectory - `~/.trae-cn/.git-ai-tob/<tenantId>`.
 */
export function readIdentity(tenantDirectory) {
  if (!tenantDirectory || !existsSync(tenantDirectory)) return {}
  const files = readdirSync(tenantDirectory)
    .filter(name => /^datafinder-runtime-config-.*\.json$/.test(name))
    .map(name => join(tenantDirectory, name))
    .sort((left, right) => Number(right.match(/(\d+)/)?.[1] ?? 0) - Number(left.match(/(\d+)/)?.[1] ?? 0))
  if (files.length === 0) return {}
  let config
  try {
    config = JSON.parse(readFileSync(files[0], 'utf8'))
  } catch {
    return {}
  }
  return {
    configPath: files[0],
    appId: typeof config.app_id === 'string' ? config.app_id : undefined,
    channelDomain: typeof config.channel_domain === 'string' ? config.channel_domain : undefined,
    proxyDomain: typeof config.proxy_domain === 'string' ? config.proxy_domain : undefined,
  }
}
