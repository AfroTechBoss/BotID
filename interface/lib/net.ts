// Is this URL safe to dial from a server?
//
// A webhook URL is a string a stranger typed, and something on our side of a trust boundary is
// going to make an HTTP request to it. That is the textbook shape of SSRF: the attacker does not
// need to reach the private network themselves, they only need to persuade a machine that already
// can. `http://169.254.169.254/latest/meta-data/iam/security-credentials/` is the canonical
// example — a link-local address that hands cloud credentials to whoever asks from inside.
//
// This is a port of the same check in relayer/src/publisher.js, which guards `inputURI`. Two
// copies rather than a shared package because the two processes share no build: the relayer is
// plain CommonJS Node, the interface is a TypeScript Next app. The rule is that the two lists stay
// identical — if one gains a range, so does the other.
//
// Checked here at subscribe time AND again in the relayer at delivery time. Not redundancy for its
// own sake: this check resolves DNS once, and the name is free to answer differently an hour later
// when the alert actually fires. Neither check alone is sufficient and neither closes rebinding
// (that needs dialling the resolved IP with the Host header carried through TLS). What the
// write-time check does buy is that the obvious attempt fails at the form, visibly, instead of
// being stored and quietly retried against the metadata endpoint every time an agent faults.

import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Is this address one our own host can reach but the public internet cannot?
 *
 * Loopback, link-local (which covers the cloud metadata endpoint), RFC1918, carrier-grade NAT,
 * IPv6 unique-local, and the v4-mapped forms a v4 target can hide inside.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||           // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224                              // multicast + reserved
    );
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase().split('%')[0];
    if (ip6 === '::' || ip6 === '::1') return true;
    if (/^f[cd]/.test(ip6)) return true;    // unique-local
    if (ip6.startsWith('fe80')) return true; // link-local
    if (ip6.startsWith('ff')) return true;   // multicast
    const mapped = ip6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unparseable is not something we dial
}

/** The most webhook URL we will store. Long enough for a signed callback, short of a payload. */
const MAX_WEBHOOK_URL = 2048;

export interface UrlCheck {
  ok: boolean;
  /** Present when ok is false — phrased for the person who typed the URL, not for a log. */
  reason?: string;
}

/**
 * Validate a webhook URL the way it will be used: as something we will POST to, unattended.
 *
 * https only. http would put the delivery secret's HMAC and the alert body on the wire in clear,
 * and an alert saying an agent was just challenged is worth reading if you are the challenger.
 */
export async function checkWebhookUrl(raw: string): Promise<UrlCheck> {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'no URL given' };
  if (raw.length > MAX_WEBHOOK_URL) return { ok: false, reason: 'URL is too long' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'must be https — an alert is delivered unattended and in the clear over http' };
  }
  // Credentials in a webhook URL would be replayed to whatever answers, including whatever answers
  // after a DNS change. If an endpoint needs a token, the delivery signature is the mechanism.
  if (url.username || url.password) return { ok: false, reason: 'must not carry credentials' };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return { ok: false, reason: `host does not resolve: ${host}` };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: `host does not resolve: ${host}` };
  // Every address, not the first: picking one and dialling another is how this check is usually
  // defeated.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return { ok: false, reason: `resolves to the private address ${address}` };
    }
  }
  return { ok: true };
}
