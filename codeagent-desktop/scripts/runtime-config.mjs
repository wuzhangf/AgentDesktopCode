import crypto from 'node:crypto'
import fs from 'node:fs'

export const RUNTIME_CONFIG_SCHEMA_VERSION = 'business-launch-config/1'
// SHADOW is the safe rollout default for the configurable scheduler.  DEGRADED
// remains accepted as a legacy input, but it is normalized by the Java service
// to SHADOW and must not be used as a guessed scheduler mode by clients.
export const SCHEDULER_MODES = Object.freeze(['DEGRADED', 'LEGACY', 'SHADOW', 'ENFORCING'])
export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  schedulerMode: 'SHADOW',
  maxActive: 2,
  maxActivePerSession: 1,
  queueCapacity: 20,
})

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

function parseProperties(text) {
  const properties = {}
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const separator = line.indexOf('=')
    if (separator < 1) fail('INVALID_CONFIGURATION', `line ${index + 1} must contain key=value`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (Object.hasOwn(properties, key) && properties[key] !== value) {
      fail('CONFIGURATION_CONFLICT', `duplicate ${key} has different values`)
    }
    properties[key] = value
  }
  return properties
}

function positiveInteger(raw, key, minimum = 1, maximum = 64) {
  if (raw === undefined || raw === '') return undefined
  if (!/^\d+$/.test(String(raw))) fail('INVALID_CONFIGURATION', `${key} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_CONFIGURATION', `${key} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function effectiveInteger(properties, env, primaryKey, legacyKey, envName, defaultValue, minimum = 1, maximum = 64) {
  const primary = positiveInteger(properties[primaryKey], primaryKey, minimum, maximum)
  const legacy = positiveInteger(properties[legacyKey], legacyKey, minimum, maximum)
  if (primary !== undefined && legacy !== undefined && primary !== legacy) {
    fail('CONFIGURATION_CONFLICT', `${primaryKey} conflicts with legacy ${legacyKey}`)
  }
  const fromEnvironment = positiveInteger(env[envName], envName, minimum, maximum)
  const value = fromEnvironment ?? primary ?? legacy ?? defaultValue
  const source = fromEnvironment !== undefined ? 'environment'
    : primary !== undefined ? 'canonical'
      : legacy !== undefined ? 'legacy-alias' : 'default'
  return { value, source }
}

export function resolveRuntimeConfig(properties = {}, env = {}) {
  const canonicalMode = properties['runs.scheduler.mode']
  const legacyMode = properties['scheduler.mode']
  if (canonicalMode !== undefined && legacyMode !== undefined
      && String(canonicalMode).toUpperCase() !== String(legacyMode).toUpperCase()) {
    fail('CONFIGURATION_CONFLICT', 'runs.scheduler.mode conflicts with legacy scheduler.mode')
  }
  const rawMode = env.CODEAGENT_RUNS_SCHEDULER_MODE
    ?? canonicalMode
    ?? legacyMode
    ?? DEFAULT_RUNTIME_CONFIG.schedulerMode
  const schedulerMode = String(rawMode).toUpperCase()
  if (!SCHEDULER_MODES.includes(schedulerMode)) {
    fail('INVALID_CONFIGURATION', 'runs.scheduler.mode must be DEGRADED, LEGACY, SHADOW or ENFORCING')
  }

  const active = effectiveInteger(
    properties,
    env,
    'runs.max-active',
    'worker.count',
    'CODEAGENT_RUNS_MAX_ACTIVE',
    DEFAULT_RUNTIME_CONFIG.maxActive,
    2,
    64,
  )
  const queue = effectiveInteger(
    properties,
    env,
    'queue.capacity',
    'runs.queue-capacity',
    'CODEAGENT_RUNS_QUEUE_CAPACITY',
    DEFAULT_RUNTIME_CONFIG.queueCapacity,
    1,
    10000,
  )
  const canonicalPerSession = positiveInteger(
    properties['runs.max-active-per-session'],
    'runs.max-active-per-session',
    1,
    active.value,
  )
  const legacyPerSession = positiveInteger(
    properties['scheduler.max-active-per-session'],
    'scheduler.max-active-per-session',
    1,
    active.value,
  )
  if (canonicalPerSession !== undefined && legacyPerSession !== undefined
      && canonicalPerSession !== legacyPerSession) {
    fail('CONFIGURATION_CONFLICT', 'runs.max-active-per-session conflicts with legacy scheduler.max-active-per-session')
  }
  const perSession = canonicalPerSession ?? legacyPerSession ?? DEFAULT_RUNTIME_CONFIG.maxActivePerSession
  const canonical = {
    schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
    schedulerMode,
    maxActive: active.value,
    maxActivePerSession: perSession,
    queueCapacity: queue.value,
  }
  const configFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
  return {
    ...canonical,
    configFingerprint,
    sources: {
      schedulerMode: env.CODEAGENT_RUNS_SCHEDULER_MODE !== undefined ? 'environment'
        : canonicalMode !== undefined ? 'canonical' : legacyMode !== undefined ? 'legacy-alias' : 'default',
      maxActive: active.source,
      maxActivePerSession: properties['runs.max-active-per-session'] !== undefined ? 'canonical'
        : properties['scheduler.max-active-per-session'] !== undefined ? 'legacy-alias' : 'default',
      queueCapacity: queue.source,
    },
  }
}

export function resolveRuntimeConfigFile(path, env = {}) {
  if (!path) fail('INVALID_CONFIGURATION', 'a service properties path is required')
  try {
    return resolveRuntimeConfig(parseProperties(fs.readFileSync(path, 'utf8')), env)
  } catch (error) {
    if (error?.code) throw error
    fail('INVALID_CONFIGURATION', `cannot read service properties: ${error.message}`)
  }
}

function cli() {
  const index = process.argv.indexOf('--properties')
  const propertiesPath = index >= 0 ? process.argv[index + 1] : undefined
  try {
    process.stdout.write(`${JSON.stringify(resolveRuntimeConfigFile(propertiesPath, process.env))}\n`)
  } catch (error) {
    process.stderr.write(`${error.code ?? 'INVALID_CONFIGURATION'}: ${error.message}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).pathname.endsWith('/runtime-config.mjs')) cli()
