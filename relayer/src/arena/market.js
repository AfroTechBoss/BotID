const config = require("../config");

/**
 * Real prices, and the two numbers the Arena derives from them.
 *
 * The Arena needs prices twice for every job, and they are not the same number:
 *
 *   at order time    a *feed reading* — what the model is asked to run on. Committed on chain.
 *   at settle time   an *entry and exit price* — what the allocation is graded against.
 *
 * Keeping them apart is not tidiness. The feed reading is a rebased index and has thrown away
 * the price level by construction (see `indexOf` below); the P&L needs the level and nothing
 * else. One number cannot be both.
 *
 * ---------------------------------------------------------------------------------------
 * Why a raw price cannot be a feed reading
 *
 * Two independent walls, either of which is fatal:
 *
 *   1. The circuit's domain. `circuits/spec.json` sets `maxAbsValue: 300000` and `decimals: 100`,
 *      so a reading is capped at 3000.00 units. Bitcoin in cents is two orders of magnitude
 *      past that. The comment in spec.json is explicit that exceeding the domain makes
 *      compilation fail rather than quietly lose precision — the good failure mode, but still
 *      a failure.
 *
 *   2. The model itself, which is worse. The reference allocator gives equal weight to every
 *      feed *strictly above the mean of the bundle*. Feed BTC, ETH and SOL as raw prices and
 *      BTC is above the mean every single time, forever. The answer would be [10000, 0, 0] on
 *      every request until the end of the deployment: a leaderboard where every agent returns
 *      the same constant is a leaderboard that ranks nothing.
 *
 * So the readings are **rebased indices**: each asset's price expressed against its own price
 * `lookbackHours` ago, with 100.00 meaning unchanged. An asset up 3% reads 103.00.
 *
 * That is the same trick a stock index uses — the FTSE is not quoted in pounds per share,
 * because "which of these is bigger" is a meaningless question about prices and a meaningful
 * one about *moves*. Rebasing turns the model from a comparison of tickers into a comparison of
 * performance, which makes "above the mean" mean "outperformed the basket over the lookback".
 * The strategy the reference allocator then expresses is cross-sectional momentum: hold the
 * assets that have been beating their peers. Whether that earns anything is exactly the
 * question the Arena exists to answer, per agent, out loud.
 */

/** Prices are carried as integers at this scale. Never as JS numbers — see BigInt in relayer.md. */
const PRICE_SCALE = 100_000_000n; // 1e8

/** The unit a feed reading is quoted in: `spec.json.decimals`, where 100 means cents. */
const FEED_DECIMALS = 100n;

/** What an unchanged asset reads as: 100.00, at FEED_DECIMALS. */
const INDEX_BASE = 100n * FEED_DECIMALS;

/** `spec.json.maxAbsValue`. A reading at or past this is outside the circuit's domain. */
const MAX_ABS_VALUE = 300_000n;

/** Decimal string -> integer at PRICE_SCALE. Rejects anything that is not a plain number. */
function parsePrice(text) {
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a price: ${JSON.stringify(text)}`);
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "00000000").slice(0, 8);
  const value = BigInt(whole) * PRICE_SCALE + BigInt(padded);
  if (value === 0n) throw new Error(`price is zero: ${s}`);
  return value;
}

/** For logs and ledger entries. Integers stay integers everywhere else. */
function formatPrice(value) {
  const whole = value / PRICE_SCALE;
  const frac = (value % PRICE_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * A price against a reference price, as a feed reading.
 *
 * `now / then * 100.00`, at FEED_DECIMALS. The bound is checked rather than assumed: a feed at
 * 300000 is 3000.00, meaning a thirtyfold move over the lookback, which on a major pair means
 * the price source has handed back garbage rather than that the market has done something
 * remarkable. Reverting here costs one skipped request; not reverting commits the agent to an
 * input its circuit cannot process.
 */
function indexOf(now, then) {
  if (then <= 0n) throw new Error("reference price is zero — cannot rebase");
  const value = (now * INDEX_BASE) / then;
  if (value <= 0n || value >= MAX_ABS_VALUE) {
    throw new Error(
      `rebased index ${value} is outside the circuit's domain (0, ${MAX_ABS_VALUE}) — ` +
        `spot ${formatPrice(now)} against ${formatPrice(then)} is not a move, it is bad data`
    );
  }
  return value;
}

// ------------------------------------------------------------------ sources

