const fs = require("fs");
const path = require("path");
const net = require("net");
const dns = require("dns").promises;
const { ethers } = require("ethers");
const config = require("./config");
const {
  feedDigest,
  bundleCommitment,
  encodeBundle,
  decodeBundle,
  valueHash,
} = require("./digest");

/**
 * Input-side plumbing.
 *
 * In production the publisher is a third party — an oracle network signing price readings that
 * neither the consumer nor the agent controls. That independence is the whole point: it is what
 * makes "the agent ran the model correctly" mean something. The `Publisher` class here exists so
 * the reference deployment can run end-to-end on a local chain; it is not a production oracle.
 */
class Publisher {
  constructor(privateKey, chainId, attestorAddress) {
    this.wallet = new ethers.Wallet(privateKey);
    this.chainId = chainId;
    this.attestor = attestorAddress;
  }

  get address() {
    return this.wallet.address;
  }

  sign(feed) {
    const digest = feedDigest(this.chainId, this.attestor, feed);
    return new ethers.SigningKey(this.wallet.privateKey).sign(digest).serialized;
  }
}

/**
 * Assemble a signed bundle from readings.
 *
 * A reading is `{ feedId, timestamp, value, salt }`. `value` is a whole number at the model's
 * declared decimal scale and `salt` keeps it private until a Gold proof opens it — an input
 * commitment is public from the moment the request is made, so an unsalted reading is a
 * published price. The hash the publishers actually sign is derived here rather than supplied,
 * so a bundle can always be opened later; a reading that carries only a `valueHash` can be
 * delivered at Bronze but can never be escalated.
 *
 * Signatures on each reading must be ordered by ascending signer address: InputAttestor uses
 * strict ordering as its duplicate-signer check, so an unsorted bundle is rejected outright
 * rather than merely counted short.
 */
function buildBundle(chainId, attestorAddress, readings, publishers) {
  const sorted = [...publishers].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
  );

  const feeds = readings.map((r) => {
    const feed = {
      feedId: r.feedId,
      valueHash: r.valueHash ?? valueHash(r.value, r.salt),
      timestamp: r.timestamp,
    };
    return { ...feed, signatures: sorted.map((p) => p.sign(feed)) };
  });

  return {
    feeds,
    bundle: encodeBundle(feeds),
    commitment: bundleCommitment(chainId, attestorAddress, feeds),
  };
}

/** A fresh salt for one reading. 32 bytes of CSPRNG output — nothing is derived from it. */
function newSalt() {
  return ethers.hexlify(ethers.randomBytes(32));
}

/** The most bundle JSON we will ever read. Comfortably above a real bundle, far below a disk. */
const MAX_BUNDLE_BYTES = 4 << 20; // 4 MiB
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Is this address one the agent's own host can reach but the public internet cannot?
 *
 * The list is the usual private space plus the ones people forget: loopback, link-local (which
 * covers 169.254.169.254, the cloud metadata endpoint that hands out credentials), carrier-grade
 * NAT, IPv6 unique-local and the v4-mapped forms an attacker can hide a v4 target inside.
 */
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||          // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224                              // multicast + reserved
    );
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase().split("%")[0];
    if (ip6 === "::" || ip6 === "::1") return true;
    if (/^f[cd]/.test(ip6)) return true;   // unique-local
    if (ip6.startsWith("fe80")) return true; // link-local
    if (ip6.startsWith("ff")) return true;   // multicast
    // ::ffff:10.0.0.1 and friends — a v4 target wearing a v6 hat.
    const mapped = ip6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unparseable is not something we dial
}

/**
 * Fetch the bundle a request's `inputURI` points at.
 *
 * The URI is emitted by the consumer and is completely untrusted — it is a locator, not an
 * authority. `verify` below is what makes the *contents* safe: whatever comes back, the agent
 * only ever runs on data that hashes to the commitment already on chain.
 *
 * What `verify` cannot make safe is the act of fetching. That happens before any hash is checked,
 * and it happens from inside the operator's own network, using the operator's own credentials at
 * the network layer. `requestExecution` is permissionless, so anyone can hand this function a
 * string for the price of gas. Three things follow, and all three are enforced here rather than
 * trusted to the caller:
 *
 *   file://       is not accepted at all. It was an arbitrary local-file read — `.env`, the
 *                 operator key, an SSH key — dressed as a locator. The local demo never needed
 *                 it: a bare name already resolves inside BUNDLE_DIR, which is the same
 *                 convenience confined to a directory.
 *   bare names    must look like names. Anything with a separator or a `..` is rejected before
 *                 it reaches the filesystem, and the resolved path is confirmed to still be
 *                 inside BUNDLE_DIR afterwards — belt and braces, because path.join happily
 *                 walks upward when asked.
 *   http(s)://    must resolve to a public address. Every address the hostname resolves to is
 *                 checked, not just the first, and redirects stay off so a public URL cannot
 *                 bounce us somewhere private on the second hop.
 *
 * The residual gap is DNS rebinding: a name that passes the check here could answer differently
 * for the socket a moment later. Closing that properly means dialling the checked IP directly and
 * carrying the Host header through TLS, which is a bigger change than this warrants at the volume
 * involved. It is recorded rather than papered over — and `ALLOW_PRIVATE_INPUT_URI` exists for
 * anyone deliberately pointing an agent at a bundle server on their own network.
 */
