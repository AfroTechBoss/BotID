# BotID Protocol

Verifiable execution and capital-weighted reputation for autonomous agents on BOT Chain.

Agents that manage capital need to be accountable for it. BotID gives them a bonded identity, a
verifiable record of what they executed, and a reputation score that is earned from settled
economic outcomes — then lets DeFi protocols gate capital on that score through a single read
call.

**Read [`docs/architecture.md`](docs/architecture.md) first.** It explains the design and, more
importantly, the four attacks the design exists to prevent.

---

## The short version

**Tiered verification.** Verification strength is an attribute of an agent's record, not a gate
on participation.

- **Bronze** — operator signature, bond-backed, challengeable. Any agent, any model.
- **Silver** — TEE attestation. LLM agents, arbitrary code, ~zero overhead.
- **Gold** — Groth16 proof from an `ezkl` circuit. Small numeric models, immediately final.

Bronze and Silver are made honest by **escalation**: anyone can post a bond and challenge a
delivery, and the agent must answer with a Gold-tier proof of the same execution or be slashed.
Near-ZK guarantees at near-zero cost in the happy path.

**Inputs are attested, not assumed.** A proof of inference shows a model ran on *some* inputs.
`InputAttestor` requires those inputs to be a publisher-quorum-signed bundle that hashes to the
commitment the *consumer* put in the request — so an agent cannot prove a flawless run over data
it invented.

**Reputation tracks outcomes, not proofs.** Invalid proofs revert and never land on chain, so
proof validity is constant across all agents and carries no signal. Score is a capital-weighted
EWMA over settled results, decayed toward neutral over time, with liveness and challenge faults
applied as direct haircuts.

**Credit is bounded by capital.** `maxOpenNotional = bond × leverage(score) × tierFactor`.
Reputation is a multiplier on posted capital, never a substitute for it — which is what bounds
what a farm of cheap Sybil identities can extract.

---

## Contracts

| Contract | Role |
|---|---|
| `AgentRegistry` | Identity, bond, unbonding, exposure limits, consumer read API |
| `ExecutionRouter` | request → deliver → challenge → finalize → settle lifecycle |
| `ReputationEngine` | Capital-weighted EWMA, time decay, fault ledger |
| `InputAttestor` | Publisher-quorum input bundles |
| `adapters/SignatureAdapter` | Bronze tier |
| `adapters/TeeAdapter` | Silver tier |
| `adapters/ZkAdapter` | Gold tier, `ezkl` verifier + public-signal binding |

## Consumer integration

```solidity
IReputationOracle oracle = IReputationOracle(REGISTRY);

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

bytes32 requestId = router.requestExecution(
    agentId, inputCommitment, notional, fee, deadline, inputURI
);
```

`inputURI` is emitted, never stored and never trusted — a commitment is not a locator, so the
agent needs somewhere to fetch the data from. It re-checks that what it fetched hashes to
`inputCommitment` before running anything.

## Fees

5% of every execution fee goes to the treasury on settle, plus the half of each slash that is
not paid out as a challenger bounty. Reads are free and always will be.

The fee is set by the consumer, so it is floored rather than left to the counterparties: `fee`
must be at least `minFeeBps` (default 10 bps) of `notional`, which makes the effective minimum
take **0.5 bps of notional** on every execution. `notional` is used because it is the one
quantity that is expensive to misreport in either direction — it is capped by the agent's
bond-derived credit and it is the weight of the score update. Zero-notional requests are exempt,
and the owner can set the floor to zero while bootstrapping.

See [`docs/architecture.md` §9](docs/architecture.md) — including an honest note on why "staking
revenue" and "oracle query fees" are not revenue.

## Build and test

```bash
cd contracts && npm install && npm test
```

Solc 0.8.24, `viaIR`, optimizer at 200 runs. The protocol contracts have no external
dependencies; Hardhat is used only to run the tests. `npm run compile` builds via a standalone
solc driver with no framework at all.

## Tests

140 tests across five suites. They are organised around the attacks the design exists to
prevent, not just around function coverage:

| Suite | Covers |
|---|---|
| `ScoreMath` | Decay monotonicity and convergence, capital-weighted EWMA, the anti-grinding property, quality grading |
| `AgentRegistry` | Bond lifecycle, credit as bond × leverage × tier, unbonding, slashing, `meetsPolicy` |
| `InputAttestor` | Publisher quorum, freshness, ordering-based dedup, commitment binding |
| `Adapters` | All three tiers, plus every field of the execution context as a replay vector |
| `ExecutionRouter` | Full lifecycle, liveness faults, challenge escalation, fee floor, fee and exposure accounting |

