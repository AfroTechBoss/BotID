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

### If the consumer is not a contract

A bot that is not on chain still needs the same answer, and should not have to run an RPC client
and an ABI decoder to get it. Three read-only endpoints, CORS-open, no key:

| Endpoint | Answers |
|---|---|
| `GET /api/agents` | Every registered agent, best first. `?minTier=silver&active=true&limit=10` |
| `GET /api/agents/:id` | One agent's full record — tier, bond, credit line, score, faults, last active |
| `GET /api/agents/:id/policy` | Whether it clears a hiring policy. Same query fields as the struct above |

```bash
curl 'https://…/api/agents/1/policy?minScore=8500&minTier=silver&maxFaults=0'
```

```json
{ "eligible": false, "verdictSource": "AgentRegistry.meetsPolicy",
  "failedCriteria": ["tier", "score"], "agent": { "tier": {"value":1,"name":"bronze"}, "score": 5121, … } }
```

`eligible` is `meetsPolicy` called on chain — the same function the Solidity above calls, so the
screen and the gate cannot disagree. `failedCriteria` is computed alongside it and is explanation,
not authority: the contract returns a bare boolean, and "no" without "why" is a closed door with no
sign on it. Every quantity is a base-unit string, because several exceed 2^53 and a JSON number
would round somebody's bond.

Reads are free. `?network=` takes an id or a chain id and defaults to testnet; an agent id that was
never issued is a 404 rather than a zeroed-out record.

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

## ABIs

`contracts/abi/` holds the consumer-facing ABIs as checked-in TypeScript, exported `as const` so
viem and wagmi can infer call and return types from them. `artifacts/` is a build product and is
gitignored, which is fine on a developer's machine and useless to anything that builds without a
checkout of this repo.

```bash
cd contracts && npm run export-abi   # regenerate
cd contracts && npm run check-abi    # fail if the committed output is stale
```

`check-abi` is the part worth wiring into CI. Without it, changing a contract signature and
forgetting to re-export turns into a decoding failure in someone else's frontend, at runtime,
with no obvious cause. With it, it is a build failure here that names the file.

Mocks, libraries and test harnesses are not exported. Neither is the bond token: this repo's
`IERC20` declares only the three functions `SafeTransfer` calls, so it has no `approve` and no
`decimals` — use viem's complete `erc20Abi` rather than an official-looking interface that cannot
approve a bond.

## Tests

255 tests across ten suites. They are organised around the attacks the design exists to
prevent, not just around function coverage:

| Suite | Covers |
|---|---|
| `ScoreMath` | Decay monotonicity and convergence, capital-weighted EWMA, the anti-grinding property, quality grading |
| `AgentRegistry` | Bond lifecycle, credit as bond × leverage × tier, unbonding, slashing, `meetsPolicy` |
| `InputAttestor` | Publisher quorum, freshness, ordering-based dedup, commitment binding |
| `Adapters` | All three tiers, plus every field of the execution context as a replay vector |
| `ExecutionRouter` | Full lifecycle, liveness faults, challenge escalation, fee floor, fee and exposure accounting |
| `LivenessGrief` | The griefing path: a consumer stalling an agent's capital by never finalising |
| `Calibration` | Whether the chosen constants actually work: a minimum-bond agent's credit line, how long it takes to climb, and what one execution or one counterparty can do to a history |
| `Decimals` | Every capital parameter against a 6-decimal bond token, where an 18-decimal default silently never binds |
| `eip712` | The typed-data envelope and domain separation — the same digest must not verify at a second adapter |
| `Timelock` | Queue, execute, expire, and the setters deliberately left immediate |

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
| `contracts/` | The protocol. Solc 0.8.24, no external dependencies, 255 tests |
| `contracts/abi/` | Consumer-facing ABIs as checked-in TypeScript. Generated, reviewed in diffs |
| `circuits/` | The Gold tier's ONNX model, `ezkl` pipeline, and the run/prove entrypoints |
| `relayer/` | Reference agent, watchtower and consumer. One dependency: `ethers` |
| `interface/` | The web interface and the read API. Next.js — see [`interface/README.md`](interface/README.md) |
| `docs/` | The architecture, and the four attacks it exists to prevent |

The interface shares this repository with the contracts rather than living in its own. It reads
their ABIs directly from `contracts/abi/`, so a contract change and the frontend change it forces
land in one commit and one review, and `npm run check-abi` can fail the build when they do not.
The interface is still not a dependency of the protocol: the contracts run whether or not anything
in `interface/` does.

## Status

Stages 1–3 of the build order in `docs/architecture.md` §8, less the subgraph and the dashboard.
The full lifecycle runs end to end on a local chain: request → deliver → challenge → escalate to
Gold → settle, plus the watchtower's liveness fault path. The circuit compiles, proves and
verifies against its own verifying key, and reproduces the integer reference exactly on every
calibration sample.

**Not audited, and not on mainnet.** The contracts are deployed to Bohr testnet (chain 968) and
the interface reads them live — every number it renders is contract state or a router log, and
there are no fixtures left in it. What is still missing is the part that matters: no subgraph, and
no consumer protocol reading `meetsPolicy` in production, which is the one thing that would tell
us whether any of this is worth having (§8).

The one open chain dependency is **resolved**: BOT Chain exposes the bn254 precompiles at `0x06`,
`0x07` and `0x08` at Istanbul prices on both mainnet (chain 677) and testnet (chain 968), so the
Gold tier can deploy. A three-pair Groth16 verify costs roughly 200–250k gas — about 5 cents at
the chain's flat 20 gwei. See [`docs/architecture.md` §7](docs/architecture.md) for the
measurements. `deploy.js` still probes rather than trusting them.

## License

**Business Source License 1.1** — see [`LICENSE`](LICENSE). The source is public; the protocol is
not open source, and the distinction is the point rather than a technicality.

| | |
|---|---|
| Read, audit, learn from, write about it | Free |
| Fork it, modify it, run it on a testnet | Free |
| Deploy it or a derivative to any mainnet | Commercial licence required |
| Run a service on it, or offer it to others | Commercial licence required |

The line is production, not payment: a licence is needed for mainnet or customer-facing use whether
or not you charge for it. Terms are per deployment — write to chidileozoemena@gmail.com.

Each version converts automatically to **MIT on 2030-08-13**, or four years after that version was
first published, whichever is sooner. That clause is not discretionary and cannot be extended,
which is the property that makes BUSL safe to build against: the worst case is a wait with a known
end date rather than an indefinite dependency on the licensor's goodwill.

Two caveats. Versions published before 2026-08-13 went out under MIT and **that grant stands** —
it cannot be withdrawn, and anyone holding those commits keeps their rights to them. And
`contracts/src/verifiers/Halo2Verifier.sol` is machine-generated by `ezkl` and regenerated on every
Hardhat run, so it carries its generator's licence rather than this one.
