# BotID Protocol — About

A running record of questions asked and the answers given, kept verbatim rather than summarised.
Destined for a Google Doc of the same name; maintained here because this session has no Google
Docs connector.

Sources of truth for every factual claim below: `README.md`, `docs/architecture.md`,
`contracts/src/`, `circuits/`, `relayer/`. Where the answer states a number or a mechanism, it
came from those files, not from memory.

---

## Q1 — Explain BotID to me as if I know nothing, in the voice of the head developer

*Asked: 10 Aug 2026.*

### The problem, in one paragraph

Software agents are starting to move real money — rebalancing a lending pool, routing a trade,
setting a price. If you run a protocol with a treasury, the question you actually face is not
"is this agent clever?" It is: **if I hand this thing $2 million of other people's capital, what
happens to me when it is wrong, or lying, or simply gone?** Today you have no way to answer
that. An agent is an API endpoint and a Twitter account. It has no track record you can verify,
nothing at stake if it fails, and no identity that survives being caught. So the only safe
policy is the one everybody uses: don't let agents touch anything that matters.

BotID exists to make that question answerable. It gives an agent three things it cannot fake:

1. **A bonded identity** — capital locked up, forfeitable, tied to one specific model.
2. **A verifiable record** — every job it did, with cryptographic evidence of what it was asked
   and what it answered.
3. **A score earned from settled outcomes** — not from reviews, not from self-reporting.

And then it lets a DeFi protocol gate access to capital on all three, in a single read call.

### Why the obvious answers don't work

**"Just make the agent prove its computation with a ZK proof."** This was our own v0 design, and
it is where the interesting part starts. A zero-knowledge proof of inference proves the model
ran correctly *on the inputs it was given*. It says nothing about whether those inputs were
real. An agent can invent a price feed showing ETH at $12, run its model flawlessly on that
fiction, produce a perfectly valid proof, and execute a trade that drains you. The proof is
genuine. The theft is genuine too.

So inputs have to be nailed down independently, and that is what `InputAttestor` does: the
inputs must be a bundle signed by a quorum of registered publishers, and the hash of that
bundle is supplied by the **consumer** in the original request. The agent cannot choose its own
inputs. It can only prove it ran on the data you specified.

**"Score agents on whether their proofs are valid."** Also v0, also wrong, and this one is
almost funny. Invalid proofs revert — they never make it onto the chain. So every agent that has
ever landed anything has a 100% proof-validity record. The metric carries exactly zero
information. What actually kills agents in production is *not delivering* and *losing money*, so
that is what the score has to be built from.

**"ZK-only, for everything."** ZK-ML today can prove a small numeric model — a little neural
net, a gradient-boosted tree, a logistic regression. It cannot prove an LLM-driven agent at any
price. A protocol that demands proofs for everything serves a sliver of the market and locks out
the agents people are actually building.

### The core idea: three tiers of evidence, made honest by money

Instead of one standard of proof, there are three, and **the tier is a property of the record,
not a gate on entry**. Anyone can participate; the consumer decides what they will accept.

| Tier | What the evidence is | Plain-English version |
|---|---|---|
| **Bronze** | Operator EIP-712 signature over the execution, backed by bond | "I signed a receipt saying this is what I did, and I have money on the line." |
| **Silver** | TEE attestation — enclave key signature plus a measurement allowlist | "It ran inside a sealed box, and the box's chip signed that the code inside was unmodified." |
| **Gold** | Groth16 proof from an `ezkl`-compiled circuit | "Here is mathematical proof the exact model produced exactly this output." |

Bronze and Silver are instant and effectively free. Gold takes seconds to minutes of proving and
is final the moment it lands.

Now the part that makes the cheap tiers mean anything — **challenge escalation**. When a Bronze
or Silver execution is delivered, it sits in a challenge window. Anyone at all can post a bond
and challenge it. The agent then has to produce a **Gold-tier proof for that same request**
before the escalation deadline. If it does, the challenger's bond is forfeited to the agent — so
frivolous challenges cost you. If it doesn't, the agent is slashed, the challenger is paid a
bounty out of the slash, and a permanent fault is recorded.

The analogy I use: nobody weighs every lorry, but any lorry can be pulled onto the weighbridge,
and running overweight is ruinous when you're caught. You get near-ZK guarantees at near-zero
cost in the happy path — which is nearly every path — while the cryptographic backstop stays
real.

There's a consequence for agent builders worth being explicit about: to earn Bronze or Silver
economics you must still be *able* to prove your decision function on demand. That is a far
weaker requirement than proving every single execution.

One design detail I'm proud of, because it makes the tiers agree by construction rather than by
review: the reference agent runs the circuit at **every** tier, not just Gold. The output
commitment goes on chain at delivery, long before anyone asks for a proof. An agent that
computes its answer with some separate implementation of the model has therefore already
committed, publicly, to a number it may not be able to prove — and it finds out when it is
challenged.

### The score: earned from outcomes, weighted by capital

Score is a capital-weighted EWMA over settled outcomes, decayed toward neutral over time:

```
w      = min(notional, weightCap)          // capital actually at risk, capped
q      = quality(outcome) ∈ [0, 10000]     // graded quality of this one execution
score' = decay(score, Δt) + (q − decay(score, Δt)) · w / (w + K)
```

Three deliberate properties fall out of that:

1. **Size matters.** A $100k execution moves the score far more than a $10 one. `K` is the
   half-weight constant — the notional at which one observation drags the score halfway to `q`.
   Grinding 500 dust transactions to a high score does not work.
2. **Reputation decays.** Sit idle and your score reverts toward neutral (5000) on a
   configurable half-life. A reputation earned two years ago is not tradeable today, which also
   makes a dormant Sybil farm worth very little.
3. **Faults are not smoothed away.** A liveness fault or a lost challenge applies a direct
   multiplicative haircut *and* increments a permanent counter consumers can read separately
   from the score. You cannot bury a failure under a thousand clean executions.

And `quality()` deliberately does **not** reward raw P&L linearly — that would pay agents to
gamble with other people's capital. It gives full marks for clean delivery inside declared
limits and graded penalties for SLA breach, limit breach, and losses beyond declared tolerance.

### Credit is bounded by capital, always

This is the single most important line in the protocol:

```
maxOpenNotional(agentId) = bond × leverage(score, tier) / 1e4
```

Reputation is a **multiplier on capital you have actually posted** — never a substitute for it.
`leverage` is a step function of score times a tier factor (Gold > Silver > Bronze), hard-capped
globally.

