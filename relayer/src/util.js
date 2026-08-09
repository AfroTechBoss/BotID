const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const log = {
  info: (m) => console.log(`${stamp()}  ${m}`),
  warn: (m) => console.log(`${stamp()}  ! ${m}`),
  error: (m) => console.error(`${stamp()}  x ${m}`),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry with backoff, but only for transient failures. A revert means the chain has decided;
 * repeating it burns gas and, for a delivery, burns the deadline that a fallback might still
 * have made. Nonce and network errors are worth another go.
 */
async function retry(fn, { attempts = 3, baseMs = 750, label = "call" } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const permanent =
        e.code === "CALL_EXCEPTION" ||
        e.code === "INSUFFICIENT_FUNDS" ||
        /execution reverted/i.test(e.message ?? "");
      if (permanent) throw e;
      log.warn(`${label} attempt ${i + 1}/${attempts} failed: ${e.shortMessage ?? e.message}`);
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

/**
 * De-duplicates work by key. Chain reorgs, the backfill sweep and the live subscription all
 * deliver the same event, and delivering twice wastes gas on a guaranteed revert.
 */
class Backlog {
  constructor() {
    this.inflight = new Map();
    this.done = new Set();
  }

  async once(key, fn) {
    if (this.done.has(key)) return;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      try {
        await fn();
        this.done.add(key);
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }
}

module.exports = { log, sleep, retry, Backlog };
