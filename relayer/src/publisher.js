const fs = require("fs");
const path = require("path");
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

/**
 * Fetch the bundle a request's `inputURI` points at.
 *
 * The URI is emitted by the consumer and is completely untrusted — it is a locator, not an
 * authority. `verify` below is what makes that safe.
 */
async function fetchBundle(uri) {
  if (!uri) throw new Error("request carries no inputURI");

  if (uri.startsWith("file://")) {
    const file = uri.slice("file://".length);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const res = await fetch(uri, { redirect: "error" });
    if (!res.ok) throw new Error(`inputURI fetch failed: ${res.status}`);
    return res.json();
  }
  // A bare name resolves inside BUNDLE_DIR — how the local demo passes bundles around.
  const file = path.join(config.bundleDir, `${uri}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));

  throw new Error(`unsupported inputURI scheme: ${uri}`);
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

module.exports = { Publisher, buildBundle, newSalt, fetchBundle, verify, open, writeBundle };