Why it matters: the v0 design unlocked credit on score alone, and identity cost about 500
tokens. So the attack was trivial — spin up twenty cheap identities, farm each one's score with
small honest jobs, then rug all twenty at once. Under the new rule, ten minimum-bond identities
get exactly the credit of one identity with ten times the bond. An attacker's maximum extractable
value is bounded by their own capital at risk. There is one of our tests I'd point a sceptic at
first: *"bounds a Sybil farm by total capital, not by identity count."*

Two supporting details: the bond enters a **21-day unbonding queue** on withdrawal, so an agent
cannot exit ahead of the settlement of its own outstanding executions. And `modelCommitment` is
immutable for the life of an agent id — change any field of the model's spec and you need a new
circuit, a new verifying key, and a new agent id. Reputation earned by one model is not
inheritable by a different model wearing its name.

### A whole job, start to finish

A lending vault wants an agent to rebalance $100k of exposure.

1. **Register** — developer registers the agent: owner, operator key, `modelCommitment`, tier,
   bond. Bond is locked.
2. **Request** — the vault calls `requestExecution(agentId, inputCommitment, notional, fee,
   deliverBy)`. The router checks the agent is active and not unbonding, checks
   `openNotional + notional <= maxOpenNotional` (**this is the Sybil bound**), escrows the fee,
   reserves the exposure, and emits a unique chain-bound `requestId`.
3. **Deliver** — the agent fetches the input bundle, re-checks it hashes to `inputCommitment`,
   runs the model, and calls `deliver(requestId, outputCommitment, attestation)`. The router
   verifies the bundle against `InputAttestor` — publisher quorum, freshness relative to when
   the request was created, hash match — then verifies the attestation through the tier's
   adapter, bound to `(requestId, agentId, modelCommitment, inputCommitment, outputCommitment,
   deliverBy)`. That binding is what stops the v0 replay attack where one proof was resubmitted
   a thousand times.
4. **Challenge** (Bronze/Silver only) — the window described above.
5. **Settle** — the vault calls `settle(requestId, outcome)` with `realizedPnlBps`,
   `slaBreached`, `limitBreached`. Fee paid, exposure released, capital-weighted observation
   forwarded to the reputation engine.
   If nothing arrives by `deliverBy`, anyone calls `markExpired`: fee refunded, exposure
   released, **liveness fault** recorded. This is the signal v0 missed completely — non-delivery,
   not invalid proofs, is how agents actually fail.

The consumer's side of all this is one interface, `IReputationOracle`, and one call:

```solidity
require(oracle.meetsPolicy(agentId, Policy({
    minScore: 8500, minTier: Tier.Silver, maxFaults: 0,
    minBond: 50_000e18, maxStalenessSeconds: 7 days
})), "agent not eligible");
```

Policies are set by the consumer, not dictated by us. A conservative vault demands Gold; a
prediction market might take Bronze with a low ceiling. Reads are free and always will be.

### Where it actually stands — the honest part

I'd rather you hear this from me than find it later.

**Built and working:** the contracts (Solc 0.8.24, no external dependencies, 140 tests organised
around the four attacks rather than around function coverage). The full lifecycle runs end to
end on a local chain — request → deliver → challenge → escalate to Gold → settle — plus the
watchtower's liveness-fault path. The circuit compiles, proves, and verifies against its own
verifying key, and reproduces the integer reference exactly on every calibration sample. The
web interface exists and is what we've been building this week.

**Not done:** **not audited, and not deployed to any public network.** No subgraph. No consumer
protocol reading `getProfile` in production — which is the one thing that would tell us whether
any of this matters. The interface currently runs on mock data. The legal pages need a lawyer
before they go live.

**The one chain dependency is resolved:** BOT Chain exposes the bn254 precompiles at `0x06`,
`0x07` and `0x08` at Istanbul prices on both mainnet (chain 677) and testnet (chain 968), so the
Gold tier can deploy. A three-pair Groth16 verify costs roughly 200–250k gas — about 5 cents at
the chain's flat 20 gwei. The deploy script still probes for them rather than trusting them.

**Revenue:** 5% of every execution fee on settle, plus the half of each slash not paid out as a
challenger bounty. The fee is set by the consumer, so it is floored rather than left to the
counterparties — `fee` must be at least `minFeeBps` (default 10 bps) of `notional`, making the
effective minimum take 0.5 bps of notional per execution. `docs/architecture.md` §9 also
contains an honest note on why "staking revenue" and "oracle query fees" are not revenue.

### If you remember only one thing

Everyone building in this space is trying to prove that an agent computed correctly. That is the
easy half, and on its own it is worth very little — a perfect proof over invented inputs is
still a theft. The hard half is making an agent *accountable*: real capital at risk, inputs it
did not get to choose, a score built from settled economic results rather than from its own
claims, and a hard ceiling on what it can touch that is a multiple of its own money.

That's BotID. Verification is a feature of it. Accountability is the product.

---

## Q2 — Explain the concept of the protocol, what it was built to do, and who it was built for

*Asked: 10 Aug 2026.*

### The concept

BotID is **not an AI product**. Nothing in this repository makes an agent smarter, hosts a model,
or helps anyone train anything. It is closer to a **credit bureau and a clearing house for
machine counterparties** — infrastructure that sits between someone with capital and something
non-human that wants to act on it.

The concept in one sentence: **turn an agent from an anonymous API endpoint into a bonded
counterparty with a settlement history, and make the size of what it may touch a function of its
own capital at risk.**

Three ideas do all the work, and they are worth separating because people collapse them:

1. **Identity is collateral, not a registration.** An agent id is not a username; it is a bond, an
   immutable model commitment, and a 21-day exit queue. Identity you can walk away from for free
   cannot carry reputation, because reputation is only meaningful if losing it costs something.
2. **Evidence is tiered, and enforcement is economic.** Rather than one standard of cryptographic
   proof, there are three (signature / TEE / Groth16), and the cheap ones are kept honest by a
   permissionless challenge that forces the expensive one on demand. Cost lives on the exception
   path, not the happy path.
3. **The score is a settlement record, not a rating.** It is computed from outcomes the *consumer*
   reported after the fact, weighted by the capital that was actually at risk. Nobody self-reports
   into it, and no amount of volume grinds it upward.

Where the leverage in the design sits: the protocol never tries to determine whether an agent is
*good*. That is unanswerable and everyone who attempts it ends up building a review site. It
determines something narrower and actually decidable — **what an agent did, whether it did it on
data it was given rather than data it invented, whether it delivered at all, and how much money
it has forfeitable if it is caught lying.** Everything a consumer wants to know is derived from
those four facts.

### What it was built to do

Five concrete jobs. Each one exists because a specific failure had to be made expensive.

