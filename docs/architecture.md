# BotID Protocol — Revised Architecture

Verifiable execution and capital-weighted reputation for autonomous agents on BOT Chain.

This document supersedes the original "Decentralized Verifiable Inference & Agent Reputation
Protocol" draft. It keeps the thesis and replaces the mechanism.

---

## 1. What changed and why

The original design had four load-bearing assumptions that don't hold. Each one is addressed
by a specific mechanism below.

| # | Problem in v0 | Consequence | Fix in v1 |
|---|---|---|---|
| 1 | A ZK proof of inference proves the *model ran*, not that *inputs were honest* | Agent feeds itself fabricated prices, gets a valid proof, executes a valid-looking theft | **Input attestation.** `inputCommitment` must be a quorum-signed bundle from registered publishers, and it is bound into the proof's public signals |
| 2 | Reputation scored on proof validity | Invalid proofs never land — they revert. Every agent scores 100%. Zero information content | **Outcome-based scoring.** Score is driven by settled economic results, SLA breaches and liveness faults, not by proof pass/fail |
| 3 | `submitVerifiedInference` was permissionless, replayable, unbound | Anyone pumps any agent's score; same proof resubmitted 1000× | **Request-bound lifecycle.** Every execution originates from an on-chain request with a unique id, a consumer, a deadline and a fee. Every attestation is bound to `(requestId, agentId, modelCommitment, inputCommitment, outputCommitment, deliverBy)` — by signature at Bronze/Silver, by on-chain instance pinning at Gold (§4) |
| 4 | Credit unlocked by score alone; identity cost 500 tokens | Sybil: farm 20 cheap identities, build scores, rug simultaneously | **Capital-bounded credit.** `maxOpenNotional = f(bond) × leverage(score, tier)`. Score can only ever be a *multiplier* on capital actually at risk, never a substitute for it |

Two further changes are strategic rather than corrective:

- **Tiered verification instead of ZK-only.** ZK-ML today proves small numeric models. It cannot
  prove LLM-driven agents at any price. A ZK-only protocol addresses a sliver of the market.
- **Insurance vault cut from v1.** Pricing agent risk is an actuarial product in its own right.
  The staked bond already provides skin in the game. Ship the vault when there is a book of
  settled outcomes to price against.

---

## 2. Verification tiers

Verification strength is an **attribute of the agent's record**, not a gate on participation.
Consumers set their own policy thresholds.

| Tier | Mechanism | Latency | Covers | Finality |
|---|---|---|---|---|
| **Bronze** | Operator EIP-712 signature over the execution commitment, backed by bond | ~0 | Any agent, any model | Optimistic — challengeable |
| **Silver** | TEE attestation (Nitro / SGX / Phala): enclave key signature + measurement allowlist | ~0 | LLM agents, arbitrary code | Optimistic — challengeable |
| **Gold** | Groth16 proof from an `ezkl`-compiled circuit | seconds–minutes | Small numeric models (MLP, GBDT, logistic) | Immediate, final |

**Challenge escalation** is what makes Bronze and Silver economically meaningful. After delivery,
a Bronze/Silver execution sits in a challenge window. Anyone may post a bond and challenge it.
The agent must then produce a **Gold-tier proof for the same `requestId`** before the escalation
deadline, or be slashed and have the challenger paid from the slash.

This gives near-ZK guarantees at near-zero cost in the happy path — which is essentially all
paths — while keeping the cryptographic backstop real.

Consequence for agent design: an agent that wants Silver/Bronze economics must still be *able*
to produce a Gold proof of its decision function on demand. That is a much weaker requirement
than proving every execution.

---

## 3. Component map

```
                          ┌──────────────────────────────┐
   consumer protocol ────▶│      ExecutionRouter         │
   (BDEX pool, vault,     │  request → deliver → finalize│
    treasury, dApp)       │  → settle | challenge | expire│
                          └───┬────────┬─────────┬────────┘
                              │        │         │
              reserve/release │        │ verify  │ record outcome
                    & slash   │        │         │
                              ▼        ▼         ▼
                    ┌──────────────┐ ┌────────┐ ┌──────────────────┐
                    │ AgentRegistry│ │Adapters│ │ ReputationEngine │
                    │ bond, tier,  │ │ Bronze │ │ capital-weighted │
                    │ model hash,  │ │ Silver │ │ EWMA + decay     │
                    │ exposure,    │ │ Gold   │ │ fault ledger     │
                    │ unbonding    │ └───┬────┘ └────────┬─────────┘
                    └──────────────┘     │               │
                                         ▼               ▼
                                 ┌──────────────┐  IReputationOracle
                                 │ InputAttestor│  (read API for
                                 │ feed quorum  │   DeFi consumers)
                                 └──────────────┘
```

