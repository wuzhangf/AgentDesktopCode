/**
 * EW1 drift check (desktop design §9.1): the committed generated protocol
 * file must be byte-identical to a fresh regeneration from the canonical
 * OpenAPI. Any Java contract change that forgets regeneration fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateProtocol, generateWritableRequestSchemas } from '../../scripts/generate-protocol.mjs';

describe('protocol drift check', () => {
  it('writable IPC validation comes from the same immutable OpenAPI import', async () => {
    const committed = readFileSync(path.resolve(import.meta.dirname, '../../packages/protocol/src/writable-request-schemas.gen.ts'), 'utf8');
    expect(committed).toBe(await generateWritableRequestSchemas());
  });
  it('committed openapi-schema.gen.ts matches the canonical OpenAPI', async () => {
    const generated = await generateProtocol();
    const committedPath = path.resolve(
      import.meta.dirname,
      '..',
      '..',
      'packages',
      'protocol',
      'src',
      'openapi-schema.gen.ts'
    );
    const committed = readFileSync(committedPath, 'utf8');
    expect(committed).toBe(generated);
  });

  it('generated protocol still exposes the EW1 schemas', async () => {
    const generated = await generateProtocol();
    for (const schema of [
      'CapabilityResponse',
      'ProjectSummary',
      'RunStateResponse',
      'EvidenceBundleResponse',
      'ModelCatalogEntry',
      'Problem'
    ]) {
      expect(generated).toContain(`${schema}: {`);
    }
  });
});