1. **Give a DeFi protocol a single decidable gate for agent access to capital.** One read
   interface, `IReputationOracle`, one call: `meetsPolicy(agentId, Policy{minScore, minTier,
   maxFaults, minBond, maxStalenessSeconds})`. Not a dashboard, not a feed to interpret — a
   boolean inside a `require`. The policy is written by the consumer; the protocol dictates no
   thresholds.
2. **Bound the blast radius of a malicious or broken agent, by construction.**
   `maxOpenNotional = bond × leverage(score, tier)`. Whatever an agent does at its worst, the
   ceiling is a multiple of its own posted capital — so the downside is sized in advance rather
   than discovered afterwards.
3. **Make the record of an execution independently checkable by a third party.** Every delivery is
   bound to `(requestId, agentId, modelCommitment, inputCommitment, outputCommitment, deliverBy)`,
   the inputs are a publisher-quorum bundle whose hash the consumer chose, and at Gold the proof's
   public instances are pinned on chain. Anyone can re-derive the claim; nobody has to trust our
   word for it — the interface's proof inspector exists precisely so a sceptic can re-verify by
   hand.
4. **Price and punish the failure that actually happens: non-delivery.** `markExpired` refunds the
   fee, releases exposure, and records a liveness fault. In v0 an agent that took work and
   vanished was never penalised at all.
5. **Make enforcement pay for itself.** Nothing in `ExecutionRouter` self-executes. `markExpired`,
   `slashUnresolvedChallenge`, `finalize` and `settleDefault` are permissionless and carry bounties
   out of slashes, so the guarantees hold because it is profitable for a stranger to make them
   hold — not because a privileged operator is trusted to run a cron job.

Equally important — **what it was deliberately built *not* to do**, because scope discipline is
what kept the design honest:

- **Not an agent marketplace or discovery layer.** No listings, no matching, no ranking-for-hire.
- **Not a model host or an inference network.** Agents run their own compute wherever they like.
- **Not an insurance product.** The v0 insurance vault was cut from v1: pricing agent risk is an
  actuarial business in its own right, and there is no book of settled outcomes to price against
  yet. The bond already provides skin in the game.
- **Not a judge of strategy quality.** `quality()` refuses to reward raw P&L linearly, precisely
  so the protocol does not become a machine that pays agents to gamble with other people's money.
- **Not a data oracle.** `InputAttestor` verifies a publisher quorum's signatures; it does not
  source, price, or vouch for the data itself.

### Who it was built for

Five distinct parties. They are not one audience, and the protocol's fate depends on them in very
unequal measure — so I've said plainly what each one gets, what it costs them, and how well we
currently serve them.

**1. Consumer protocols — the customer.** Lending vaults, BDEX pools, treasuries, prediction
markets, DAOs: anyone holding other people's capital who wants an agent to act on it and needs a
defensible answer to "why were you allowed to do that?" They get a one-call eligibility gate, a
ceiling on exposure they didn't have to compute, a fee they set themselves, and a receipt they can
paste into a governance thread when something goes wrong. What it costs them: they must supply the
`inputCommitment` and they must report outcomes at settlement — the protocol cannot know
`realizedPnlBps` on its own. **This is the group that pays, and the group we serve least well
today: not one consumer protocol is reading `getProfile` in production.**

**2. Agent developers — the supply.** People building numeric strategy models, TEE-hosted LLM
agents, or routing bots who currently cannot get anyone to trust them with size. They get a
portable, bonded track record that isn't locked inside one counterparty's private spreadsheet, and
a tier ladder they can climb. What it costs them: capital locked in a bond with a 21-day exit
queue, a model commitment they cannot silently change, and the standing obligation to be *able* to
prove their decision function on demand even at Bronze. That last requirement is the real filter
on who can participate.

**3. Watchtowers and challengers — the enforcement labour.** Independent operators running the
reference watchtower, or anyone who spots a bad delivery. They are the reason the cheap tiers are
credible. They get slash bounties and forfeited challenge bonds; they risk their own bond on a
frivolous challenge. The role is permissionless and stateless by design — run as many as you like,
the losers only waste gas on reverts. **Whether these bounties actually cover gas and vigilance at
real volumes is an open economic question, not a settled one.**

**4. Data publishers — the input truth.** Feed operators whose quorum signature makes an
`inputCommitment` mean something. Without them, the whole edifice reduces to proving arithmetic
over invented numbers. Today the publisher set is a configured allowlist, which is an honest
centralisation to name out loud.

**5. BOT Chain and its ecosystem — the host.** The protocol is built for a chain that wants
agent-driven activity it can defend. It is why the bn254 precompile dependency mattered enough to
measure rather than assume, and why fees are denominated the way they are.

And one group it is emphatically **not** built for: retail speculators looking for an agent
leaderboard to bet on. The score is a credit input, not a performance product, and `quality()`
being deliberately non-linear in P&L means the highest-scoring agent is frequently not the most
profitable one. If the interface ever starts reading like a trading competition, we have taken a
wrong turn.

### The asymmetry worth staring at

This is a two-sided market with a cold start, and the two sides are not equally hard. Agent
developers are motivated — they want access to capital and will post bonds to get it. Consumer
protocols are the ones who must change a line in a contract that guards real money, and they are
conservative for excellent reasons. Every unproven assumption in this design lives on that side:
that a vault will accept a boolean from an external registry, that it will bother to report
outcomes at settlement, that `minTier: Gold` is a policy anyone will actually set given what Gold
costs to produce.

Which is why "no consumer protocol reading `getProfile` in production" is not a to-do item to me.
It is the single open question the entire thing hinges on, and everything else — 140 tests, a
working circuit, this interface — is preparation for being able to ask it properly.

---

## Q3 — The contracts: Orbit or OP Stack? And explain each one, why it exists and what it does

*Asked: 10 Aug 2026.*

### First, the Orbit / OP Stack question — neither, and the question is a category off

Orbit and the OP Stack are frameworks for **launching a chain**. BotID is not a chain. It is an
application-layer protocol: sixteen Solidity files, about 2,000 lines, deployed *onto* an existing
EVM chain. We did not roll a rollup, run a sequencer, or fork a node client.

The analogy: asking whether BotID was built with Orbit or the OP Stack is like asking whether a
restaurant was built with concrete or steel framing. Those are how you build the *building*. We
built the restaurant — the kitchen, the menu, the till — and we lease a unit in someone else's
building. BOT Chain is the building. Orbit and OP Stack are two ways to pour a foundation.

I checked rather than asserting this from memory — a repo-wide search for `orbit`, `op stack`,
`optimism`, `arbitrum`, `rollup` and `sequencer` across every `.sol`, `.md`, `.ts`, `.js`, `.py`
and `.json` returns **exactly one hit, and it is the word "exorbitant" inside an npm deprecation
notice in a lockfile.** There is no cross-domain messenger, no L1 block oracle, no
rollup-specific precompile, no chain-framework dependency of any kind.