---

## 4. Execution lifecycle

### Phase A — Registration

1. Developer registers an agent: `(owner, operator key, modelCommitment, tier, bond)`.
2. `modelCommitment` names the model — `keccak256(utf8(name))`, versioned in the name itself. It
   is immutable for the life of the agent id. Every field of the model's spec (feed count, output
   count, fixed-point scale, input domain) changes the circuit and the verifying key, so a model
   change means a new commitment and a new agent id: reputation earned by one model is not
   inherited by a different one wearing its name.
3. Bond is locked. Withdrawal enters a **21-day unbonding queue**, so an agent cannot exit
   ahead of the settlement of its own outstanding executions.

### Phase B — Request

A consumer protocol calls `requestExecution(agentId, inputCommitment, notional, fee, deliverBy)`.

The router:
- checks the agent is active and not in unbonding,
- checks `openNotional[agentId] + notional <= maxOpenNotional(agentId)` — **this is the Sybil
  bound**,
- escrows the fee,
- reserves `notional` against the agent's exposure budget,
- emits a request with a unique, chain-bound `requestId`.

`inputCommitment` is supplied by the *consumer*, not the agent. The agent cannot choose its
own inputs.

### Phase C — Delivery and verification

The agent's operator calls `deliver(requestId, outputCommitment, attestation)` before `deliverBy`.

The router:
1. Verifies the input bundle against `InputAttestor` — publisher quorum, freshness relative to
   the moment the request was created, and `keccak256(bundle) == inputCommitment`.
   **This closes the garbage-in hole.**
2. Dispatches to the adapter for the agent's tier with a canonical context:
   `(requestId, agentId, modelCommitment, inputCommitment, outputCommitment, deliverBy)`.
3. Requires the adapter to bind that context into whatever it checks. A proof for a different
   model, a different request, or stale inputs cannot validate.
4. Sets `finalizeAt = now + challengeWindow` for Bronze/Silver; Gold finalizes immediately.

**How each tier binds the context.** Bronze and Silver bind it by signing it, as EIP-712 typed
data:

```
structHash = keccak256(EXECUTION_TYPEHASH ‖ requestId ‖ agentId ‖ modelCommitment
                       ‖ inputCommitment ‖ outputCommitment ‖ deliverBy)
digest     = keccak256(0x19 0x01 ‖ domainSeparator ‖ structHash)
```

with the domain `{name: "BotID", version: "1", chainId, verifyingContract}`. The chain id and the
adapter address are in the domain rather than the struct — which is where EIP-712 puts them, and
which is why they still bind exactly as tightly as before: a Bronze signature cannot be replayed at
the Silver adapter, or on another chain. The `\x19\x01` envelope buys two further things. A signer
can *render* what it is agreeing to, so an operator approving a delivery sees a request id and a
deadline instead of one opaque word. And a key that signs bare 32-byte hashes has given up the
guarantee that its signatures cannot also be transactions; the `\x19` prefixes exist to keep those
two signable spaces disjoint.

Gold binds it **on chain rather than in the circuit**, which is a correction to the original
design. The obvious construction puts `inputCommitment` and `outputCommitment` in the proof's
public signals. It cannot be built: both are `keccak256` commitments, and a halo2 circuit cannot
compute keccak over an ABI encoding without a gadget `ezkl` does not expose — proving one would
cost more than the model. So the circuit exposes only what it natively has, its own input and
output tensors:

```
instances[0 .. nIn)          model input tensor  = value << inputScaleBits
instances[nIn .. nIn + nOut) model output tensor
```

