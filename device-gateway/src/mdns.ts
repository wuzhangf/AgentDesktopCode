/**
 * src/mdns.ts — minimal mDNS advertiser for `_agentlink._tcp`.
 *
 * iOS browses this type to discover paired-capable Macs on the LAN. The
 * advert carries only public discovery facts — host/store ids and the leaf
 * certificate fingerprint the phone already needs to pin the TLS channel.
 * Discovery is NOT a grant: a hostile LAN can spoof any of it, so the
 * pairing request it bootstraps is always owner-approved (see
 * devices.discoveryRequest).
 *
 * Zero-dependency responder: joins 224.0.0.251:5353, answers PTR/SRV/TXT/A
 * queries for our service, and re-announces periodically so client caches
 * stay warm. Names are written uncompressed — legal and far simpler.
 */
import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_agentlink._tcp.local';
const TTL_S = 120;
const ANNOUNCE_EVERY_MS = 60_000;

export interface MdnsAdvert {
  /** Bonjour instance label shown to phones (e.g. "Control Mac"). */
  instance: string;
  port: number;
  /** LAN IPv4 the phone should dial; when empty pick the first non-internal. */
  address?: string;
  txt: Record<string, string>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const encodeName = (name: string): Buffer => {
  const parts = name.replace(/\.$/, '').split('.');
  const out: number[] = [];
  for (const part of parts) {
    const b = Buffer.from(part, 'utf8');
    out.push(b.length, ...b);
  }
  out.push(0);
  return Buffer.from(out);
};

/** qname reader — follows no compression; questions only need decoding. */
const readName = (buf: Buffer, at: number): { name: string; next: number } => {
  const labels: string[] = [];
  let i = at;
  for (;;) {
    const len = buf[i];
    if (len === undefined) return { name: labels.join('.'), next: buf.length };
    if (len === 0) return { name: labels.join('.'), next: i + 1 };
    if ((len & 0xc0) !== 0) return { name: labels.join('.'), next: i + 2 };
    labels.push(buf.subarray(i + 1, i + 1 + len).toString('utf8'));
    i += 1 + len;
  }
};

const TYPE: Record<string, number> = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };

const rr = (name: string, type: number, ttl: number, rdata: Buffer, flush = false): Buffer =>
  Buffer.concat([
    encodeName(name),
    (() => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE((flush ? 0x8000 : 0) | 1, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(rdata.length, 8); return h; })(),
    rdata,
  ]);

const ptr = (name: string, target: string): Buffer => rr(name, TYPE.PTR, TTL_S, encodeName(target));
const srv = (name: string, port: number, target: string): Buffer => {
  const d = Buffer.alloc(6);
  d.writeUInt16BE(0, 0); d.writeUInt16BE(0, 2); d.writeUInt16BE(port, 4);
  return rr(name, TYPE.SRV, TTL_S, Buffer.concat([d, encodeName(target)]), true);
};
const txt = (name: string, fields: Record<string, string>): Buffer => {
  const rdata = Buffer.concat(Object.entries(fields).map(([k, v]) => {
    const s = Buffer.from(`${k}=${v}`, 'utf8');
    return Buffer.concat([Buffer.from([s.length]), s]);
  }));
  return rr(name, TYPE.TXT, TTL_S, rdata, true);
};
const a = (name: string, ip: string): Buffer =>
  rr(name, TYPE.A, TTL_S, Buffer.from(ip.split('.').map(Number)), true);

const pickAddress = (hint?: string): string | undefined => {
  // A wildcard bind (0.0.0.0/::) is a listen-any instruction, not an
  // address a phone can dial — fall through to the interface pick.
  if (hint !== undefined && /^(\d{1,3}\.){3}\d{1,3}$/.test(hint) && !hint.split('.').every((p) => p === '0')) return hint;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return undefined;
};

export interface MdnsHandle { stop(): void }

export const startMdns = (advert: MdnsAdvert): MdnsHandle => {
  const log = advert.log ?? (() => {});
  const ip = pickAddress(advert.address);
  const hostname = `${os.hostname().replace(/\.local$/, '')}.local`;
  const instance = `${advert.instance.replace(/\.local$/, '').replace(/\.$/, '')}.${SERVICE_TYPE}`;

  if (ip === undefined) {
    log('mdns.no-address');
    return { stop: () => {} };
  }

  const answers = (): Buffer[] => [
    ptr(SERVICE_TYPE, instance),
    srv(instance, advert.port, hostname),
    txt(instance, advert.txt),
    a(hostname, ip),
  ];

  const response = (): Buffer => {
    const records = answers();
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0, 0);            // id — always 0 in mDNS
    head.writeUInt16BE(0x8400, 2);       // QR | AA
    head.writeUInt16BE(0, 4);            // qdcount
    head.writeUInt16BE(records.length, 6); // ancount
    return Buffer.concat([head, ...records]);
  };

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const wanted = new Set([TYPE.PTR, TYPE.SRV, TYPE.TXT, TYPE.A, TYPE.AAAA, TYPE.ANY]);

  socket.on('error', (e) => log('mdns.error', { detail: String(e) }));

  socket.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12) return;
      const flags = msg.readUInt16BE(2);
      if ((flags & 0x8000) !== 0) return; // responses, not queries
      const qd = msg.readUInt16BE(4);
      let at = 12;
      let hit = false;
      for (let i = 0; i < qd && at < msg.length; i++) {
        const q = readName(msg, at);
        const qtype = msg.readUInt16BE(q.next);
        at = q.next + 4;
        const name = q.name.toLowerCase();
        if (wanted.has(qtype) && (name === SERVICE_TYPE || name === instance.toLowerCase() || name === hostname.toLowerCase())) hit = true;
      }
      if (hit) socket.send(response(), MDNS_PORT, MDNS_ADDRESS, () => {});
    } catch { /* malformed query — ignore */ }
  });

  socket.bind(MDNS_PORT, () => {
    try {
      socket.addMembership(MDNS_ADDRESS);
      socket.setMulticastTTL(255);
    } catch (e) {
      log('mdns.membership-failed', { detail: String(e) });
    }
    // Initial burst so already-listening phones see us immediately.
    const burst = (): void => socket.send(response(), MDNS_PORT, MDNS_ADDRESS, () => {});
    burst();
    setTimeout(burst, 1_000).unref();
    setTimeout(burst, 2_500).unref();
    log('mdns.advertising', { instance, port: advert.port, address: ip });
  });

  const announce = setInterval(() => {
    try { socket.send(response(), MDNS_PORT, MDNS_ADDRESS, () => {}); } catch { /* socket closed */ }
  }, ANNOUNCE_EVERY_MS);
  announce.unref();

  return {
    stop: () => {
      clearInterval(announce);
      try { socket.close(); } catch { /* already closed */ }
    },
  };
};