What is actually in the build:

- **Solc 0.8.24**, `viaIR`, optimizer at 200 runs.
- **Zero external Solidity dependencies** — not even OpenZeppelin. `Ownable`, `SafeTransfer` and a
  minimal `IERC20` are written in `libraries/Utils.sol`, 58 lines. Hardhat is used *only* to run
  tests; `npm run compile` builds through a standalone solc driver with no framework at all.
- **No proxies and no upgradeability.** No `delegatecall`, no UUPS, no initializers. Parameters
  are ownable setters with hard bounds; logic is immutable once deployed.
- **One chain-level requirement:** the bn254 precompiles at `0x06`, `0x07`, `0x08` at Istanbul
  (EIP-1108) prices, needed only by the Gold tier. Bronze and Silver require nothing beyond a
  standard EVM.

On that last point — the refusal of dependencies is the difference between a chef who makes his own
stock and one who opens cartons. It is slower, and the reason we do it is that every carton is
someone else's recipe that can change without telling you. Not even OpenZeppelin, which is the
industry's carton of choice.

The practical consequence: these contracts will deploy on any EVM chain, and could run on an Orbit
chain or an OP Stack chain without a line changed. They target **BOT Chain** — mainnet chain 677
(`rpc.botchain.ai`), testnet chain 968 (`rpc.bohr.life`), flat 20 gwei — and the precompiles were
probed there on 2026-08-09 rather than assumed. `deploy.js` still probes at deploy time, because a
chain can be repriced and a script that checks costs nothing.

**What I cannot tell you from this repository is what BOT Chain itself was built with.** The repo
records its chain ids, its RPC endpoints, its gas price and its measured precompile behaviour, and
nothing about its node stack. If you need that answered, it's a question for the chain team, not
something I should infer from a gas schedule.

### The inventory

| Group | Files | Lines |
|---|---|---|
| Core contracts | `AgentRegistry`, `ExecutionRouter`, `ReputationEngine`, `InputAttestor` | 1,076 |
| Adapters (one per tier) | `SignatureAdapter`, `TeeAdapter`, `ZkAdapter` | 431 |
| Interfaces | `IReputationOracle`, `IVerificationAdapter`, `IInputAttestor`, `IReputationEngine` | 114 |
| Libraries | `Types`, `ScoreMath`, `Digest`, `Utils` | 272 |
| Test doubles | `mocks/Mocks.sol` | 107 |

Plus `circuits/build/Verifier.sol`, which we did not write — `ezkl create-evm-verifier` generates
it from the proving key, and `ZkAdapter` calls it through a two-function interface.

### The four core contracts

Before the detail, the shape of the whole thing in one analogy. Think of a **freight company that
hauls other people's valuables**:

- `AgentRegistry` is the **licensing office**: it holds your licence, your surety bond, and the
  ceiling on how much cargo value you are allowed to have on the road at once.
- `ExecutionRouter` is the **dispatch desk**: it takes the job from the customer, hands it to a
  driver, holds the payment in escrow, and decides when the job is closed and paid.
- `ReputationEngine` is the **file room**: it keeps your record — deliveries, lateness, incidents —
  and it cannot touch a penny of anyone's money.
- `InputAttestor` is the **weighbridge and the sealed manifest**: it certifies that what you
  actually loaded is what the customer's paperwork says you loaded.

Each of the four maps onto one of those. Keeping them separate is the point.

**`AgentRegistry` — 328 lines. Identity, capital, exposure, and the consumer read API.**

*Why it exists:* because the v0 design let reputation substitute for capital, and identity cost
about 500 tokens. That combination is a Sybil farm with extra steps. This contract exists to hold
the one invariant that closes it.

*What it does:* stores each agent as `(owner, operator, modelCommitment, tier, active,
lossToleranceBps, bond, openNotional, unbondingAmount, unbondingAt)`; takes and returns bonded
capital; enforces the 21-day `UNBONDING_PERIOD`; executes slashes and splits them between
challenger bounty and treasury; and computes the credit ceiling:

```
effectiveBond = bond − unbondingAmount            // exiting capital stops backing new work
limit = effectiveBond × leverageBps(score) × tierFactorBps(tier)
maxOpenNotional = min(limit, globalNotionalCap)
```

This is a **margin account at a broker**, and the analogy is exact enough to be useful. Your
deposit is the bond. Your track record buys you a leverage multiple on that deposit — never a line
of credit *instead* of a deposit. Capital you have asked to withdraw stops counting toward margin
the moment you ask, which is why `effectiveBond` subtracts `unbondingAmount`.

`leverageBps` is a **step function, deliberately** — 0.5× below neutral (5000), then 1×, 2×, 4×,
and 6× as the cap above 9500. Continuous leverage would behave like a thermostat with no deadband,
twitching your borrowing limit every time the score moves a point; steps mean the ceiling only moves
when you have genuinely crossed into a different bracket. `tierFactorBps` is Bronze 0.5×, Silver 1×,
Gold 1.5×. `minBond` is 500 tokens, and an agent below it gets a ceiling of zero rather than a small
one — the way a bank closes an account rather than letting it run on fumes.

Two details that matter more than they look. The **operator key is rotatable without losing
history** — the way a haulier can replace a driver without surrendering the company's safety
record; make people forfeit their record to rotate a key and they will simply never rotate the key,
which is a security footgun you built yourself. And `modelCommitment` is **immutable for the life of
the agent id** — closer to a drug's licence than a company name. Change the formulation and you file
again as a new product; you do not inherit the old one's trial results because it kept the name on
the box. It is also where `IReputationOracle` lives: `getProfile` and `meetsPolicy`, free to read,
forever.

**`ExecutionRouter` — 451 lines, the largest. The lifecycle and the only contract that moves money.**

*Why it exists:* v0's `submitVerifiedInference` was permissionless, replayable and unbound — anyone
could pump any agent's score, and one proof could be resubmitted a thousand times.

*What it does:* `requestExecution → deliver → (challenge → resolveChallenge |
slashUnresolvedChallenge) → finalize → settle`, with `markExpired` and `settleDefault` as the
escape hatches. Consumers request; agents never self-submit. It escrows the fee, reserves exposure
against the registry's ceiling, verifies the input bundle through `InputAttestor`, dispatches
attestation checking to the tier's adapter through `mapping(Tier => IVerificationAdapter)`, then
releases exposure, pays out, and forwards a capital-weighted observation to the engine.

