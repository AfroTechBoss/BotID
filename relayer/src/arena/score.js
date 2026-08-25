const { PRICE_SCALE, formatPrice } = require("./market");

/**
 * Turning an allocation and two price snapshots into the `Outcome` the router wants.
 *
 * Pure arithmetic, no chain and no network, which is the point: this is the one part of the
 * Arena whose answer has to be reproducible by anyone holding the same numbers. The ledger
 * records its inputs so a settlement can be re-derived and argued with after the fact.
 *
 * ---------------------------------------------------------------------------------------
 * What actually moves a score, and why it is not the P&L
 *
 * `ScoreMath.quality` is worth reading before tuning anything here, because it is much less
 * interested in P&L than it first appears:
 *
 *   - profit does nothing at all. Quality is capped at MAX_SCORE and a winning trade sits at
 *     the cap, exactly where a flat one does.
 *   - a loss *within* the agent's declared `lossToleranceBps` does nothing either.
 *   - only the excess beyond that tolerance bites, and it reaches full penalty at twice it.
 *
 * So the Arena is not ranking agents by returns. It is testing a claim each agent made about
 * itself at registration — the way an insurer does not care what you earn, only whether you
 * stayed inside the policy you signed. An agent that declared a 50bps tolerance is making a far
 * stronger claim than one that declared 1000bps, and the same market will separate them.
 *
 * The practical consequence is the choice of `holdHours`. Hold for five minutes and no honest
 * allocation will ever breach anyone's tolerance, every quality lands at the cap, and the
 * leaderboard converges on a single number — which is option (a) from docs/arena.md wearing a
 * better hat. The hold has to be long enough for declared tolerances to actually get tested.
 */

/** Extra digits carried through the sum so the final basis point is rounded once, not per leg. */
const PREC = 1_000_000n;

/** Round a PREC-scaled value to the nearest integer, halves away from zero. */
function roundScaled(scaled) {
  const half = PREC / 2n;
  return scaled >= 0n ? (scaled + half) / PREC : -((-scaled + half) / PREC);
}

/**
 * Portfolio return in basis points of notional.
 *
 * `pnl = Σ wᵢ · (p1ᵢ − p0ᵢ) / p0ᵢ`, with `wᵢ` already in bps, so the result is in bps too:
 * a 100% weight on an asset that gained 1% is 10000 × 0.01 = 100bps. Weight left unallocated
 * is cash and earns nothing, which is why the weights are not renormalised — the reference
 * allocator returning all zeroes means "nothing was above the mean, stay out", and a flat
 * result is the honest score for that.
 */
function pnlBps(weights, entry, exit) {
  if (weights.length !== entry.length || weights.length !== exit.length) {
    throw new Error(
      `allocation has ${weights.length} legs but ${entry.length} entry and ${exit.length} exit prices`
    );
  }

  let acc = 0n;
  for (let i = 0; i < weights.length; i++) {
    const p0 = BigInt(entry[i]);
    const p1 = BigInt(exit[i]);
    if (p0 <= 0n) throw new Error(`leg ${i} has a non-positive entry price`);
    acc += (BigInt(weights[i]) * (p1 - p0) * PREC) / p0;
  }
  return roundScaled(acc);
}

/**
 * Did the allocation stay inside its mandate?
 *
 * Conservative on purpose. `limitBreached` is the most expensive flag in the struct — it takes
 * quality to a fifth — and the Arena reports it only for the one thing it can genuinely see:
 * an allocation claiming more than the whole portfolio. Anything the Arena cannot check comes
 * back `false`, because a fabricated breach is a fabricated slash, and being wrong in that
 * direction costs an honest agent real money.
 */
function overAllocated(weights) {
  const total = weights.reduce((a, w) => a + BigInt(w), 0n);
  return total > 10_000n;
}

/**
 * The full outcome for one settled request.
 *
 * `deliveredAt`/`deliverBy` decide `slaBreached`. Note the narrowness: an agent that never
 * delivered at all never reaches settlement — the watchtower calls `markExpired` and the
 * request terminates as a liveness fault. This flag is only ever about the delivery that
 * arrived late, which on the current router cannot happen (`deliver` reverts past `deliverBy`)
 * and is checked anyway, because a parameter change that relaxes that is not this file's
 * business to assume away.
 */
function outcomeFor({ weights, entry, exit, deliveredAt, deliverBy }) {
  return {
    realizedPnlBps: pnlBps(weights, entry, exit),
    slaBreached: Number.isFinite(deliveredAt) && Number.isFinite(deliverBy) && deliveredAt > deliverBy,
    limitBreached: overAllocated(weights),
  };
}

/** One line per leg, for the settle log and the ledger's record of why it reported what it did. */
function explain(assets, weights, entry, exit) {
  return assets.map((asset, i) => {
    const p0 = BigInt(entry[i]);
    const p1 = BigInt(exit[i]);
    const retBps = roundScaled(((p1 - p0) * 10_000n * PREC) / p0);
    return {
      asset,
      weightBps: Number(weights[i]),
      entry: formatPrice(p0),
      exit: formatPrice(p1),
      returnBps: Number(retBps),
      contributionBps: Number(roundScaled((BigInt(weights[i]) * (p1 - p0) * PREC) / p0)),
    };
  });
}

module.exports = { PREC, PRICE_SCALE, roundScaled, pnlBps, overAllocated, outcomeFor, explain };