/**
 * Coinbase's public endpoints. No key, no account, and rate limits far above what a loop
 * running every few minutes will touch.
 *
 * Two endpoints because they answer two different questions, and the candle endpoint is the
 * one that can lie by omission: an empty candle array is a 200 response, so "no data for that
 * hour" arrives looking exactly like a successful call. It is checked.
 */
const coinbase = {
  name: "coinbase",

  async spot(pair) {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
      redirect: "error",
    });
    if (!res.ok) throw new Error(`coinbase spot ${pair}: HTTP ${res.status}`);
    const body = await res.json();
    const amount = body?.data?.amount;
    if (!amount) throw new Error(`coinbase spot ${pair}: no amount in response`);
    return parsePrice(amount);
  },

  /** Close of the hourly candle containing `atSec`. */
  async at(pair, atSec) {
    const start = new Date((atSec - 3600) * 1000).toISOString();
    const end = new Date((atSec + 3600) * 1000).toISOString();
    const url =
      `https://api.exchange.coinbase.com/products/${pair}/candles` +
      `?granularity=3600&start=${start}&end=${end}`;
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok) throw new Error(`coinbase candles ${pair}: HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`coinbase candles ${pair}: no candle covering ${new Date(atSec * 1000).toISOString()}`);
    }
    // [time, low, high, open, close, volume], newest first. Nearest bucket to the target.
    const best = rows.reduce((a, b) => (Math.abs(a[0] - atSec) <= Math.abs(b[0] - atSec) ? a : b));
    return parsePrice(String(best[4]));
  },
};

/**
 * A source backed by a fixed table, for tests and for a dry run with no network.
 *
 * `ARENA_PRICE_SOURCE=fixture:./prices.json` where the file is `{ "BTC-USD": { "spot": "…",
 * "history": { "<unix hour>": "…" } } }`. It exists so the scoring path can be exercised
 * against a recorded snapshot — step 3 of the build order in docs/arena.md — rather than
 * against whatever the market happened to do while the test was running.
 */
function fixtureSource(table) {
  return {
    name: "fixture",
    async spot(pair) {
      const row = table[pair];
      if (!row?.spot) throw new Error(`fixture has no spot for ${pair}`);
      return parsePrice(row.spot);
    },
    async at(pair, atSec) {
      const row = table[pair];
      const hour = String(Math.floor(atSec / 3600) * 3600);
      const price = row?.history?.[hour];
      if (!price) throw new Error(`fixture has no ${pair} price at ${hour}`);
      return parsePrice(price);
    },
  };
}

function loadSource(spec = config.arena.priceSource) {
  if (spec === "coinbase") return coinbase;
  if (spec.startsWith("fixture:")) {
    const file = spec.slice("fixture:".length);
    return fixtureSource(JSON.parse(require("fs").readFileSync(file, "utf8")));
  }
  throw new Error(`unknown ARENA_PRICE_SOURCE: ${spec}`);
}

/** "BTC/USD" is what the protocol calls the feed; "BTC-USD" is what the venue calls the pair. */
const pairOf = (asset) => asset.replace("/", "-");

// ------------------------------------------------------------------ the two reads

/**
 * Everything the order loop needs: one rebased reading per asset, plus the entry price the
 * settle loop will grade against.
 *
 * Both come from the same pass so they describe the same instant. Fetched in parallel per asset
 * and sequentially across the two questions, because a spot and a candle for the same pair are
 * independent requests and there is no ordering between them.
 */
async function snapshot({ assets, lookbackHours, source = loadSource(), nowSec } = {}) {
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const then = at - lookbackHours * 3600;

  const rows = await Promise.all(
    assets.map(async (asset) => {
      const pair = pairOf(asset);
      const [spot, reference] = await Promise.all([source.spot(pair), source.at(pair, then)]);
      return { asset, price: spot, reference, value: indexOf(spot, reference) };
    })
  );

  return { at, lookbackHours, source: source.name, rows };
}

/** The exit half: spot for each asset, now. */
async function exitPrices({ assets, source = loadSource(), nowSec } = {}) {
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const rows = await Promise.all(
    assets.map(async (asset) => ({ asset, price: await source.spot(pairOf(asset)) }))
  );
  return { at, rows };
}

module.exports = {
  PRICE_SCALE,
  FEED_DECIMALS,
  INDEX_BASE,
  MAX_ABS_VALUE,
  parsePrice,
  formatPrice,
  indexOf,
  loadSource,
  fixtureSource,
  coinbase,
  pairOf,
  snapshot,
  exitPrices,
};
