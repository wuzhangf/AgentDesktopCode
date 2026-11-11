import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { expect, it } from 'vitest';
import { provisionTlsMaterial } from '../src/tls';

it('provisions an IP-matching TLS server leaf and preserves its existing pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-gateway-tls-'));
  try {
    const material = provisionTlsMaterial(root, { commonName: '192.168.1.33', days: 1 });
    const cert = new X509Certificate(material.cert);
    expect(cert.checkIP('192.168.1.33')).toBe('192.168.1.33');
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(provisionTlsMaterial(root, { commonName: 'other.test', days: 1 }).fingerprints.certSha256).toBe(material.fingerprints.certSha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
