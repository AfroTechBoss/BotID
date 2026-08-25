# BotID Arena

**Status: built.** The code is [relayer/src/arena/](relayer/src/arena/), the tests are
[relayer/test/arena.test.js](relayer/test/arena.test.js), and it runs as
`node src/index.js arena`. This document is the design, the two findings that changed it during
implementation (§5, §6), and the operational questions that code cannot answer (§11).

---

## 0. The one-paragraph version

A registered agent is a shop with the lights on and the door locked. It has a name, a bond in the
till, and a sign in the window — and until a customer walks in, none of that is evidence of
anything. The Arena is the protocol's first customer: a process that finds every registered agent,
orders work from it on a schedule, supplies the input data itself, waits for delivery, and then —
this is the part that matters — reports the *economic outcome* of that work back on chain. It is the
first configuration on this deployment where the party grading the work is not the party that did
it.

---

## 1. The map

| Piece | Where |
|---|---|
| Market data, rebasing, the domain check | [relayer/src/arena/market.js](relayer/src/arena/market.js) |
| P&L, SLA and limit arithmetic — no chain, no network | [relayer/src/arena/score.js](relayer/src/arena/score.js) |
| The persisted ledger that makes the two loops independent | [relayer/src/arena/ledger.js](relayer/src/arena/ledger.js) |
| Agent discovery and the eligibility filter | [relayer/src/arena/discovery.js](relayer/src/arena/discovery.js) |
| Both loops, preflight, output recovery | [relayer/src/arena/index.js](relayer/src/arena/index.js) |
| Settings | the `arena` block in [relayer/src/config.js](relayer/src/config.js), documented in [relayer/.env.example](relayer/.env.example) |

Commands:

```bash
node src/index.js arena status
```

`status` reads the chain and the ledger and prints what *would* be ordered and why every skipped
agent was skipped, without spending anything. `order` and `settle` run one loop each so they can be
restarted separately; `once` does a single pass of both, for cron; bare `arena` runs both loops.

### 1.1 Discovery was a reuse job, not a build job

`registeredIds()` in [interface/lib/registry.ts:96](interface/lib/registry.ts:96) already answered
"every agent id ever registered" by replaying `AgentRegistered` logs in bounded windows. The
windowing is not a performance tweak — a node that refuses an over-long range answers with *an
error, not a short list*, so an unwindowed query is code that works right up until the deployment is
old enough and then stops.

That logic is now ported into [discovery.js](relayer/src/arena/discovery.js) rather than shared,
because the interface is TypeScript in Next.js and the relayer is CommonJS Node. **They are siblings
and a change to one is a question about the other** — the port says so in a comment. One window
failing is caught per-window so it does not lose the other nineteen, and it logs, because a silently
short agent list looks identical to a quiet deployment.

`readAgents` asks `getProfile` for the credit line rather than recomputing it. `getProfile` derives
`maxOpenNotional` with the same private helper the registry uses to gate a reservation, so asking it
is asking the authority — and this codebase already keeps three copies of `toField`, which is enough.

---

## 2. Architecture: two loops, not one

The instinct is one loop that orders, waits, and settles. That is wrong for the same reason a
restaurant does not seat one table at a time: the wait dominates everything, and a single-threaded
waiter serves one customer an evening.

The protocol forces a wait. A request has a `deliverBy` deadline, then a challenge window before
`finalizeAt`, then a `settleBy` deadline. On the current deployment
[execute-once.js](contracts/scripts/execute-once.js) is split into two runs separated by roughly an
hour for exactly this reason — its own header calls it *"a relay baton, not a marathon: the state
lives in the file, not in the process."*

So the Arena is two independent loops over shared, persisted state:

```
  ┌──────────────────────── LOOP A: the order loop ───────────────────────┐
  │                                                                        │
  │  discover agents  ──▶  filter eligible  ──▶  pick notional             │
  │       (§1.1)              (§3)                  (§3)                   │
  │                                                    │                   │
  │                                    one market read for the whole batch │
  │                                          build input bundle (§4)       │
  │                                                    │                   │
  │                                          requestExecution()            │
  │                                                    │                   │
  │                                     record {requestId, agentId,        │
  │                                      readings, entry prices,           │
  │                                      orderedAt, holdUntil} ─────┐      │
  └─────────────────────────────────────────────────────────────────┼──────┘
                                                                    │
                                                           persisted ledger
                                                                    │
  ┌──────────────────────── LOOP B: the settle loop ────────────────┼──────┐
  │                                                                 ▼      │
  │  read ledger  ──▶  getRequest(id)  ──▶  status?                        │
  │                                          │                             │
  │      Pending / Delivered / Challenged  ──┤ not ours; the watchtower    │
  │                                          │ drives these (§7)           │
  │                                          │                             │
  │      Finalized ──▶ recover weights (§6) ──▶ measure (§5) ──▶ settle()  │
  │                                                                        │
  │      Settled / Expired / Faulted ──▶ close the row, log the result      │
  └────────────────────────────────────────────────────────────────────────┘
```

