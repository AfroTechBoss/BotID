const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Set before anything requires config: the loader lets a real environment variable win over
// .env, so this redirects the ledger away from a working deployment's file.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "botid-arena-"));
process.env.ARENA_LEDGER = path.join(scratch, "ledger.json");

const market = require("../src/arena/market");
const score = require("../src/arena/score");
const ledger = require("../src/arena/ledger");
const discovery = require("../src/arena/discovery");

// ------------------------------------------------------------------ prices

test("parsePrice keeps eight decimals and rejects anything that is not a price", () => {
  assert.equal(market.parsePrice("100"), 10_000_000_000n);
  assert.equal(market.parsePrice("104123.45"), 10_412_345_000_000n);
  assert.equal(market.parsePrice("0.00000001"), 1n);
  assert.equal(market.formatPrice(market.parsePrice("104123.45")), "104123.45");

  for (const bad of ["", "abc", "-5", "1e6", "1.2.3", "0"]) {
    assert.throws(() => market.parsePrice(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
});

test("indexOf rebases a price against its own past, not against other assets", () => {
  const then = market.parsePrice("100");
  assert.equal(market.indexOf(market.parsePrice("100"), then), 10_000n); // unchanged -> 100.00
  assert.equal(market.indexOf(market.parsePrice("103"), then), 10_300n); // +3%
  assert.equal(market.indexOf(market.parsePrice("97"), then), 9_700n); //  -3%

  // The point of rebasing: two assets three orders of magnitude apart in price land on the same
  // scale, so "above the mean" is a question about performance rather than about which ticker
  // happens to be worth more.
  const btc = market.indexOf(market.parsePrice("103000"), market.parsePrice("100000"));
  const sol = market.indexOf(market.parsePrice("103"), market.parsePrice("100"));
  assert.equal(btc, sol);
});

test("indexOf refuses a reading outside the circuit's domain", () => {
  // spec.json caps a reading at maxAbsValue 300000, i.e. a thirtyfold move. Past that the
  // source has handed back garbage, and committing to it produces an input no circuit can run.
  assert.throws(
    () => market.indexOf(market.parsePrice("100000"), market.parsePrice("1")),
    /outside the circuit's domain/
  );
  assert.throws(() => market.indexOf(market.parsePrice("100"), 0n), /cannot rebase/);
});

test("the fixture source answers spot and history without a network", async () => {
  const source = market.fixtureSource({
    "BTC-USD": { spot: "105000", history: { [String(1_700_000_000 - 1_700_000_000 % 3600)]: "100000" } },
  });
  assert.equal(await source.spot("BTC-USD"), market.parsePrice("105000"));
  assert.equal(await source.at("BTC-USD", 1_700_000_000), market.parsePrice("100000"));
  await assert.rejects(() => source.spot("ETH-USD"), /no spot for ETH-USD/);
});

// ------------------------------------------------------------------ scoring

test("pnlBps weights each leg's return by its allocation", () => {
  const entry = [market.parsePrice("100"), market.parsePrice("200"), market.parsePrice("50")];

  // Fully allocated to a single asset that gained 1% -> 100bps.
  assert.equal(score.pnlBps([10_000n, 0n, 0n], entry, [market.parsePrice("101"), entry[1], entry[2]]), 100n);

  // Half and half, one up 2% and one down 2% -> flat.
  assert.equal(
    score.pnlBps([5_000n, 5_000n, 0n], entry, [market.parsePrice("102"), market.parsePrice("196"), entry[2]]),
    0n
  );

  // A loss is signed.
  assert.equal(score.pnlBps([10_000n, 0n, 0n], entry, [market.parsePrice("95"), entry[1], entry[2]]), -500n);
});

test("unallocated weight is cash and earns nothing", () => {
  const entry = [market.parsePrice("100"), market.parsePrice("100"), market.parsePrice("100")];
  const exit = [market.parsePrice("110"), market.parsePrice("110"), market.parsePrice("110")];

  // The reference allocator returning all zeroes means "nothing was above the mean, stay out".
  // That has to score flat, not score as if the money had been invested anyway.
  assert.equal(score.pnlBps([0n, 0n, 0n], entry, exit), 0n);

  // A third allocated to something that gained 10% is 333bps, not 1000.
  assert.equal(score.pnlBps([3_333n, 0n, 0n], entry, exit), 333n);
});

test("pnlBps rounds once at the end rather than per leg", () => {
  const entry = [market.parsePrice("3"), market.parsePrice("3"), market.parsePrice("3")];
  const exit = [market.parsePrice("3.01"), market.parsePrice("3.01"), market.parsePrice("3.01")];
  // Three legs that each round down individually still sum to the whole.
  const whole = score.pnlBps([10_000n, 0n, 0n], entry, exit);
  const split = score.pnlBps([3_334n, 3_333n, 3_333n], entry, exit);
  assert.equal(whole, split);
});

test("pnlBps refuses mismatched or impossible inputs", () => {
  assert.throws(() => score.pnlBps([10_000n], [1n, 2n], [1n, 2n]), /1 legs but 2 entry/);
  assert.throws(() => score.pnlBps([10_000n], [0n], [1n]), /non-positive entry price/);
});

test("limitBreached fires only on an allocation claiming more than the whole portfolio", () => {
  assert.equal(score.overAllocated([5_000n, 5_000n, 0n]), false);
  assert.equal(score.overAllocated([10_000n, 0n, 0n]), false);
  assert.equal(score.overAllocated([0n, 0n, 0n]), false);
  assert.equal(score.overAllocated([6_000n, 5_000n, 0n]), true);
});

test("outcomeFor reports lateness and never invents a breach", () => {
  const entry = [market.parsePrice("100")];
  const exit = [market.parsePrice("99")];

  const onTime = score.outcomeFor({
    weights: [10_000n], entry, exit, deliveredAt: 1_000, deliverBy: 2_000,
  });
  assert.deepEqual(onTime, { realizedPnlBps: -100n, slaBreached: false, limitBreached: false });

  const late = score.outcomeFor({
    weights: [10_000n], entry, exit, deliveredAt: 3_000, deliverBy: 2_000,
  });
  assert.equal(late.slaBreached, true);

  // Unknown timestamps must not become a breach. limitBreached and slaBreached are slashes.
  const unknown = score.outcomeFor({ weights: [10_000n], entry, exit });
  assert.equal(unknown.slaBreached, false);
});

test("explain attributes the result leg by leg", () => {
  const legs = score.explain(
    ["BTC/USD", "ETH/USD"],
    [5_000n, 5_000n],
    [market.parsePrice("100"), market.parsePrice("200")],
    [market.parsePrice("110"), market.parsePrice("180")]
  );
  assert.equal(legs[0].returnBps, 1_000);
  assert.equal(legs[0].contributionBps, 500);
  assert.equal(legs[1].returnBps, -1_000);
  assert.equal(legs[1].contributionBps, -500);
  assert.equal(legs[0].contributionBps + legs[1].contributionBps, 0);
});

// ------------------------------------------------------------------ ledger

function row(overrides = {}) {
  return {
    requestId: "0xaa",
    agentId: "1",
    orderedAt: 1_000,
    holdUntil: 2_000,
    notional: 1_000_000n,
    fee: 1_000n,
    assets: ["BTC/USD"],
    entry: [market.parsePrice("100")],
    readings: [{ feedId: "0xfeed", value: 10_000n, salt: "0xsalt", timestamp: 1_000 }],
    ...overrides,
  };
}

test("the ledger round-trips bigints as strings and survives a reread", () => {
  fs.rmSync(process.env.ARENA_LEDGER, { force: true });
  ledger.record(row());

  const [stored] = ledger.open();
  assert.equal(stored.notional, "1000000");
  assert.equal(stored.entry[0], market.parsePrice("100").toString());
  assert.equal(BigInt(stored.readings[0].value), 10_000n);
  assert.equal(ledger.feesSpent(), 1_000n);
});

test("closing a row keeps it but takes it out of the open set", () => {
  fs.rmSync(process.env.ARENA_LEDGER, { force: true });
  ledger.record(row());
  ledger.close("0xaa", { realizedPnlBps: -250n, slaBreached: false, limitBreached: false }, "settled");

  assert.equal(ledger.open().length, 0);
  const kept = ledger.read().rows["0xaa"];
  assert.equal(kept.note, "settled");
  assert.equal(kept.outcome.realizedPnlBps, "-250");
  // Fees stay counted against the budget after settlement — they were spent either way.
  assert.equal(ledger.feesSpent(), 1_000n);
});

test("busyAgents and lastOrderedAt drive the eligibility filter", () => {
  fs.rmSync(process.env.ARENA_LEDGER, { force: true });
  ledger.record(row({ requestId: "0xaa", agentId: "1", orderedAt: 5_000 }));
  ledger.record(row({ requestId: "0xbb", agentId: "2", orderedAt: 9_000 }));
  ledger.close("0xbb", null, "done");

  assert.deepEqual([...ledger.busyAgents()], ["1"]);
  assert.equal(ledger.lastOrderedAt().get("2"), 9_000);
});

test("a truncated ledger file is a loud failure, not a silent empty one", () => {
  fs.writeFileSync(process.env.ARENA_LEDGER, '{"version":1,"rows":{"0xaa":');
  assert.throws(() => ledger.read(), SyntaxError);
  fs.rmSync(process.env.ARENA_LEDGER, { force: true });
});

// ------------------------------------------------------------------ discovery

test("log windows cover the range without gaps or overlap", () => {
  const w = discovery.windows(100, 350, 100);
  assert.deepEqual(w, [[100, 199], [200, 299], [300, 350]]);
  assert.deepEqual(discovery.windows(10, 10, 100), [[10, 10]]);
});

function agent(overrides = {}) {
  return {
    agentId: 1n,
    active: true,
    tier: 1,
    score: 5_000,
    openNotional: 0n,
    maxOpenNotional: 1_000_000n,
    ...overrides,
  };
}

test("eligibility explains every rejection", () => {
  const args = {
    busy: new Set(["2"]),
    lastOrdered: new Map([["3", 900]]),
    nowSec: 1_000,
    cooldownSec: 3_600,
    notionalBps: 2_500,
  };

  const { picked, skipped } = discovery.eligible(
    [
      agent({ agentId: 1n }),
      agent({ agentId: 2n }),
      agent({ agentId: 3n }),
      agent({ agentId: 4n, active: false }),
      agent({ agentId: 5n, maxOpenNotional: 0n }),
      agent({ agentId: 6n, openNotional: 900_000n }),
    ],
    args
  );

  assert.deepEqual(picked.map((p) => String(p.agentId)), ["1"]);
  assert.equal(picked[0].notional, 250_000n); // 25% of the credit line, not a constant

  const why = Object.fromEntries(skipped.map((s) => [s.agentId, s.why]));
  assert.match(why["2"], /already has an open Arena job/);
  assert.match(why["3"], /cooling down/);
  assert.match(why["4"], /inactive/);
  assert.match(why["5"], /credit line is zero/);
  assert.match(why["6"], /remaining credit/);
});

test("the longest-waiting agent is ordered from first", () => {
  const { picked } = discovery.eligible(
    [agent({ agentId: 1n }), agent({ agentId: 2n }), agent({ agentId: 3n })],
    {
      busy: new Set(),
      lastOrdered: new Map([["1", 500], ["2", 100], ["3", 300]]),
      nowSec: 100_000,
      cooldownSec: 60,
      notionalBps: 2_500,
    }
  );
  assert.deepEqual(picked.map((p) => String(p.agentId)), ["2", "3", "1"]);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