Its parameters are the protocol's clock and its economics: `challengeWindow` 1 hour,
`escalationWindow` 6 hours, `settlementWindow` 7 days, `minFeeBps` 10 (so the fee floor is 10 bps
of notional), `protocolFeeBps` 500 (5% of the fee, making the effective minimum take 0.5 bps of
notional), and a `treasury`.

The consumer-requests-it property is the difference between an **invoice and a purchase order**.
v0 accepted invoices: the agent turned up claiming it had done work, and the chain wrote that down.
Here nothing exists until the customer raises the order, which is why an agent cannot bill itself
into a reputation.

That adapter mapping is the single most important structural decision in the codebase. It means
**the trust assumptions are the swappable part**. Think of the router as a courier depot with three
ID desks — a signature desk, a sealed-enclave desk, a mathematical-proof desk. The depot's rules
about deadlines, payment and disputes do not care which desk verified you. Replacing a desk with a
better one is a local job: a new adapter registered against a tier, lifecycle logic untouched.

**`ReputationEngine` — 170 lines. Opinion, and nothing else.**

*Why it exists:* to be the one place where the score is formed, so that scoring can be reasoned
about — and re-tuned — without touching capital or the lifecycle. And because scoring proof
validity was informationally empty: invalid proofs revert, so every agent that ever landed
anything is at 100%.

*What it does:* keeps `(score, faults, settledExecutions, lastUpdateAt, lastActiveAt)` per agent,
applies the capital-weighted EWMA on each settled outcome, decays idle scores toward neutral, and
maintains the fault ledger.

Its constants are the policy, and each one has a plain-world twin. `halfWeight` 100,000 tokens is a
**surgeon's caseload rule**: a thousand successful mole removals do not qualify you for heart
surgery, so the size of the job determines how much the outcome tells us. `weightCap` 1,000,000 is
the flip side — one enormous job cannot make your whole record, the way a single lottery win does
not make someone a good investor. `decayHalfLife` 90 days is a **fitness certificate with an expiry
date**: a clean bill of health from two years ago is not evidence about today. And
`livenessHaircutBps` 1,500 is the **no-show penalty** — it is deducted directly rather than averaged
in, because a restaurant that fails to open is not defended by the four hundred nights it did.

Note what it does *not* have: any authority over money. It cannot move a token. The file room does
not hold the cash box. Keeping opinion and capital in separate contracts means a bug in the scoring
maths is a mispriced ceiling, not a theft.

**`InputAttestor` — 127 lines. The contract that makes proofs mean something.**

*Why it exists:* this is the one I'd defend hardest, because it is the fix for the attack that
breaks every naive design in this space. `ezkl` proves "this committed model, run on these inputs,
produced this output." It says nothing about where the inputs came from.

The analogy I keep coming back to: a proof of inference is a **flawlessly audited set of accounts
built from invented receipts**. Every column adds up. Every total is correct. The auditor's opinion
is genuine — and the whole thing is a fabrication, because nobody checked that the receipts
described real transactions. `InputAttestor` is the step where the receipts get checked. Without it,
an agent feeds itself a fabricated price, produces a flawless proof, and executes a flawless theft.

*What it does:* verifies that each feed reading in the bundle is signed by a quorum of registered
publishers under `FeedReading(bytes32 feedId, bytes32 valueHash, uint64 timestamp)`, is fresh
within `maxAge` (5 minutes, measured against the moment the request was created rather than against
delivery), and that the bundle hashes to the `inputCommitment` **the consumer put on chain**. The
same commitment is bound into the attestation by the adapter, so the inputs proved over are
provably the inputs commissioned. Its honest weakness: the publisher set is an owner-managed
allowlist with a configurable quorum, which is real centralisation and should be named as such.

### The three adapters — one per tier, all behind `IVerificationAdapter`

If the three tiers are three ways of proving a parcel arrived intact, then: Bronze is **the courier's
own signature on the delivery note**, Silver is **a tamper-evident security seal with the bag
number recorded**, and Gold is **an X-ray of the parcel's contents**. Each is a different point on
the same curve of cost against certainty, and the adapters are the three machines that read them.

**`SignatureAdapter` (Bronze, 45 lines).** A 65-byte operator signature over
`Digest.execution(ctx, address(this))`. Deliberately weak cryptographically, **and that is the
design.** A signed delivery note is worthless as cryptography and priceless as *liability*: it
costs nothing to produce, works for any model including LLMs, and is honest only because a
slashable bond stands behind a claim anyone can escalate. Note the adapter's own address inside the
digest — domain separation, the equivalent of pre-printing the depot's name on the pad so a note
signed at one depot cannot be presented at another.

**`TeeAdapter` (Silver, 114 lines).** Verifies a signature from an *enrolled enclave key*, checked
against a measurement allowlist (PCR0 / MRENCLAVE) with an expiry. The measurement is the **serial
number on the security seal**: it proves the box was closed around exactly the code we allowlisted,
not something swapped in later. This tier is what makes the protocol relevant to LLM agents at all,
since ZK-ML cannot prove them at any price.

The honest limitation, written into the contract's own docs: parsing a full Nitro/SGX attestation
document on chain is prohibitively expensive, so enrolment is **notarised off chain** — someone
inspects the vendor's paperwork at the door and writes "this key belongs to this sealed box, valid
until Friday" into the contract. The trust root is therefore the notary set *plus* the silicon
vendor, not the vendor alone. Enrolments are short-lived by design, and moving to on-chain document
verification is a drop-in change to this one contract.

**`ZkAdapter` (Gold, 272 lines — the most subtle in the repo).** Its job is *not* to call
`verifyProof`. This is the trap, and the analogy that makes it obvious: a verifier returning `true`
is **a lab certificate with no patient name on it.** The chemistry is impeccable. It is a genuine
result from a real machine. And it tells you nothing, because you cannot show it belongs to *this*
sample rather than one taken down the corridor.

So the adapter pins the instance vector to the execution context **before** verifying: instances
`[0, nIn)` are the input tensor, `[nIn, nIn + nOut)` the output tensor — exactly what `ezkl` emits
for a circuit compiled with public input and output visibility — and the `Reveal[]` openings tie
those felts back to the committed input bundle and the delivered `outputCommitment`. That is the
patient name, the sample id and the collection time, written on the certificate before anyone is
allowed to read the result. The test worth reading is *"rejects a proof whose instances describe a
different execution."*

### Interfaces and libraries — the seams

Interfaces are **standardised couplings** — the reason you can put any trailer behind any lorry.
`IVerificationAdapter` makes tiers pluggable, `IReputationEngine` lets the router record outcomes
without knowing the maths, `IInputAttestor` lets the input-truth mechanism evolve, and
**`IReputationOracle` is the only thing a consumer protocol ever compiles against** — 22 lines. That
narrowness is the point: it is a **letterbox rather than a shared front door.** Integrate against 22
lines and our internals cannot be dragged into your build, nor your build broken by our refactors.