and `ZkAdapter` pins that vector to the request itself. It re-derives `inputCommitment` from
opened feed values and requires the circuit's input cells to be exactly those values; it hashes
the output cells and requires the result to equal the `outputCommitment` being delivered under.
Keccak costs 6 gas a word here, and the check runs against the router's own storage instead of
against a number the prover chose — cheaper *and* stronger than the in-circuit version.

`requestId` and `agentId` are absent from the instances deliberately. A proof is only reusable
across two requests that share a model, an input commitment *and* an output commitment, and for
those two requests it asserts the identical, true statement.

**Revealing inputs.** A bundle commits to `valueHash`, not to a number, so the circuit's input
cells cannot be compared to it directly. The protocol fixes the preimage:

```
valueHash = keccak256(abi.encode(int256 value, bytes32 salt))
```

`value` is a whole number at the model's declared decimal scale. The salt matters because an
input commitment is public from the moment the request is made — without it, the values are
recoverable by anyone willing to guess, including the agent being graded on them. A Gold
attestation is therefore `abi.encode(bytes proof, uint256[] instances, Reveal[] reveals)`, and
`nIn` is the length of `reveals` — so the split between inputs and outputs is fixed by the
consumer's own commitment rather than by the party being checked.

**The fixed-point shift** is registered per model, alongside the verifier. It cannot be inferred
from the proof, and it cannot be zero for any interesting model: at scale 0 a division's
reciprocal quantises to zero and the circuit silently computes nothing at all — it compiles,
`setup` succeeds, proofs verify, and every output is `0`. Making the shift a registration
parameter is what lets the Gold tier accept models that divide. A wrong shift is a liveness
failure rather than a security one — every honest proof for that model is rejected until the
owner corrects it — which is the safe direction to fail in.

### Phase D — Challenge (Bronze/Silver only)

- `challenge(requestId)` — anyone, posting `challengeBond`, before `finalizeAt`.
- `resolveChallenge(requestId, attestation)` — the agent submits a Gold-tier proof.
  On success the challenger's bond is forfeited to the agent, and the execution finalizes at
  Gold. This makes frivolous challenges costly.
- `slashUnresolvedChallenge(requestId)` — after the escalation deadline with no valid proof, the
  agent is slashed. The challenger receives their bond plus a bounty; the remainder goes to
  the protocol treasury. The execution is recorded as a **fault**.

### Phase E — Settlement

The consumer (or a settlement adapter it authorises) calls `settle(requestId, outcome)` within
the settlement window. The outcome carries:

- `realizedPnlBps` — signed, relative to the notional,
- `slaBreached` — delivery was late or out of spec,
- `limitBreached` — the execution exceeded the agent's declared risk limits.

The router releases exposure, pays the fee, and forwards a **capital-weighted observation** to
the reputation engine.

If nothing is delivered by `deliverBy`, anyone calls `markExpired(requestId)`: the fee is
refunded, exposure released, and a **liveness fault** is recorded against the agent. This is
the signal the v0 design was missing entirely — non-delivery, not invalid proofs, is how
agents actually fail.

For that fault to mean "the agent broke its word" rather than "the agent was named in a request",
acceptance has to be something the agent actually did. Two rules make it so. `requestExecution`
enforces `minDeliveryWindow` (15 min), so a deadline is never one no operator could meet. And the
operator may call `reject(requestId)` within `rejectionWindow` (5 min) of the order, closing it
with no fault and no slash.

Both are needed because `inputCommitment` is unverifiable at request time — it is a bare hash, and
`requestExecution` is permissionless. Without the right to decline, anyone could commission
impossible work from any active agent, call the permissionless `markExpired` themselves, and take
`challengerBountyBps` of the slash for the price of gas. The rejection window is deliberately much
shorter than the delivery window: declining is a decision made at order time, not an escape hatch
an agent can reach for once it can see the job going badly.

---

## 5. Scoring

Score is a **capital-weighted EWMA over settled outcomes**, decayed toward neutral over time.

```
w      = min(notional, weightCap, budget(agent, consumer))  // capital at risk, twice capped
q      = quality(outcome) ∈ [0, 10000]                      // per-execution quality
score' = decay(score, Δt) + (q − decay(score, Δt)) · w / (w + K)
```

Four properties fall out of this, all of them deliberate:

