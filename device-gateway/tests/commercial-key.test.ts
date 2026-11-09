import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommercialAccess } from '../src/commercial.js';
import type { GatewayConfig } from '../src/context.js';
import type { Device } from '../src/protocol.js';

describe('commercial identity with gateway TLS keys', () => {
  for (const namedCurve of ['prime256v1','secp384r1']) {
    it(`signs a verifiable device challenge with ${namedCurve}`, () => {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve });
      const access = new CommercialAccess({ storeId:'owned-store', certificateSha256:'a'.repeat(64) } as GatewayConfig,
        Buffer.from(privateKey.export({format:'pem',type:'pkcs8'})), 'https://daily.example');
      const challenge = access.challenge({id:'owned-device',installationId:'owned-phone',revision:1} as Device);
      const proof = challenge.proof as Record<string,string>;
      const payload = Buffer.from(proof.payload,'base64url');
      const key = createPublicKey({key:Buffer.from(proof.publicKey,'base64url'),format:'der',type:'spki'});
      expect(verify('sha256',payload,key,Buffer.from(proof.signature,'base64url'))).toBe(true);
      expect(JSON.parse(payload.toString()).deviceGrantId).toBe('owned-device');
    });
  }
  it('rejects unsupported curves', () => {
    const { privateKey } = generateKeyPairSync('ec',{namedCurve:'secp256k1'});
    expect(() => new CommercialAccess({} as GatewayConfig,
      Buffer.from(privateKey.export({format:'pem',type:'pkcs8'})))).toThrow();
  });
});
