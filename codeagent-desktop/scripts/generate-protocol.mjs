/**
 * Regenerates packages/protocol/src/openapi-schema.gen.ts from the immutable
 * OpenAPI snapshot imported from AgentCodeService. The generated file is
 * committed; the drift test re-runs this and fails on any difference.
 *
 * The snapshot directory comes from service-dependency.lock.json
 * (generatedInputs), never from a hardcoded version — a new service import
 * only needs the lock to move.
 *
 * Run: corepack pnpm gen:protocol
 */
import { readFileSync } from 'node:fs';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { parse as parseYaml } from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const lockPath = path.join(repoRoot, 'service-dependency.lock.json');
const contractsRoot = path.join(repoRoot, 'contracts', 'agent-code');
const outputPath = path.resolve(here, '..', 'packages', 'protocol', 'src', 'openapi-schema.gen.ts');

function resolveSpecPath() {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const generatedInputs = lock.generatedInputs;
  if (typeof generatedInputs !== 'string' || generatedInputs.trim() === '') {
    throw new Error('service-dependency.lock.json is missing generatedInputs');
  }
  const snapshotDir = path.resolve(repoRoot, generatedInputs);
  const insideContracts = snapshotDir === contractsRoot
    || snapshotDir.startsWith(contractsRoot + path.sep);
  if (!insideContracts) {
    throw new Error(
      `generatedInputs must stay under contracts/agent-code: ${generatedInputs}`
    );
  }
  return path.join(snapshotDir, 'openapi', 'business-codeagent-v2.yaml');
}

export async function generateProtocol() {
  const ast = await openapiTS(pathToFileURL(resolveSpecPath()));
  return astToString(ast);
}

export async function generateWritableRequestSchemas() {
  const schemas = parseYaml(readFileSync(resolveSpecPath(), 'utf8')).components.schemas;
  const shared = new Set(['WritableCollaborationBudget', 'WritableGraphUnit', 'WritableCollaborationGraph', 'WritableUnitBudget', 'WritableSelectedUnit', 'WritableResolution']);
  const selected = Object.fromEntries(Object.entries(schemas).filter(([name]) => name.startsWith('Write') || shared.has(name)));
  return '// Generated from the canonical writable collaboration OpenAPI schemas.\nexport const writableRequestSchemas = ' + JSON.stringify(selected, null, 2) + ' as const;\n';
}
export async function regenerateProtocol() {
  const generated = await generateProtocol();
  await writeFileAsync(outputPath, generated, 'utf8');
  await writeFileAsync(path.join(path.dirname(outputPath), 'writable-request-schemas.gen.ts'), await generateWritableRequestSchemas(), 'utf8');
  return outputPath;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const out = await regenerateProtocol();
  console.log(`protocol regenerated at ${out}`);
}