Loop B is `watchtower.js` with a different verb list, including its treatment of a revert as a
*warning* rather than an error, because losing a race is a success.

**The two loops are separately restartable.** They hold different state and fail for different
reasons: Loop A fails when the Arena is out of fee tokens; Loop B fails when the market-data source
is down. Collapsing them means one failure stops both, and a stalled Loop B means orders keep piling
up unsettled — the exact hostage situation `settleDefault` exists to break, except here the Arena
would be holding its own agents hostage.

**The ledger's rule, stated in its header:** *the settle loop may not consult the market for
anything it should have known at order time.* Entry prices, salts, readings and the hold deadline
are all written at order time. If Loop B could re-read an entry price, the Arena could grade an
agent against a number chosen after seeing the answer.

Rows are closed, never deleted. An operator who asks "why was my agent marked down" gets an answer.

---

## 3. Which agents, and how much

| Rule | Why |
|---|---|
| `active == true` | An unbonding or deactivated agent cannot take work. |
| `openNotional + size <= maxOpenNotional` | The registry will revert otherwise; better to not ask. |
| Not already holding an open Arena request | One open job per agent keeps failures attributable. |
| Cooldown since last Arena order | Round-robin, not a firehose at whoever registered first. |

Every rejection carries a `why`. "The Arena ordered nothing this pass" has half a dozen causes that
look identical from outside, and a loop that cannot tell you which is a loop nobody can debug at
three in the morning. Ordering is longest-waiting-first, so a quiet agent is not starved by whoever
registered earliest.

One bug worth recording, because the test caught it and it would have been invisible in production:
the cooldown check originally read `now - (lastOrdered.get(id) ?? 0) < cooldown`, which treats an
agent the Arena has **never** ordered from as one that has just been served. Those are opposite
answers to "wait your turn". It now checks `lastOrdered.has(id)` first.

**Notional sizing** is a fixed fraction of the agent's own `maxOpenNotional` (`ARENA_NOTIONAL_BPS`,
default 25%) rather than a constant. A constant either exceeds a small agent's credit line — the
order reverts — or is trivial against a large one, where the reputation weight is negligible because
scoring is capital-weighted. A fraction keeps every Arena job carrying comparable weight relative to
the agent's own book.

**Tier** is read but not filtered on. Bronze, Silver and Gold agents all take Arena work; the tier
changes what evidence the delivery carries, not whether the job is orderable.

---

## 4. Inputs

Today [consumer.js:51](relayer/src/consumer.js:51) hardcodes three numbers, and the comment is
candid that they were picked to *"put some feeds above the mean and some below, which is the only
thing the reference model reacts to."* That is a demo fixture. An Arena built on it would publish
the same prices forever, every agent would return the same allocation every time, and the
leaderboard would be an alphabetical list.

What the Arena builds instead:

1. **Real market readings** from `ARENA_PRICE_SOURCE` — `coinbase` (public, no key) or
   `fixture:./prices.json` for an offline dry run. Exactly `circuits/spec.json.feeds` assets, in a
   fixed order, because the order is part of what the model sees.
2. **Signed by a registered publisher.** `InputAttestor` verifies signatures against enrolled
   publisher addresses at a configured quorum. On localhost the key comes from the seed manifest;
   the Bohr manifest has no `seeded` block, so `PUBLISHER_KEY` must be set — **Q3** in §11.
3. **Salted, per reading.** The commitment is public the moment `requestExecution` lands, so an
   unsalted value is a published price and the agent could read its own graded inputs straight out
   of the commitment. The salt is the sealed envelope around the exam paper.
4. **Snapshotted into the ledger**, per §2.

One market read serves the whole batch, so every agent in a pass is graded against the same instant.
Two agents given prices ninety seconds apart are not competing in the same race.

**Key handling.** The Arena holds a consumer key *and* a publisher key in one process. That is
acceptable for a first-party Arena and it is exactly the concentration a third-party consumer would
not have — worth stating plainly here rather than discovering later.

---

## 5. Finding one: the readings cannot be prices

This is the discovery that changed the design, and it is two independent walls, either of which
alone is fatal.

**The domain wall.** `circuits/spec.json` caps a reading at `maxAbsValue: 300000` with
`decimals: 100` — 3000.00 units. BTC in cents is two orders of magnitude past that. Committing a raw
BTC price produces an input no circuit can run.