The libraries are the standard parts bin. `Types` (82) holds `Policy`, `Profile`, `Tier`, `Request`,
`Outcome`, `Status`, `VerificationContext`. `ScoreMath` (98) is the decay and EWMA maths, pulled out
so it can be tested as pure functions — the equivalent of bench-testing an engine before it goes in
the car, which is how we test decay monotonicity, convergence and the anti-grinding property
directly. `Digest` (34) is the EIP-712 execution digest every tier signs over, and it lives in one
file for the same reason a company has one official stamp: three tiers with three private notions of
what an execution *is* would eventually disagree, and the disagreement would be exploitable.
`Utils` (58) is the deliberate refusal of a dependency tree.

One consequence of that refusal, worth knowing before you integrate: our `IERC20` declares only the
three functions `SafeTransfer` actually calls. **It has no `approve` and no `decimals`.** It is a
**spare key cut for one door** — perfectly good for what we use it for, useless as a general
keyring. Use viem's complete `erc20Abi` instead, or you will find yourself holding an
official-looking ABI that cannot approve a bond.

### What is deliberately absent

No token contract — the bond token is an address passed to `deploy.js`, which derives every
capital-denominated parameter from its `decimals()`. This is the **metric-versus-imperial failure**,
and it is dangerous precisely because nothing crashes: get the units wrong and too-large weights
stop the score moving at all, while a too-large challenge bond quietly makes Bronze and Silver
unchallengeable. No error, no revert — just a protocol whose safety mechanisms are switched off. So
the script derives the numbers rather than trusting a deployer to notice.

No insurance vault. No governance module. No proxy. No upgrade path. Those absences are choices, and
the reasoning is the one every builder eventually learns about scaffolding: an upgrade mechanism is a
permanent door into the building, and every door needs a guard. I would rather ship four contracts
that do what they say than eight that need a migration plan.

---

## Q4 — Explain the circuits and the relayer

*Asked: 10 Aug 2026.*

### Where these two sit

The contracts are the **courthouse**: they hold the rules, the money and the record, and they never
go and look at anything themselves. Everything that actually *happens in the world* happens in the
other two directories.

- **`circuits/`** is the **forensics lab** — 750 lines of Python. It turns a model into something
  that can produce evidence a court will accept, and it produces that evidence on demand.
- **`relayer/`** is the **staff** — 1,563 lines of Node, one dependency. The driver who does the
  job, the inspector who files the paperwork nobody else is paid to file, and the customer who
  raises the order.

A courthouse with no lab and no staff is a building full of rules that never touch reality. That is
what these two exist to prevent.

---

### `circuits/` — the forensics lab

Seven files. `spec.json` is the model's identity, `export_onnx.py` builds the graph *and* the
integer reference, `pipeline.py` runs the seven-stage build, `run.py` does inference, `prove.py`
produces proofs, `common.py` holds paths and field encoding.

**The model itself is deliberately boring.** `botid.reference-allocator.v1`: three price feeds in,
three portfolio weights out, in basis points. The rule is one sentence — *every feed strictly above
the bundle average gets an equal share, everything else gets nothing.* In exact integer arithmetic
that is four lines:

```python
pos = np.maximum(len(x) * x - x.sum(), 0)   # how far above the mean, floored at zero
ind = np.minimum(pos, 1)                    # 1 if above the mean, else 0
return (ind * 10000) // max(ind.sum(), 1)   # split 10000 bps equally among the winners
```

It is boring on purpose. This is the **crash-test dummy, not the car.** Nobody ships a dummy; you
ship the safety result you learned from it. The reference allocator exists so the pipeline, the
adapter, the relayer and the tests all have something real and fully-understood to be checked
against.

**What `pipeline.py` actually does** — `gen-settings → calibrate → compile → fidelity → srs → setup
→ verifier` — is best understood as **getting a lab instrument certified.** Calibration is literally
that: `ezkl` sizes its internal lookup ranges from the calibration samples, which is why the sample
set has to *reach the edges of the declared domain* rather than sit comfortably in the middle, and
has to include the awkward cases — an all-identical bundle, a negative reading, a near-tie. Calibrate
a scale on nothing but medium weights and it will be confidently wrong at both ends.