async function fetchBundle(uri) {
  if (!uri) throw new Error("request carries no inputURI");
  if (typeof uri !== "string") throw new Error("inputURI is not a string");

  if (uri.startsWith("file://")) {
    throw new Error(
      "inputURI uses file://, which is not accepted — it is an arbitrary read of the operator's " +
        "own disk. Serve the bundle over https, or drop it in BUNDLE_DIR and reference it by name."
    );
  }

  if (/^https?:\/\//i.test(uri)) return fetchOverHttp(uri);

  // A bare name resolves inside BUNDLE_DIR — how the local demo passes bundles around. It is a
  // name, not a path: no separators, no traversal, nothing exotic enough to mean something to
  // the filesystem.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(uri) || uri.includes("..")) {
    throw new Error(`unsupported inputURI: ${uri.slice(0, 120)}`);
  }
  const dir = path.resolve(config.bundleDir);
  const file = path.resolve(dir, `${uri}.json`);
  if (file !== path.join(dir, `${uri}.json`) || !file.startsWith(dir + path.sep)) {
    throw new Error(`inputURI escapes the bundle directory: ${uri.slice(0, 120)}`);
  }
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));

  throw new Error(`no bundle named ${uri} in ${config.bundleDir}`);
}

async function fetchOverHttp(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`inputURI is not a valid URL: ${uri.slice(0, 120)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported inputURI scheme: ${url.protocol}`);
  }
  // Credentials in a locator are never legitimate here and would be sent to whatever answers.
  if (url.username || url.password) throw new Error("inputURI must not carry credentials");

  if (!config.allowPrivateInputURI) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // A literal IP needs no resolver; a name gets every address it answers with checked, because
    // picking one and dialling another is how this class of check is usually defeated.
    const addresses = net.isIP(host)
      ? [host]
      : (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    if (addresses.length === 0) throw new Error(`inputURI host does not resolve: ${host}`);
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(
          `inputURI resolves to the private address ${address} — refusing to fetch. Set ` +
            "ALLOW_PRIVATE_INPUT_URI=true only if you are deliberately serving bundles from " +
            "inside this network."
        );
      }
    }
  }

  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`inputURI fetch failed: ${res.status}`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
    throw new Error(`inputURI response is ${declared} bytes, over the ${MAX_BUNDLE_BYTES} cap`);
  }

  // Read against a budget rather than trusting content-length, which a hostile server can omit
  // or lie about. `res.json()` would happily buffer a stream that never ends.
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error("inputURI response exceeded the size cap");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Recompute the commitment from the bundle bytes and check it against the on-chain request.
 *
 * This is the single most important line in the relayer. Whatever served the URI — the
 * consumer, a CDN, an attacker who won a DNS race — the agent only ever runs on data that
 * hashes to the commitment the consumer committed to on chain. A hostile URI can waste the
 * agent's time; it cannot change what the agent is judged on.
 */
function verify(chainId, attestorAddress, bundleHex, expectedCommitment) {
  const feeds = decodeBundle(bundleHex);
  const actual = bundleCommitment(chainId, attestorAddress, feeds);
  if (actual.toLowerCase() !== expectedCommitment.toLowerCase()) {
    throw new Error(
      `bundle does not match the request's inputCommitment (got ${actual}, want ${expectedCommitment})`
    );
  }
  return feeds;
}

/**
 * Open the verified feeds against the readings served alongside them.
 *
 * `verify` establishes that the bundle is the one the consumer committed to. This establishes
 * that the numbers next to it are the numbers behind its hashes — the same check `ZkAdapter`
 * performs on chain, done here first so a mismatch costs a log line instead of a delivery.
 *
 * The readings are as untrusted as the bundle was. They are matched by position and confirmed
 * hash by hash, so a URI that serves a correct bundle with doctored values is rejected rather
 * than run on.
 *
 * Returns `null` when no readings were served at all. That is a legitimate state — a Bronze
 * agent can deliver on hashes it cannot open — and the caller decides whether the tier it is
 * about to attest at can live with it.
 */
function open(feeds, readings) {
  if (!readings || readings.length === 0) return null;
  if (readings.length !== feeds.length) {
    throw new Error(`bundle has ${feeds.length} feeds but ${readings.length} readings were served`);
  }

  return feeds.map((feed, i) => {
    const r = readings[i];
    if (r.value === undefined || r.value === null || !r.salt) {
      throw new Error(`reading ${i} carries no value/salt — it cannot be revealed at Gold`);
    }

    const reveal = {
      feedId: feed.feedId,
      timestamp: feed.timestamp,
      value: BigInt(r.value),
      salt: r.salt,
    };
    if (r.feedId && r.feedId.toLowerCase() !== feed.feedId.toLowerCase()) {
      throw new Error(`reading ${i} is for feed ${r.feedId}, bundle position holds ${feed.feedId}`);
    }
    const hash = valueHash(reveal.value, reveal.salt);
    if (hash.toLowerCase() !== feed.valueHash.toLowerCase()) {
      throw new Error(
        `reading ${i} does not open the committed valueHash (got ${hash}, want ${feed.valueHash})`
      );
    }
    return reveal;
  });
}

function writeBundle(name, payload) {
  fs.mkdirSync(config.bundleDir, { recursive: true });
  const file = path.join(config.bundleDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
  return file;
}

module.exports = { Publisher, buildBundle, newSalt, fetchBundle, verify, open, writeBundle, isPrivateAddress };