**The mean wall, which is worse.** The reference allocator gives equal weight to every feed *above
the bundle mean*. Feed BTC, ETH and SOL as raw tickers and BTC is above the mean of the three on
every day the sun rises. The model returns `[10000, 0, 0]` forever. It would look like it was
working. It would produce a leaderboard. The leaderboard would be measuring which asset is
nominally most expensive.

**The fix: rebased indices.** Each asset is expressed against *its own* price
`ARENA_LOOKBACK_HOURS` ago, with 100.00 meaning unchanged — the way the FTSE is a number about the
market's movement rather than the price of any share in it. A 3% gain is 103.00 whether the asset
costs eighty thousand dollars or eighty cents.

```js
const value = (now * INDEX_BASE) / then;   // INDEX_BASE = 100.00 at decimals: 100
```

This clears the domain cap and, more importantly, makes "above the mean" mean **"outperformed the
basket"**. That single substitution turns the reference allocator from a most-expensive-ticker
detector into a cross-sectional momentum allocator — a real, if simple, strategy. `indexOf` throws
rather than clamping if a reading lands outside the domain, because a thirtyfold move means the
source handed back garbage.

### 5.1 What `settle` reports

`settle` takes an `Outcome`: `realizedPnlBps` (signed), `slaBreached`, `limitBreached`. Reputation
moves on **settled economic results**, not on proof validity — a delivery with a flawless ZK proof
of a losing allocation is still a loss. And the asymmetry is deliberate: *profit is not rewarded,
breaches are punished.* A consumer cannot inflate an agent by reporting spectacular returns.

The chosen measurement is **paper trading with a public, tamper-evident record.** The money is
imaginary; the market is not. Snapshot at order time, hold `ARENA_HOLD_HOURS`, then compute what
those weights actually returned over the window against real prices. An agent that allocates into
something that then falls scores badly, and neither side can argue with the tape, because the entry
prices were committed on chain before anyone knew the answer.

Unallocated weight is **cash and earns nothing** — weights are deliberately not renormalised.
`[0, 0, 0]` from the allocator means "nothing beat the basket, stay out", and that has to score flat
rather than score as if the money had been invested anyway. Rounding happens once at the end, not
per leg, so three thirds of a position sum to the whole. All money arithmetic is `BigInt`.

**`ScoreMath.quality` cares far less about P&L than it looks.** Profit does nothing at all — quality
caps at `MAX_SCORE`. A loss inside the agent's declared `lossToleranceBps` does nothing either. Only
the excess beyond tolerance bites, reaching full penalty at twice tolerance. So the Arena is testing
each agent against **its own self-declared mandate**, not ranking returns.

The practical consequence is `ARENA_HOLD_HOURS`, defaulted to 24. Too short and no honest allocation
ever breaches anyone's declared tolerance, every quality lands at the cap, and the leaderboard
converges on one number — which is the "report zero" demo wearing a better hat. Preflight refuses a
hold that does not sit strictly between the router's challenge window and its settlement window,
both read from the chain at startup.

---

## 6. Finding two: outputs are never published

Grading the weights requires having the weights. `deliver` stores only `outputCommitment`, a
`bytes32`. The agent keeps `outputs` in memory and nothing puts them on chain. There is no field to
read.

**The fix: reproduce and verify.** The Arena wrote the inputs itself. It reads the agent's
`modelCommitment` from its registration, re-runs that model over those inputs via the same
`loadRunner` the agent uses, hashes the result with `commitOutputs`, and compares to what the agent
committed.

This is marking the exam by working the problem yourself and checking that the sealed answer
matches. A match recovers the weights **and** proves the agent actually ran the model it registered
— a stronger statement than reading a published number would have been, since a published number
proves only that the agent can type. A mismatch is a finding, recorded in the ledger; the Arena
reports, it does not challenge (§7). Runners are cached per model commitment, including a cached
`null` for a model the Arena has no runner for.

**Honest degradation.** A request the Arena cannot grade is never settled with a fabricated number.
The row is closed with a note and left for a watchtower's `settleDefault` to settle at par. Losing
the sample is the correct price; a made-up number is a permanent entry in someone's reputation.

The same discipline governs `slaBreached` and `limitBreached`, which are slashes:

- **`slaBreached`** — did the delivery land inside `deliverBy`? The chain knows; no opinion
  required. A *total* miss never reaches settlement at all — the watchtower calls `markExpired`.
  This is the late-but-delivered case. Unknown timestamps report `false`.
- **`limitBreached`** — did the allocation claim more than the whole portfolio? Weights summing past
  10000 is a mechanical breach. Anything the Arena cannot check reports `false`, because a
  fabricated breach is a slash on evidence that does not exist.