1. **A $100k execution moves the score far more than a $10 one.** `K` is the "half-weight"
   constant — the notional at which a single observation moves the score halfway to `q`.
   Grinding 500 dust transactions to reach a high score no longer works.
2. **Inactivity reverts the score toward neutral (5000)** with a configurable half-life. A
   reputation earned two years ago is not tradeable today, which also limits the value of a
   dormant Sybil farm.
3. **Faults are not smoothed.** A liveness fault or a lost challenge applies a direct
   multiplicative haircut *and* increments a permanent fault counter that consumers can read
   independently of the score.
4. **No single counterparty can define a score.** `settle` is unilateral — the consumer reports
   the outcome — and the consumer also chooses the `notional` that outcome is weighted by. So the
   damage of a false report scales with a number the liar picks, while the cost is `minFeeBps` of
   it; raising the fee floor cannot close a gap the attacker scales both sides of. Instead each
   consumer draws from a per-agent weight budget, `consumerWeightCap`, defaulting to half of `K`:
   one counterparty moves a score at most a third of the way toward its claimed quality, and the
   budget refills on the same half-life the score decays on. Both earning a reputation and
   destroying one therefore take several independent counterparties rather than one determined
   one — which is what a reputation was always supposed to mean.

`quality()` is a pure function of the outcome — full marks for clean delivery within limits,
graded penalties for SLA breach, limit breach, and losses beyond the agent's declared
tolerance. It deliberately does **not** reward raw P&L linearly: that would reward risk-taking
with other people's capital.

### Credit

```
maxOpenNotional(agentId) = bond × leverage(score, tier) / 1e4
```

`leverage` is a step function of score, multiplied by a tier factor (Gold > Silver > Bronze),
and hard-capped globally. Undercollateralised capacity is therefore always a *multiple of
posted capital* — never a substitute for it. An attacker's maximum extractable value is bounded
by their own bond times the leverage cap, which is the property the v0 design lacked.

---

## 6. Consumer integration

DeFi protocols integrate against one read interface, `IReputationOracle`:

```solidity
Profile memory p = oracle.getProfile(agentId);
// p.score, p.tier, p.bond, p.maxOpenNotional, p.openNotional,
// p.settledExecutions, p.faults, p.lastActiveAt

require(
    oracle.meetsPolicy(agentId, Policy({
        minScore: 8500,
        minTier: Tier.Silver,
        maxFaults: 0,
        minBond: 50_000e18,
        maxStalenessSeconds: 7 days
    })),
    "agent not eligible"
);
```

Policies are expressed by the consumer, not dictated by the protocol. A conservative vault sets
`minTier: Gold`; a prediction market might accept Bronze with a low notional ceiling.

---

## 7. Chain dependency — resolved

Groth16 verification requires the bn254 precompiles at `0x06` (add), `0x07` (mul) and `0x08`
(pairing), at standard gas metering. This was the one open dependency gating the Gold tier.

**Confirmed present on both BOT Chain networks, at Istanbul (EIP-1108) prices**, probed
2026-08-09 against `https://rpc.botchain.ai` (chain 677) and `https://rpc.bohr.life` (chain 968):

| Precompile | Result | Gas |
|---|---|---|
| `0x08` pairing, empty input | returns `1` | ~45,000 base |
| `0x07` ecMul | returns the point at infinity | ~6,000 |
| `0x06` ecAdd | returns the point at infinity | ~150 |
| `0x05` modexp | correct | — |

Istanbul pricing, not the pre-Istanbul 100,000/40,000 — a three-pair Groth16 verify lands around
200–250k gas. At the chain's flat 20 gwei and BOT near $9.74, that is roughly **5 cents per Gold
verification**, against about 0.4 cents for a plain transfer.

That is cheap enough to ship and expensive enough to matter. It does not change the design — the
optimistic tiers exist precisely so that the common path never pays it — but it is a real input
to the fee floor (§9) on small notionals, and it should be re-measured before mainnet deployment
rather than assumed to hold.

`deploy.js` still probes rather than trusting this table. A chain can be repriced; a deploy
script that checks costs nothing.

Bronze and Silver never had this dependency and ship regardless.

---

## 8. Build order

