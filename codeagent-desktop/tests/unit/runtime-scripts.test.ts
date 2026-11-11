import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const desktopRoot = path.resolve(__dirname, '../..')
const repoRoot = path.resolve(desktopRoot, '..')
const configScript = path.join(desktopRoot, 'scripts/runtime-config.mjs')
const provenanceScript = path.join(desktopRoot, 'scripts/runtime-provenance.mjs')

function run(script: string, input: unknown, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
  })
}

describe('runtime launch scripts', () => {
  it('projects canonical and legacy scheduler config through the package script', () => {
    const canonical = run(configScript, undefined, ['--properties', path.join(repoRoot, 'service-config/service.properties')])
    expect(canonical.status).toBe(0)
    const config = JSON.parse(canonical.stdout)
    expect(config).toMatchObject({
      schemaVersion: 'business-launch-config/1',
      schedulerMode: 'SHADOW',
      maxActive: 6,
      maxActivePerSession: 1,
      queueCapacity: 20,
    })

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-runtime-config-'))
    try {
      const legacyPath = path.join(tempDir, 'legacy.properties')
      fs.writeFileSync(legacyPath, 'worker.count=3\nruns.queue-capacity=7\nscheduler.max-active-per-session=1\nscheduler.mode=shadow\n')
      const legacy = run(configScript, undefined, ['--properties', legacyPath])
      expect(legacy.status).toBe(0)
      expect(JSON.parse(legacy.stdout)).toMatchObject({ schedulerMode: 'SHADOW', maxActive: 3, maxActivePerSession: 1, queueCapacity: 7 })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('accepts Java keyed-object classes and rejects the old array wire shape', () => {
    const input = {
      manifest: {
        root: 'D:/repo',
        provenance: {
          schemaVersion: 'business-runtime-provenance/1',
          snapshotId: 'snap-1',
          classes: { 'com.example.Runtime': { className: 'com.example.Runtime', source: 'D:/repo/runtime.jar', sha256: 'abc' } },
        },
      },
      actual: {
        schemaVersion: 'business-runtime-provenance/1',
        snapshotId: 'snap-1',
        classes: {
          'com.example.Runtime': {
            className: 'com.example.Runtime', loaded: true,
            codeSource: 'file:///D:/repo/runtime.jar', sha256: 'abc',
          },
        },
      },
      process: { pid: 42, commandLine: 'java -cp D:/repo/runtime.jar D:/repo/BusinessAgentServiceMain --config D:/repo/service-config/service.properties' },
      configPath: 'D:/repo/service-config/service.properties',
      expectedClasspathEntries: ['D:/repo/runtime.jar'],
    }
    const accepted = run(provenanceScript, input)
    expect(accepted.status).toBe(0)
    const result = JSON.parse(accepted.stdout)
    expect(result.classes).toEqual({
      'com.example.Runtime': { className: 'com.example.Runtime', source: 'file:///D:/repo/runtime.jar', sha256: 'abc' },
    })

    const rejected = run(provenanceScript, { ...input, actual: { ...input.actual, classes: [] } })
    expect(rejected.status).toBe(2)
    expect(rejected.stderr).toContain('classes must be a JSON object')
  })

  it('keeps launcher/config free of legacy paths and inline bearer output', () => {
    const properties = fs.readFileSync(path.join(repoRoot, 'service-config/service.properties'), 'utf8')
    const launcher = fs.readFileSync(path.join(repoRoot, 'codex-dev-run.ps1'), 'utf8')
    expect(properties).not.toContain('zcode-workspace')
    expect(properties).not.toContain('D:/project/workspace')
    expect(properties).not.toMatch(/^auth\.token=/m)
    expect(properties).toContain('auth.token-env=CODEAGENT_SERVICE_TOKEN')
    expect(launcher).toContain('service-config\\start-service.ps1')
    expect(launcher).toContain('-ConfigPath')
    expect(launcher).not.toContain('runtime-provenance.mjs')
    expect(launcher).not.toContain('-Druns.scheduler.mode=')
  })
})
