import fs from 'node:fs'
import path from 'node:path'
import { stdin } from 'node:process'

export const RUNTIME_PROVENANCE_SCHEMA_VERSION = 'business-runtime-provenance/1'

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

function stringAt(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

function normalized(value) {
  let text = String(value)
  if (/^file:/i.test(text)) {
    try {
      text = new URL(text).pathname.replace(/^\/(?=[A-Za-z]:)/, '')
    } catch { /* retain the original value for a fail-closed comparison */ }
  }
  return path.normalize(text).replaceAll('/', '\\').toLowerCase()
}

function isWithin(root, candidate) {
  const parent = normalized(root).replace(/[\\]+$/, '') + '\\'
  const child = normalized(candidate)
  return child === parent.slice(0, -1) || child.startsWith(parent)
}

function classRecords(value) {
  const classes = value?.classes ?? value?.keyClasses ?? value?.provenance?.classes
  if (Array.isArray(classes)) {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'classes must be a JSON object keyed by class name')
  }
  // Java RuntimeProvenance v1 returns a JSON object keyed by class name.
  if (classes && typeof classes === 'object') {
    return Object.entries(classes).map(([className, record]) => ({
      ...(record && typeof record === 'object' ? record : {}),
      className: record?.className ?? className,
    }))
  }
  return []
}

export function verifyRuntimeProvenance(input) {
  const manifest = input?.manifest
  const actual = input?.actual
  const processInfo = input?.process ?? {}
  if (!manifest || typeof manifest !== 'object' || !actual || typeof actual !== 'object') {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'manifest and runtime provenance are required')
  }
  const expectedSchema = stringAt(manifest?.provenance, ['schemaVersion']) ?? RUNTIME_PROVENANCE_SCHEMA_VERSION
  const actualSchema = stringAt(actual, ['schemaVersion']) ?? stringAt(actual?.provenance, ['schemaVersion'])
  if (actualSchema !== expectedSchema || actualSchema !== RUNTIME_PROVENANCE_SCHEMA_VERSION) {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'provenance schema is missing or mismatched')
  }
  const expectedSnapshot = stringAt(manifest?.provenance, ['snapshotId']) ?? stringAt(manifest, ['snapshotId'])
  const actualSnapshot = stringAt(actual, ['snapshotId']) ?? stringAt(actual?.provenance, ['snapshotId'])
  if (!expectedSnapshot || !actualSnapshot || expectedSnapshot !== actualSnapshot) {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'snapshotId is missing or does not match the release manifest')
  }

  const expectedRoot = input.expectedSourceRoot ?? stringAt(manifest, ['root', 'sourceRepository'])
  const commandLine = stringAt(processInfo, ['commandLine'])
  const configPath = input.configPath
  if (!expectedRoot || !commandLine) {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'source root and owning process command line are required')
  }
  if (!normalized(commandLine).includes(normalized(expectedRoot))
      || (configPath && !normalized(commandLine).includes(normalized(configPath)))) {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'owning PID command line points at another checkout or config')
  }
  const expectedPid = stringAt(actual, ['pid', 'processId'])
  if (expectedPid !== undefined && Number(expectedPid) !== Number(processInfo.pid)) {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'runtime PID differs from the listening process')
  }

  // Both the launcher manifest and Java endpoint use the same keyed-object
  // wire shape; array projections are rejected on either side.
  const expectedClasses = classRecords(manifest?.provenance)
  const actualClasses = classRecords(actual)
  if (expectedClasses.length === 0 || actualClasses.length === 0) {
    fail('RUNTIME_PROVENANCE_MISMATCH', 'key class provenance is absent')
  }
  const actualByName = new Map(actualClasses.map((item) => [item?.className, item]))
  const classEvidence = expectedClasses.map((expected) => {
    const observed = actualByName.get(expected?.className)
    const expectedSource = stringAt(expected, ['source', 'codeSource'])
    const observedSource = stringAt(observed, ['source', 'codeSource'])
    const expectedHash = stringAt(expected, ['sha256', 'hash'])
    const observedHash = stringAt(observed, ['sha256', 'hash'])
    if (!observed || observed.loaded === false || !expectedSource || !observedSource || !expectedHash || !observedHash
        || normalized(expectedSource) !== normalized(observedSource)
        || expectedHash.toLowerCase() !== observedHash.toLowerCase()
        || !normalized(commandLine).includes(normalized(expectedRoot))) {
      fail('RUNTIME_PROVENANCE_MISMATCH', `key class does not match: ${expected?.className ?? 'unknown'}`)
    }
    return { className: expected.className, source: observedSource, sha256: observedHash }
  })

  // The Java endpoint intentionally exposes class CodeSource/bytes, not a
  // process command line or classpath hash.  The launcher supplies the
  // process-side classpath evidence separately and this helper verifies it
  // against the owning PID command line when requested.
  const expectedClasspathEntries = input.expectedClasspathEntries
    ?? manifest.classpathEntries
    ?? Object.values(manifest.artifacts ?? {}).map((item) => item?.Path ?? item?.path).filter(Boolean)
  for (const entry of expectedClasspathEntries) {
    if (!normalized(commandLine).includes(normalized(entry))) {
      fail('RUNTIME_PROVENANCE_MISMATCH', `owning PID command line omits classpath entry: ${entry}`)
    }
  }
  const classes = Object.fromEntries(classEvidence.map((entry) => [entry.className, entry]))
  return {
    ok: true,
    schemaVersion: actualSchema,
    snapshotId: actualSnapshot,
    pid: Number(processInfo.pid),
    classCount: classEvidence.length,
    sourceRoot: expectedRoot,
    configPath,
    classpathEntries: expectedClasspathEntries,
    // Match Java RuntimeProvenance's JSON shape: classes is never an array.
    classes,
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function cli() {
  try {
    const input = JSON.parse(await readStdin())
    process.stdout.write(`${JSON.stringify(verifyRuntimeProvenance(input))}\n`)
  } catch (error) {
    process.stderr.write(`${error.code ?? 'RUNTIME_PROVENANCE_MISMATCH'}: ${error.message}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && process.argv[1].endsWith('runtime-provenance.mjs')) cli()
