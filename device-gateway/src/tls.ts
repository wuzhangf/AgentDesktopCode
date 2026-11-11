/**
 * TLS material for the gateway listener.
 *
 * Material lives in a directory as PEM files:
 *   device-gateway-tls.key   — EC P-256 private key (mode 0600)
 *   device-gateway-tls.crt   — self-signed certificate
 *   device-gateway-tls.ca.crt — optional CA for client verification
 *
 * loadTlsMaterial() returns undefined when neither key nor cert exists so the
 * caller can provision; a half-written pair is a hard error. Provisioning uses
 * the openssl CLI (no node-native self-signing exists); it is a no-op when
 * material is already present. Fingerprints are SHA-256 over DER, matching
 * Java's hex(MessageDigest SHA-256 cert.getEncoded()).
 */
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';

export const TLS_KEY_FILE = 'device-gateway-tls.key';
export const TLS_CERT_FILE = 'device-gateway-tls.crt';
export const TLS_CA_FILE = 'device-gateway-tls.ca.crt';

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
  ca?: Buffer;
  fingerprints: {
    certSha256: string;
    caSha256?: string;
  };
}

export interface TlsCertInfo {
  notBefore: number;
  notAfter: number;
  /** Java X509Certificate.getSubjectAlternativeNames() shape: [[type, value], ...]. */
  subjectAltNames: [number, string][];
}

/** SHA-256 hex over the DER of the FIRST PEM certificate block. */
export function fingerprintOfCertPem(pem: string): string {
  const match = /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\r\n]+?)\s*-----END CERTIFICATE-----/.exec(pem);
  if (!match) throw new Error('fingerprintOfCertPem: no PEM certificate block found');
  const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  return createHash('sha256').update(der).digest('hex');
}

const SAN_TYPES: Record<string, number> = {
  'DNS': 2,
  'IP Address': 7,
  'IP': 7,
  'URI': 6,
  'email': 1,
  'RID': 8,
};

/** notBefore/notAfter (epoch ms) + subjectAltNames in Java's [[type,value]] shape. */
export function certificateInfo(pem: string): TlsCertInfo {
  const cert = new X509Certificate(pem);
  const subjectAltNames: [number, string][] = [];
  if (cert.subjectAltName) {
    for (const entry of cert.subjectAltName.split(',')) {
      const trimmed = entry.trim();
      const idx = trimmed.indexOf(':');
      if (idx < 0) continue;
      const type = SAN_TYPES[trimmed.slice(0, idx)];
      if (type !== undefined) subjectAltNames.push([type, trimmed.slice(idx + 1)]);
    }
  }
  return {
    notBefore: Date.parse(cert.validFrom),
    notAfter: Date.parse(cert.validTo),
    subjectAltNames,
  };
}

export function loadTlsMaterial(dir: string): TlsMaterial | undefined {
  const keyPath = join(dir, TLS_KEY_FILE);
  const certPath = join(dir, TLS_CERT_FILE);
  const caPath = join(dir, TLS_CA_FILE);
  const hasKey = existsSync(keyPath);
  const hasCert = existsSync(certPath);
  if (!hasKey && !hasCert) return undefined;
  if (!hasKey || !hasCert) {
    throw new Error(`TLS material incomplete in ${dir}: ${TLS_KEY_FILE} and ${TLS_CERT_FILE} must exist together`);
  }
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  const ca = existsSync(caPath) ? readFileSync(caPath) : undefined;
  return {
    key,
    cert,
    ...(ca !== undefined ? { ca } : {}),
    fingerprints: {
      certSha256: fingerprintOfCertPem(cert.toString('utf8')),
      ...(ca !== undefined ? { caSha256: fingerprintOfCertPem(ca.toString('utf8')) } : {}),
    },
  };
}

export interface ProvisionOptions {
  commonName: string;
  /** Validity in days; defaults to 825. */
  days?: number;
}

/**
 * Generate an EC P-256 self-signed certificate via the openssl CLI. Existing
 * material is loaded and returned unchanged (never regenerated in place).
 */
export function provisionTlsMaterial(dir: string, opts: ProvisionOptions): TlsMaterial {
  const existing = loadTlsMaterial(dir);
  if (existing) return existing;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(opts.commonName)) {
    throw new Error(`provisionTlsMaterial: invalid commonName ${JSON.stringify(opts.commonName)}`);
  }
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('openssl', ['version'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    throw new Error(
      'provisionTlsMaterial: the openssl CLI is required on PATH to self-provision TLS material; ' +
      'alternatively place device-gateway-tls.key/.crt in the TLS directory or set DEVICE_GATEWAY_TLS_KEY/_CERT',
    );
  }
  const keyPath = join(dir, TLS_KEY_FILE);
  const certPath = join(dir, TLS_CERT_FILE);
  const days = Math.floor(opts.days ?? 825);
  const san = `${isIP(opts.commonName) ? 'IP' : 'DNS'}:${opts.commonName},DNS:localhost,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1`;
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', String(days), '-subj', `/CN=${opts.commonName}`,
      '-addext', `subjectAltName=${san}`,
      '-addext', 'extendedKeyUsage=serverAuth',
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    throw new Error(`provisionTlsMaterial: openssl certificate generation failed: ${
      error instanceof Error ? error.message : String(error)}`);
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Best effort — POSIX mode bits are advisory on Windows.
  }
  const material = loadTlsMaterial(dir);
  if (!material) throw new Error('provisionTlsMaterial: openssl reported success but no material was produced');
  return material;
}