Tests worth reading as documentation of the redesign:

- *"rejects inputs the agent chose for itself"* — the garbage-in attack.
- *"cannot be ground upward by volume of dust the way a flat +10 could"* — why v0's scoring was
  free to farm.
- *"bounds a Sybil farm by total capital, not by identity count"* — ten minimum-bond identities
  get exactly the credit of one identity with ten times the bond.
- *"is not diluted by a large volume of clean executions"* — faults are not smoothed by volume.
- *"rejects a proof whose instances describe a different execution"* — a verifier returning
  `true` is not a proof of *this* request.

## The Gold circuit

`circuits/` holds the reference model, the `ezkl` pipeline that compiles it to a halo2 proving
key and an on-chain verifier, and the two entrypoints the relayer calls. `run.py` produces the
public instances; `prove.py` produces the proof.

```bash
cd circuits && python export_onnx.py && python pipeline.py
```

The relayer runs `run.py` at **every** tier, not just Gold. The output commitment goes on chain
at delivery, long before anyone asks for a proof, so an agent that computes its answer with a
separate implementation of the model has already committed to a number it may not be able to
prove — and finds out when it is challenged. Running the circuit everywhere makes the tiers
agree by construction instead of by review.

Two constraints shaped the reference model, both found by watching the circuit fail, and both
worth reading before writing a model of your own ([`circuits/README.md`](circuits/README.md)):
`ezkl`'s division compiles to a reciprocal lookup that silently returns zero when the divisor is
large — no error anywhere, every output `0` — and halo2 caps intermediates at 2^28, which is a
hard trade between fixed-point precision and input domain. `pipeline.py` refuses to hand over a
proving key it has not watched reproduce the integer reference on every calibration sample,
specifically so the first failure cannot ship.

## Run it

```bash
cd contracts && npx hardhat node
```

`deploy.js` takes `BOND_TOKEN` on any real network and derives every capital-denominated
parameter — `halfWeight`, `weightCap`, `minBond`, `globalNotionalCap`, `challengeBondAmount` —
from that token's `decimals()`, configured in whole tokens. The contracts' own defaults are
written in 18-decimal units, and the two ways that goes wrong are silent: too-large weights stop
the score moving at all, and a too-large challenge bond quietly makes Bronze and Silver
unchallengeable. Neither reverts, so the script derives them rather than trusting the deployer to
notice.

```bash
cd contracts && npx hardhat run scripts/deploy.js --network localhost && npx hardhat run scripts/seed.js --network localhost
```

```bash
cd relayer && npm install && cp .env.example .env && node src/index.js agent
```

Then commission work against it:

```bash
cd relayer && node src/index.js consumer request --agent 1 --notional 100000 --fee 100
```

The agent needs the circuit built first, because it runs it at every tier — see above, or set
`MODEL_RUNNER=reference` to use the JS port of the same function. See
[`relayer/README.md`](relayer/README.md) for the agent, watchtower and consumer roles.

## Layout

| Directory | What is in it |
|---|---|
| `contracts/` | The protocol. Solc 0.8.24, no external dependencies, 140 tests |
| `circuits/` | The Gold tier's ONNX model, `ezkl` pipeline, and the run/prove entrypoints |
| `relayer/` | Reference agent, watchtower and consumer. One dependency: `ethers` |
| `docs/` | The architecture, and the four attacks it exists to prevent |

## Status

Stages 1–3 of the build order in `docs/architecture.md` §8, less the subgraph and the dashboard.
The full lifecycle runs end to end on a local chain: request → deliver → challenge → escalate to
Gold → settle, plus the watchtower's liveness fault path. The circuit compiles, proves and
verifies against its own verifying key, and reproduces the integer reference exactly on every
calibration sample.

**Not audited and not deployed to any public network.** No subgraph, no frontend, and no
consumer protocol reading `getProfile` in production — which is the one thing that would tell us
whether any of this matters (§8).

The one open chain dependency is **resolved**: BOT Chain exposes the bn254 precompiles at `0x06`,
`0x07` and `0x08` at Istanbul prices on both mainnet (chain 677) and testnet (chain 968), so the
Gold tier can deploy. A three-pair Groth16 verify costs roughly 200–250k gas — about 5 cents at
the chain's flat 20 gwei. See [`docs/architecture.md` §7](docs/architecture.md) for the
measurements. `deploy.js` still probes rather than trusting them.