| Stage | Scope | Ships | State |
|---|---|---|---|
| 1 | `AgentRegistry`, `ExecutionRouter`, `SignatureAdapter`, `ReputationEngine`, `InputAttestor` | Bronze tier end to end, real bonds, real faults | built |
| 2 | `TeeAdapter`, challenge/escalation resolution, `IReputationOracle` read API | Silver tier + one integration partner consuming scores | built, no partner |
| 3 | `ZkAdapter` + `ezkl` pipeline, subgraph, dashboard | Gold tier and public leaderboard | circuit and adapter built; no subgraph, no dashboard |
| 4 | Insurance vault | Only once there is a settled-outcome book to price | not started |

The gating question for stage 1 is not technical. It is whether a consumer protocol will
actually call `getProfile` in production. If nothing reads the score, nothing else matters. That
question is still open, and no amount of stage-3 work answers it.

The Gold circuit's two structural constraints — `ezkl`'s division is a reciprocal lookup that
silently returns zero when the divisor is large, and halo2 caps intermediates at 2^28 — shape
what a provable model can be, and are documented in [`circuits/README.md`](../circuits/README.md).

---

## 9. Fees and protocol revenue

Two lines exist in the contracts today. One of them is real revenue; the other is not something
to plan around.

| Line | Parameter | Flows to | Character |
|---|---|---|---|
| Take rate on execution fees | `protocolFeeBps = 500` (5%) | `treasury`, on settle | Recurring, scales with usage |
| Slash residue | `100% − challengerBountyBps` (50%) of every slash | `treasury` | Lumpy, adversarial, **shrinks as the protocol works** |

The take rate is floored, not merely nominal — see below. At the shipped defaults the protocol
earns at least `protocolFeeBps × minFeeBps` = 5% × 10 bps = **0.5 bps of notional** on every
execution, whatever the counterparties agree to call the fee.

Slash residue is the wrong thing to budget against. It only appears when an agent fails, so
maximising it means maximising failure — and if the incentives work, it trends toward zero. Treat
it as a fund for the insurance vault in stage 4, not as income.

### What the v0 tokenomics counted that does not exist

**Reputation staking is not revenue.** Bonds are collateral. They sit in `AgentRegistry`, they
are returned on unbonding, and the protocol earns nothing for holding them. Bonds are TVL and a
security parameter, not a P&L line. Lending them out to generate yield would put the slashing
guarantee behind a liquidity assumption, which is the one thing the bond exists to avoid.

**API / oracle query fees cannot be charged.** `getProfile`, `getScore` and `meetsPolicy` are
`view`. Off-chain callers read them by `eth_call` for free, and on-chain callers pay gas to
validators, not to the treasury. There is no point in the design where a read can be metered,
and adding one would defeat the purpose — a reputation oracle nobody can cheaply read is a
reputation oracle nobody integrates. A hosted API with history, webhooks and SLAs is a viable
business, but it is a company's revenue, not the protocol's, and anyone can undercut it by
indexing the same public events.

### The fee floor

`fee` is chosen freely by the consumer, so a 5% cut of it is a cut of a number the two
counterparties jointly control. Left unfloored, a consumer and an agent who know each other set
`fee = 0`, settle the real payment off chain, and take the full protocol service for nothing.

`ExecutionRouter.minFeeBps` (default **10 bps**) prices the work against something they cannot
quietly agree away:

```solidity
if (fee < (uint256(notional) * minFeeBps) / 10_000) revert FeeBelowFloor();
```

`notional` is the one quantity in a request that is expensive to misreport in *either*
direction. It is capped by the agent's bond-derived credit, and it is the weight of the score
update — so understating it forfeits reputation gain, and overstating it consumes the agent's
own credit. Neither party can move it to dodge the floor without paying for the move elsewhere.

Two deliberate escapes:

- **Zero notional is free.** Nothing is at risk, so there is nothing to price against. Dry runs
  and integration tests cost only gas.
- **`setMinFeeBps(0)` disables the floor**, which is the right setting on testnets and during
  bootstrapping, when the goal is integrations rather than income.

The setter is separate from `setParameters` and capped at 1,000 bps. A floor near 100% of
notional is not a fee, it is a halt — and it would brick `requestExecution` in a way that reads
as an unrelated bug. Keeping it off the eight-argument parameter call also means changing one
economic number does not require restating every safety window correctly.
