/**
 * src/tailscale.ts — best-effort detection of this machine's Tailscale
 * addresses (100.x IPv4 + MagicDNS name) so the gateway can advertise them
 * as alternate origins. Phones then probe every advertised address and use
 * whichever connects — the "free remote path" needs zero user networking
 * decisions. Every failure mode returns []; detection never blocks boot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CLI_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  // Windows installer drops tailscale.exe under Program Files; the service
  // CLI answers `ip`/`status` over the tailscaled named pipe unelevated.
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'tailscale',
];

const cli = (): string | undefined =>
  CLI_CANDIDATES.find((p) => !p.includes('/') || existsSync(p));

const run = (args: string[]): string | undefined => {
  const bin = cli();
  if (bin === undefined) return undefined;
  try {
    return execFileSync(bin, args, { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return undefined;
  }
};

/**
 * Returns tailnet address candidates for this node — the IPv4 address plus
 * the MagicDNS hostname (without the trailing dot), in that order. Empty
 * when Tailscale is absent, not logged in, or the tailnet is down.
 */
export function tailscaleNames(): string[] {
  const names: string[] = [];
  const ip = run(['ip', '-4']);
  if (ip !== undefined && /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip.split('\n')[0]!)) {
    names.push(ip.split('\n')[0]!);
  }
  const status = run(['status', '--json']);
  if (status !== undefined) {
    try {
      const dns = (JSON.parse(status) as { Self?: { DNSName?: string } }).Self?.DNSName;
      if (typeof dns === 'string') {
        const name = dns.replace(/\.$/, '');
        if (name !== '' && !names.includes(name)) names.push(name);
      }
    } catch { /* unparseable status — IP alone is still usable */ }
  }
  return names;
}