---

## 7. What the Arena does *not* do

It does not call `finalize`, `markExpired`, `slashUnresolvedChallenge`, or `settleDefault`. Those
belong to the watchtower, they are permissionless, and duplicating them means two processes racing
to pay gas for the same state transition.

**This makes the watchtower a hard dependency.** Nothing self-executes in `ExecutionRouter`. If no
watchtower is running against Bohr, deliveries never reach `Finalized`, Loop B never has anything to
settle, and the Arena orders jobs into a void and looks broken for a reason that has nothing to do
with the Arena. **Q4.**

The Arena also does not challenge. A first-party consumer that both orders work and challenges its
own agents' deliveries is grading with a thumb on the scale in the other direction.

---

## 8. Funding — the constraint nobody mentions

Every job escrows a fee, floored at `minFeeBps` of notional, paid from the Arena's balance to the
agent. **The Arena is a cost centre by construction.** That is correct — a customer that does not
pay is not a customer — but it bounds throughput.

On localhost this is free: `MockERC20.mint` is unrestricted. **On Bohr it is not.** The bond token
was supplied externally with 6 decimals and `deploy.js` refuses to deploy a mock on a non-local
network, so there is no mint to call. Throughput on Bohr is capped by a finite balance divided by
the per-job fee.

`ARENA_FEE_BUDGET` is therefore a configured ceiling checked *before* ordering rather than
discovered by a revert, and fees stay counted against it after settlement, because they were spent
either way. Notional sizing (§3) sets the burn rate directly, since the fee floor is a fraction of
notional. **Q2** is how much of that token the Arena wallet actually holds.

---

## 9. Verification

`npm test` in `relayer/` runs 18 tests covering price parsing, rebasing, the domain refusal, the
fixture source, weighted P&L (including cash-is-flat and round-once), the SLA and limit flags,
per-leg attribution, ledger round-tripping and truncation, log windowing, and every eligibility
rejection. They are pure — no chain, no network.

Beyond the suite, three checks were run by hand:

- **Offline, end to end.** Indices `[10300, 9900, 10500]` → weights `[5000, 0, 5000]`, the
  commitment reproduced exactly, `pnlBps 350`.
- **Live snapshot.** Coinbase: BTC 79820.445 → index 10303, ETH 2494.085 → 10205, SOL 100.445 →
  10621.
- **Live allocation.** BTC 10305, ETH 10208, SOL 10617 → weights `[0, 0, 10000]`. SOL was the only
  asset above the basket mean and took the whole allocation. Real dispersion, non-degenerate — which
  is the proof that §5's rebasing does actual work, because the same run on raw tickers would have
  returned `[10000, 0, 0]`.

---

## 10. Alternatives that were rejected

**Report zero — the trap.** Settle everything with `realizedPnlBps: 0`. It *looks* like it works:
executions climb, the activity feed fills, `settledExecutions` accumulates. And every score drifts
to neutral, because a capital-weighted EWMA fed a constant converges on that constant. You would
have built a machine that runs thousands of jobs and cannot say which agent is better. Worse, it is
not neutral in effect — it *dilutes* any real signal an agent earned from a genuine counterparty,
because the Arena out-volumes real usage by orders of magnitude. That is a demo, not an arena.

**Deploy real capital.** Execute each agent's allocation in real markets and report actual P&L.
Honest and unimpeachable; also expensive, slow, and it turns a keeper process into a trading desk
with venue integration and risk controls. The right long-term answer and the wrong next step.

The costs of the option that was built are worth naming too. A market-data source is now a
dependency of settlement: if it is down at settle time the request waits, and if it waits past
`settleBy` the Arena loses the sample to `settleDefault` — which §6 accepts deliberately, preferring
late-but-correct over on-time-but-fabricated. And the hold period must be held fixed across agents,
because varying it is a thumb on the scale.

---

## 11. Still open — operational, not code

**Q2. What is the fee budget on Bohr?** Determines jobs per day, and whether this runs for a week or
a month. `ARENA_FEE_BUDGET` enforces whatever the answer is; nothing knows the answer yet.

**Q3. Which publisher addresses are enrolled in `InputAttestor` on Bohr, and at what quorum?** Not
recorded in the manifest. **Blocking.** If the Arena does not hold an enrolled publisher key it
cannot build a valid bundle, and nothing else here matters.

**Q4. Is a watchtower running against Bohr?** If not, that is a prerequisite, not a footnote — §7.

**Bundle hosting.** Without `ARENA_BUNDLE_BASE_URL` the Arena emits a bare bundle name, which only
resolves for an agent sharing this filesystem. Preflight warns. A remote agent needs the URL.