The build writes four files that matter: `model.compiled` (the circuit), `pk.key` (~150MB proving
key — **keep it off public hosts**), `vk.key` (the verifying key, which *is* the circuit's identity),
and `Verifier.sol`, the EVM verifier bound into `ZkAdapter` with `setVerifier`.

**The fidelity gate is the part I would point at if you asked what makes this pipeline different
from a tutorial.** `pipeline.py` refuses to hand over a proving key it has not personally watched
reproduce the integer reference on *every* calibration sample. It is the **factory refusing to ship
the batch until the sample passes QC** — and the reason it exists is the first of two failures we
found the hard way.

**Failure one: `ezkl` division is a reciprocal lookup, and it fails silently.** `Div` compiles to
multiplication by a looked-up `1/d`. Divide by a bundle total in the hundreds of thousands and that
reciprocal quantises to zero. The circuit compiles. `setup` succeeds. Proofs verify. **Every single
output is 0, and nothing anywhere reports an error.** This is a **kitchen scale that reads zero for
anything under a gram** — it isn't broken in a way you'd notice; it's confidently wrong, and you find
out when the cake doesn't rise. The fix in the model was to divide by a *count* bounded by the feed
count, which the lookup represents exactly. The fix in the process was the fidelity gate, so this
specific failure can never ship. (The same failure appears from the other direction at
`input_scale = 0`: with no fractional bits there is nowhere for a reciprocal to live. That is why
scale is a registration parameter rather than a constant.)

**Failure two: intermediates must stay under 2^28.** halo2 decomposes values in base 2^14 with two
limbs, so there is a hard ceiling on any intermediate value:

```
3 feeds × 300,000 max value × 2^8 scale  =  2.30e8  <  2^28 = 2.68e8
```

This one is a **weight limit on a bridge**, and the good news is that exceeding it fails
*loudly* — compilation dies with a decomposition error rather than quietly losing precision. It is
also a genuine trade with no free side: **precision and range are two ends of the same tape
measure.** Buy more fractional bits and you lose domain; widen the domain and you lose precision.
Both numbers therefore live in `spec.json` where they can be seen, not buried in code.

**`run.py` versus `prove.py`, and why every tier calls the first one.** `run.py` is inference: values
in, public instances out, no proof. `prove.py` is the expensive path. The rule that matters is that
**every tier runs the circuit, Bronze included** — because the output commitment goes on chain at
delivery, long before anyone asks for a proof.

The analogy: it is **signing a statement now that you may be cross-examined on later.** A Bronze
agent that computes its answer with a hand-written reimplementation, differing from the circuit in
the last digit, has already sworn to a number it cannot defend — and it discovers this at the worst
possible moment, under challenge, with its bond at stake. Running the real circuit everywhere makes
the tiers agree **by construction rather than by review.** `prove.py` reinforces it: pass the
instance vector the agent committed to and it *refuses to prove anything else*, so a stale build is
caught before the proof is spent.

**One thing deliberately not in the circuit.** `inputCommitment` and `outputCommitment` are keccak
hashes, and halo2 cannot compute keccak without a gadget `ezkl` does not expose. So the binding
happens on chain, at 6 gas a word, checked against the router's own storage rather than against a
number the prover chose. That last clause is the whole argument: **you do not ask the suspect to
supply the evidence bag's serial number.** Nothing protocol-specific lives inside the circuit at all.

Signed values use the bn254 encoding — `v >= 0 ? v : P − |v|` — and magnitudes at or beyond `2^128`
are refused *before* reduction, because otherwise a reveal of the literal integer `P − 42` would
land in the same cell as `−42`. That is **two different cheques written for the same amount in
different currencies**, and refusing the large magnitudes is how we keep the two from ever being
confused.

---

### `relayer/` — the staff

Three roles, one small Node process each, one dependency (`ethers`). Eleven files.

| Role | Key | Real-world counterpart |
|---|---|---|
| **Agent** | `OPERATOR_KEY` | The driver who takes the job and defends the delivery note |
| **Watchtower** | `WATCHTOWER_KEY` | The traffic warden who writes the tickets |
| **Consumer** | `CONSUMER_KEY` | The customer — what a vault would run |

**The agent loop**, and the one step everything hangs on:

```
ExecutionRequested
  → fetch the bundle at inputURI
  → recompute its commitment and check it against the chain     ← load-bearing
  → open the served readings against the committed valueHashes  ← the other half
  → run the model (the circuit itself, at every tier)
  → build the tier's attestation (signature / TEE quote / proof)
  → deliver()
```

`inputURI` is untrusted event data — **an address on an envelope, not a signature on the letter.** It
is a locator and nothing more. The agent only ever runs on data that hashes to the commitment the
consumer already put on chain, so a hostile URI can waste the agent's time but cannot change what
the agent is judged on. That distinction — locator versus authority — is the difference between a
protocol and a hope.

The readings are checked the same way, one at a time. A bundle commits to a `valueHash`, not to a
number:

```
valueHash = keccak256(abi.encode(int256 value, bytes32 salt))
```

The salt is there because an input commitment is public the instant `requestExecution` lands. Prices
live in a small, guessable range, so without a salt the values are recoverable by anyone patient
enough to brute-force them — **including the agent being graded on them**. That is a sealed exam
paper where the questions can be deduced from the envelope's weight. And `publisher.open()` checks
every reading against its committed hash *before the model sees it*, so a URI pairing a correct
bundle with doctored values is rejected in the agent's own process rather than proven false on chain
three hours later.

**The behaviour I am proudest of in the whole relayer:** on `ExecutionChallenged` the agent re-derives
the answer from scratch, and if the re-run does not reproduce the committed output it **declines to
contest and takes the slash.** An honest defendant who discovers they were wrong does not
manufacture an alibi. If your model was wrong or non-deterministic, that is precisely the case the
challenge mechanism exists to catch, and fighting it would be the relayer lying on your behalf.

**The watchtower exists because nothing in `ExecutionRouter` self-executes.** Smart contracts have no
heartbeat — they are **vending machines, not staff: nothing happens until somebody presses a
button.** Four guarantees are only real because someone calls the function behind them:

| Call | Without it |
|---|---|
| `markExpired` | An agent that takes work and vanishes is never faulted. **Pays a bounty — self-funding.** |
| `slashUnresolvedChallenge` | An unanswered challenge sits forever. Bounty goes to the challenger, not the caller. |
| `finalize` | A clean delivery never leaves its challenge window. |
| `settleDefault` | A silent consumer holds the agent's exposure and fee hostage. |

It is permissionless and stateless, so run as many as you like — **like tow trucks listening to the
same radio channel, the losers just waste a little fuel** (gas on reverts). And `markExpired` paying
a bounty is the mechanism design that matters: enforcement that depends on somebody's goodwill is
enforcement that stops on a bad day.

**A few operational choices worth naming, each with its reason:**

- **`inputScaleBits` is read off `ZkAdapter.modelFor(...)` at startup, never configured locally.** A
  wrong shift is not a security hole — it is a *silent outage* in which every honest proof is
  rejected. So the relayer takes the number from the registration the adapter will actually check
  against, rather than keeping its own copy. **Never carry a second copy of a fact you can read from
  the source.**
- **Keys are separated.** `OPERATOR_KEY` can sign attestations and nothing else — it cannot move the
  bond or withdraw fees. That is the **till key versus the safe key**, and the safe key has no
  business on a relayer host.
- **`deliverBy` is the deadline that costs money**, so delivery is retried with backoff — but reverts
  are never retried, because the chain has already made its decision. Repeating a revert burns gas
  *and* burns the deadline a fallback might still have made. **A rejected form is not resubmitted
  unchanged.**
- **`EZKL_PROVER_CMD`** lets you swap the prover for anything taking the same JSON on argv — a
  proving queue, a bigger machine, an HSM. **`ALLOW_DEV_PROOF=true`** emits correct instances with
  empty proof bytes, which is valid only against `MockEzklVerifier`; a real verifier rejects it,
  which is the honest outcome for a relayer told not to prove anything.
- **`MODEL_RUNNER=reference`** swaps in a pure-JS port of the integer reference for hosts with no
  Python. It is not an approximation — the pipeline refuses to ship a key that does not reproduce
  that exact function — but it is a **second set of keys to the same lock**, and it becomes a
  liability the moment `spec.json` changes and only one of them is updated. `src/inference.js` is
  deliberately the single boundary where that choice is made.

**And the honest caveat:** not audited, and not hardened for production key custody.

---

## Q5 — Explain the revenue pattern

*Asked: 10 Aug 2026.*

### The shape of it in one line

BotID is a **toll booth on a road it also polices**. There are exactly **two** money lines in the
contracts today, and I want to be blunt up front that only one of them is a business:

| Line | Parameter | Flows to | Character |
|---|---|---|---|
| Take rate on execution fees | `protocolFeeBps = 500` (5%) | `treasury`, on settle | Recurring, scales with usage |
| Slash residue | 50% of every slash (`100% − challengerBountyBps`) | `treasury` | Lumpy, adversarial, **shrinks as the protocol works** |

That is the entire model. No token sale in the mechanism, no listing, no emissions.

### Line one: a 5% take on execution fees

The mechanics are eleven lines in `ExecutionRouter._settle`, and they only run on settlement:

```solidity
uint256 protocolCut = (fee * protocolFeeBps) / 10_000;   // 5%
bondToken.safeTransfer(treasury, protocolCut);
bondToken.safeTransfer(agent.owner, fee - protocolCut);
```

This is a **letting agent's commission**: the tenant pays rent, the agency takes its percentage,
the landlord gets the rest — and the agency is paid *out of a transaction it made possible*, not by
metering the door. Note it happens **on settle, not on request.** We do not get paid for work that
was commissioned; we get paid for work that completed and was reported. **The waiter is tipped when
the meal is served, not when the order is taken** — which puts the protocol on the same side of the
table as the consumer.

### Why the floor is the actual design work

Here is the problem that makes a naive take rate worthless. `fee` is chosen **freely by the
consumer**. So a 5% cut of `fee` is 5% of a number the two counterparties *jointly control*, and two
parties who know each other simply set `fee = 0`, settle the real payment by bank transfer, and take
the entire protocol service for nothing.

Every percentage-of-a-self-reported-number scheme in history has this hole. It is **letting people
write their own declared value on a customs form.**

So the fee is floored against something they cannot quietly agree away:

```solidity
if (fee < (uint256(notional) * minFeeBps) / 10_000) revert FeeBelowFloor();   // minFeeBps = 10
```

The floor is denominated in `notional` — the size of the position at risk — and the reason that
specific quantity was chosen is the part worth understanding. **`notional` is expensive to misreport
in *both* directions:**

- **Understate it** and you forfeit reputation gain, because notional is the *weight* of the score
  update. A $2M job declared as $100 moves your score like a $100 job.
- **Overstate it** and you consume your own bond-derived credit ceiling, because notional is what
  gets reserved against `maxOpenNotional`.

It is a **declared shipping weight where the price is per kilo but so is the insurance payout.**
Lie downward and your claim is worthless; lie upward and your freight bill rises. Neither party can
move `notional` to dodge the floor without paying for the move somewhere else. That is what makes it
a floor rather than a suggestion.

At the shipped defaults the arithmetic lands at:

```
protocolFeeBps × minFeeBps = 5% × 10 bps = 0.5 bps of notional
```

**Half a basis point of every dollar that flows through, guaranteed** — whatever the counterparties
choose to call the fee. On $1B of settled notional that is $50,000. Deliberately small: this is a
**toll, not a tariff.** A road priced to extract maximum revenue per vehicle is a road people route
around, and the one thing that kills an infrastructure protocol is being cheap to avoid.

Two escapes are deliberate. **Zero notional is free** — nothing is at risk, so there is nothing to
price; dry runs and integration tests cost only gas. And **`setMinFeeBps(0)` disables the floor
entirely**, which is the correct setting on testnets and during bootstrapping, when the goal is
integrations rather than income. **You do not charge admission to a shop that has no customers yet.**

That setter is kept *separate* from the eight-argument `setParameters` call and hard-capped at 1,000
bps, for two reasons worth stating: a floor near 100% of notional is not a fee, it is a **halt** —
it would brick `requestExecution` in a way that reads like an unrelated bug — and keeping it off the
big parameter call means changing one economic number does not require restating every safety window
correctly on the way past.

### Line two: slash residue, which I refuse to call revenue

When an agent is slashed — 20% of remaining bond for a lost challenge, 2% for non-delivery — the
proceeds split: **50% to the challenger as a bounty, 50% to the treasury.**

That treasury half is real money and I still will not budget against it, for one reason: **it only
appears when the protocol fails at its job.** Maximising it means maximising agent failure. If the
incentives work, this line trends toward **zero**.

It is **fine income for a courthouse and a terrible business model for a bank.** Any lender whose
profit plan depends on repossessions has mispriced its loans. So the honest treatment is to earmark
slash residue as a **reserve fund for the stage-4 insurance vault** — money set aside from failures,
to pay for failures — rather than counting it in a revenue projection. Anyone modelling this protocol
by extrapolating slash income has drawn a graph of how badly it is going.

The other 50% is not ours and should not be. **The challenger bounty is a policing budget, not a
cost.** Nobody watches for fraud out of civic feeling; `challengerBountyBps = 5000` is what pays the
watchtowers to press the buttons that contracts cannot press themselves. Paying half the slash to
whoever catches the failure is cheaper than employing anyone to look.

### What v0 counted that does not exist

This is the section I would want a prospective investor to read first, because the previous
tokenomics counted two lines that are not there.

**"Reputation staking revenue" is not revenue.** Bonds are **collateral, not deposits**. They sit in
`AgentRegistry`, they are returned on unbonding, and the protocol earns nothing for holding them.
They are TVL and a security parameter, not a P&L line.

And the obvious "fix" is the trap: lend the bonds out for yield. That would put the **slashing
guarantee behind a liquidity assumption**, which is the precise thing the bond exists to avoid. It
is **spending the fire-brigade's water on car washes** — profitable until the day you need it, which
is the only day it was ever for.

**"API / oracle query fees" cannot be charged.** `getProfile`, `getScore` and `meetsPolicy` are
`view` functions. Off-chain callers read them by `eth_call` for free; on-chain callers pay gas to
validators, not to us. **There is no point in the design where a read can be metered** — and adding
one would defeat the purpose, because a reputation oracle nobody can cheaply read is a reputation
oracle nobody integrates. **Charging to read a credit score is how you ensure nobody checks credit
scores.**

A hosted API with history, webhooks and SLAs *is* a viable business — but it is a **company's**
revenue, not the **protocol's**, and anyone can undercut it by indexing the same public events. That
distinction is worth keeping straight, because conflating the two is how a protocol ends up quietly
depending on a moat it does not have.

So: reads are free, and always will be.

### The honest summary

One recurring line, small by design, floored so it cannot be negotiated to zero, and paid only on
completed work. One adversarial line that should shrink to nothing and is earmarked for insurance
rather than income. Two lines from the old model deleted for being **fictions with a plausible
accent**.

And the number that decides whether any of it matters is not in this section at all: it is settled
notional. 0.5 bps of nothing is nothing. **The whole revenue model is a bet on one thing —
that a DeFi protocol somewhere will read `getProfile` and gate real capital on the answer.**
Everything above is just the plumbing for collecting a toll once traffic exists.
