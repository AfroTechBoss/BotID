# The contracts, explained

This document assumes you know nothing about smart contracts. It explains every contract in
`contracts/src`, one at a time, then walks the whole lifecycle of a job from the moment somebody
orders it to the moment the money moves, then explains the scoring maths in ordinary arithmetic,
and finishes with why the pieces are split up the way they are.

There is no code you need to read to follow this. Where a real function name appears it is
because you will see it in the interface or in a block explorer and it helps to know what it is.

---

## 0. The one-paragraph version

BotID is a **bonded contractor scheme for software agents**. An agent posts money as a bond, the
way a builder posts a licence bond before anyone will let them near a site. A customer orders a
specific job, supplies the data the job must be done on, and puts the fee in escrow. The agent
does the work and files evidence that it really ran the model it registered, on that exact data.
After a challenge period the evidence is final. Later the customer reports what actually happened
economically, and *that* — not the evidence — is what moves the agent's reputation. A better
reputation lets the agent take on bigger jobs relative to its bond. Failing to deliver, or being
caught with evidence it cannot back up, takes a bite out of the bond and a bite out of the score.

Everything else is detail about how each of those sentences is made hard to cheat.

---

## 1. The cast

Before the contracts, the people. Six roles appear over and over, and half the confusion about
this system comes from blurring two of them together.

| Role | Who they are | What they do |
|---|---|---|
| **Agent owner** | The business that owns the agent | Registers it, posts the bond, collects the fees, can withdraw the bond later |
| **Operator** | A key the owner controls | Signs and submits deliveries. Rotatable — like changing the locks without changing the address |
| **Consumer** | The customer | Orders the job, pays the fee, reports the outcome afterwards |
| **Publisher** | A data source | Signs readings — "the price was X at time T" — so nobody can invent the inputs |
| **Challenger** | Anyone at all | Posts a deposit to say "prove that properly", and gets paid if they were right |
| **Notary** | A vetted party | Vouches that a particular secure-hardware key really is running approved code (Silver tier only) |

**The single most important thing to understand: the consumer and the agent are different
parties, and the consumer moves first.** An agent cannot give itself work. It cannot build a
reputation by wanting one, in exactly the way a builder cannot generate references by writing
them. Somebody has to hire them, and then say how it went.

---

## 2. The building

Think of the protocol as a small building with five rooms and three cupboards. Nothing in the
building trusts anything else's word for something it can check itself.

```
                          ┌─────────────────────────────┐
                          │      ExecutionRouter        │
      the customer  ───▶  │  the works desk: takes the  │
                          │  order, holds the money,    │
                          │  runs the job to the end    │
                          └───┬────────┬────────┬───────┘
                              │        │        │
              "is this agent  │        │        │  "is this evidence
               good for it?"  │        │        │   real?"
                              ▼        ▼        ▼
             ┌────────────────────┐  ┌──────────────────┐  ┌────────────────────┐
             │   AgentRegistry    │  │  InputAttestor   │  │  Adapters ×3       │
             │  identity, bond,   │  │  "did this data  │  │  Bronze  signature │
             │  credit limit      │  │  come from real  │  │  Silver  enclave   │
             └─────────┬──────────┘  │  publishers?"    │  │  Gold    ZK proof  │
                       │             └──────────────────┘  └────────────────────┘
        "what is this  │
         agent's       │
         score?"       ▼
             ┌────────────────────┐
             │  ReputationEngine  │      backed by the ScoreMath cupboard
             │  the reference     │      (pure arithmetic, holds nothing)
             │  file             │
             └────────────────────┘
```

The cupboards — `Types`, `Digest`, `ScoreMath`, `Utils` — hold no money and make no decisions.
They are shared vocabulary and shared arithmetic, so that two rooms cannot quietly disagree about
what a word means.

---

## 3. Contract by contract

### 3.1 `Types.sol` — the shared vocabulary

Not a contract, a list of definitions. Every other file imports it so that "delivered" means one
thing across the whole system rather than one thing per room.

**Tier** — how strong the evidence is. Deliberately ordered, weakest first:

- `Bronze` — the operator simply signs a statement. Cheap, works for any kind of agent
  including a language model. Challengeable.
- `Silver` — the work ran inside secure hardware, and the hardware signed it. Challengeable.
- `Gold` — a zero-knowledge proof: mathematics anyone can check that the registered model,
  run on that exact data, produces that exact output. Final immediately.

**Status** — where a job is. `Pending` → `Delivered` → (`Challenged`) → `Finalized` → `Settled`,
with two bad endings: `Expired` (never delivered) and `Faulted` (challenged and could not
answer), and one neutral one: `Rejected` (the agent declined the order up front). Once a job
reaches `Settled`, `Expired`, `Faulted` or `Rejected` it never changes again.

**Outcome** — what the customer reports at the end: profit or loss in basis points relative to
the size of the job, plus two yes/no flags — was it late or out of spec, and did it breach the
risk limits the agent declared.

**Policy** — the customer's own hiring criteria: minimum score, minimum tier, maximum faults,
minimum bond, maximum staleness. The protocol never dictates thresholds; it just answers
questions about them.

**Request** and **Profile** are the record of one job and the public summary of one agent.

**VerificationContext** — the seven facts that describe one execution: which request, which
agent, which model, which inputs, which outputs, by when, and which operator. This is the packet
every piece of evidence has to be tied to. Its importance is covered in `Digest` below.

---

### 3.2 `Utils.sol` — the plumbing

Three small things.

`IERC20` is the minimal shape of a token — the bond and the fees are paid in an ordinary token.
`SafeTransfer` moves that token and *checks that it worked*. This sounds trivial and is not:
some older tokens fail silently instead of raising an error, and a system that assumes money
moved when it did not is a system with a hole in it.

`Ownable` is two-step ownership. Handing over control happens in two moves — the current owner
nominates, the new owner accepts. **Analogy:** you don't post the keys through the letterbox and
hope; the new tenant has to turn up and take them. A single-step transfer to a mistyped address
would lock the protocol's admin functions forever.

---

### 3.3 `Digest.sol` — the job number stamped on every document

It takes the seven facts of a `VerificationContext` and squeezes them into a single fixed-length
fingerprint, together with the chain it happened on and the address of the checker. The result is
an **EIP-712 typed-data hash**: `keccak256(0x1901 || domainSeparator || structHash)`, where the
domain is `{name: "BotID", version: "1", chainId, verifyingContract}`.

**Why it exists:** evidence has to be *about something*. A signature that says "I did the work"
is worthless, because it can be pasted onto any job. A signature over this digest says "I did
*this specific job, for this agent, with this model, on this data, producing this output, due at
this time, on this chain*". Copy it to any other job and the fingerprint changes and the check
fails.

**Analogy:** a stamped and numbered docket. The signature isn't on a blank sheet, it's across the
docket number. Reuse is visible immediately.

**Why the envelope, given that the docket number was already unique.** The chain id and the
verifier address were always in the hash — they have moved into the domain, where EIP-712 puts
them, and they bind exactly as much as before. Nothing was ever forgeable without the `\x19\x01`
prefix. Two other things followed from its absence anyway. A signer could not *render* what it was
agreeing to: an operator approving a delivery saw one opaque 32-byte word rather than a request id
and a deadline, so every attestation in the protocol was a blind sign. And a key that signs bare
32-byte hashes has given up the one structural guarantee that its signatures cannot also be
*transactions* — the `\x19` prefixes exist to keep those two signable spaces disjoint, because an
RLP-encoded transaction never begins with that byte.

**Analogy:** the envelope is the letterhead. The same sentence carries different weight on a blank
sheet and on a sheet naming the company, the department and the date — and whoever holds a signed
blank sheet gets to decide later what was agreed.

`EXECUTION_TYPEHASH` is byte-for-byte the string it always was, which is what made the change
possible without touching the field list. `version` is `"1"`, and it is a deliberate string rather
than a number nobody thinks about: the next change to the field list should bump it, so old
signatures stop verifying on the same block instead of lingering in an ambiguous middle state.

Every contract that is a `verifyingContract` — `InputAttestor`, `SignatureAdapter`, `TeeAdapter` —
inherits `EIP712Domain`, so it answers `DOMAIN_SEPARATOR()` and the ERC-5267 `eip712Domain()`
(`fields = 0x0f`: name, version, chainId and verifyingContract present, no salt, no extensions).
The two adapters additionally inherit `ExecutionVerifier`, which exposes
`executionDigest(ctx)` — the exact bytes an attestation must be signed over, readable from the
deployed contract. That getter exists so the relayer can hand a probe context to the chain and
compare the finished digest rather than compare one constant and trust the rest.

One deliberate omission worth knowing about: `operator` is in the context but is **not** in the
digest. That is not an oversight. The operator is the answer the signature is checked *against* —
the adapter recovers whoever signed and compares them to the registered operator. Hashing the
operator into the digest would let any key sign a statement naming itself as the operator, which
defeats the check. The name goes on the door of the office, not into the signature.

---

### 3.4 `ScoreMath.sol` — the arithmetic of reputation

A cupboard of four pure calculations. It stores nothing and owns nothing; it is a calculator that
other contracts borrow. Section 5 works through the numbers properly. In brief:

- `quality` — turns one finished job into a mark out of 10,000.
- `observe` — folds that mark into the running score, weighted by how much money was riding on
  it. This is the capital-weighted EWMA.
- `decay` — pulls an idle agent's score back toward the neutral 5,000 over time.
- `haircut` — for faults. Multiplies the score down directly, bypassing the averaging entirely.

Scores live on a 0–10,000 scale. **5,000 is neutral, not failing** — it is where every new agent
starts and where an inactive one drifts back to.

---

### 3.5 `InputAttestor.sol` — proving the inputs were real

This contract exists because of one very sharp problem, and it is worth spelling out, because
almost every "verifiable AI" pitch has this hole in it.

A zero-knowledge proof of inference proves: *this model, run on these numbers, produced this
output.* It says **nothing whatsoever about where those numbers came from.** An agent can feed
itself a fabricated price, produce a mathematically flawless proof, and execute a flawless theft.
The proof is perfect and completely worthless.

**Analogy:** a laboratory returns a beautifully certified analysis of a sample. The certificate
proves the test was done correctly. It proves nothing about whether the sample came from your
site or from a bucket in the lab's car park. The chain of custody is the missing half, and this
contract is the chain of custody.

How it works:

1. The protocol owner registers a set of **publishers** — data sources whose signatures count.
2. Each reading is a small record: which feed, a hash of the value, and a timestamp. Publishers
   sign these.
3. A **quorum** is required — how many independent publishers must sign the same reading.
   Signers must appear in strictly increasing order, which is a cheap trick to stop one publisher
   signing the same reading three times to satisfy a threshold of three on its own.
4. A **max age** is enforced, measured against the moment the *customer created the request* —
   not against delivery time. The customer is the one who fixes what data the job runs on, so
   that is the only moment at which "how stale is this reading?" is a meaningful question. How
   long the agent then takes is a separate deadline's problem.
5. Finally the whole ordered bundle is hashed, and that hash must equal the `inputCommitment` the
   customer put in the order.

That last line is the load-bearing one. The customer commits to the data *before* the agent
touches it. The agent later has to hand over the actual bundle, and it must hash to the same
value. **The agent cannot choose what it is judged on.**

One small design note: signature recovery here never throws an error. A malformed signature comes
back as "not attested" rather than blowing up the whole delivery with an opaque failure — the
difference between a rejected document and a fire alarm.

---

### 3.6 `IVerificationAdapter` and the three adapters

The router does not know how to check a signature, an enclave quote, or a ZK proof. It knows how
to ask a specialist. `IVerificationAdapter` is the shape of a specialist: tell me your tier, and
answer yes or no about whether this evidence is valid *for exactly this context*.

**Analogy:** the works desk doesn't grade concrete itself. It sends the sample to whichever lab is
accredited for that grade, and all the labs answer on the same one-page form.

This is what makes the protocol extensible without surgery. A new kind of evidence is a new
adapter, registered against a tier. Nothing else changes.

The interface carries a warning in capital letters, and it deserves repeating: an adapter that
ignores any field of the context reintroduces an attack. One that forgets `requestId` allows
replay. One that forgets `modelCommitment` lets an agent silently swap in a different model.
These are not style preferences.

#### `SignatureAdapter.sol` — Bronze

The operator signs the digest. The adapter recovers who signed and checks it is the registered
operator. That is the whole contract, and it is 45 lines.

It is **deliberately weak**, and that is the point. Bronze costs nothing to produce and works for
any kind of agent — including a language model, which nothing today can prove mathematically.
Its honesty does not come from cryptography. It comes from two other places: the operator has
posted a bond that can be taken away, and **anyone can challenge the delivery and force it to be
proven properly**. An agent that cannot answer a challenge loses far more than lying could ever
have earned.

**Analogy:** a signed timesheet. On its own it proves nothing — but it is signed by someone whose
licence bond is on the line, and any passer-by can demand the inspection that settles it.

#### `TeeAdapter.sol` — Silver

The work runs inside a *trusted execution environment* — a sealed compartment inside a processor
that can prove what code it is running and sign things from inside. Think of a tamper-evident
box: you cannot see in, but the box vouches for what's happening inside and puts its own seal on
the output.

Silver exists for a reason worth stating plainly: **ZK proofs today cannot prove a language-model
agent at any price.** They prove small numeric models — regressions, small networks, decision
trees. A Gold-only protocol would address a sliver of the market it claims to serve. Secure
hardware covers arbitrary code at almost no extra cost, in exchange for a weaker but real trust
assumption: you are trusting the chip vendor.

The contract is honest about a second limitation. Fully parsing a hardware attestation document
on chain is ruinously expensive. So instead, **notaries** check the document off chain and enrol
the resulting key here, binding it to a code measurement and an expiry. The trust assumption is
therefore the notary set *plus* the vendor. Two guards against that:

- Enrolments last a maximum of **7 days**. A leaked enclave key stops being useful quickly, with
  no reliance on anyone noticing in time.
- **Any notary can revoke immediately**, without waiting for the owner. Revocation must be faster
  than enrolment, never slower.

The signed digest also includes the code measurement, so a signature from an enclave running one
program is not valid for another.

#### `ZkAdapter.sol` — Gold

The strongest tier, and the most intricate contract in the system. A proof arrives, and it is
final the moment it verifies — no challenge window at all, because there is nothing left to
dispute.

The critical insight in this contract is stated in its own comments: **a proof alone is not
enough.** A verifier returning "true" means "this circuit was evaluated on *some* public values."
It says nothing about *which job* those values belong to. So the adapter's real job is not to
call the verifier — it is to pin the numbers to the request first.

Three bindings happen before the proof is even looked at:

1. **The inputs.** The agent reveals the actual feed values and their secret salts. The adapter
   re-hashes them using *the attestor's own hashing rule* — not a copy, the real one, so the two
   can never drift apart — and the result must equal the customer's `inputCommitment`.
2. **The input cells.** Those same revealed values, converted into the exact numeric form the
   circuit uses, must equal the first cells of the proof's public values. So the model demonstrably
   ran on the customer's data and nothing else.
3. **The outputs.** The remaining cells are hashed, and must equal the `outputCommitment` the
   agent is delivering under. This stops a valid proof being paired with a different, more
   flattering result.

Only then does it call the verifier.

Two subtleties you will otherwise trip over:

**Why the commitments are not inside the proof.** The obvious design puts the commitments into
the proof itself. It cannot be built — those are Keccak hashes, and a proving circuit cannot
compute Keccak without machinery the tooling does not offer; proving it would cost more than
proving the model. Checking on chain is both cheaper (a few gas per word) and *stronger*, because
it checks against the router's own stored record rather than against a number the prover picked.

**The fixed-point shift.** The proving toolchain works in whole numbers, so real values get
multiplied by a power of two first. That shift is registered per model, because it cannot be
inferred and it cannot be zero for any interesting model — at zero, a division's reciprocal
rounds to nothing and the circuit silently computes garbage. Registering it is what lets Gold
accept models that divide at all. Get it wrong and every honest proof is rejected until it is
corrected — annoying, but the safe direction to fail in.

There are also read-only helpers so a prover can check its own bundle *before* spending minutes
generating a proof that was never going to bind.

---

### 3.7 `ReputationEngine.sol` — the reference file

Holds one record per agent: score, fault count, number of settled jobs, when it was last active,
when it was last updated. Nothing else. No money passes through it.

It has exactly two ways to be written to, and both are locked behind a **writer** list — only the
registry (to create a record) and the router (to update one) can call them. Nobody can write
their own reference.

**`recordOutcome`** — a job settled. Decay the score to today, work out this job's quality mark,
and fold it in weighted by the money at stake — but only up to what the *reporting customer* has
left in its budget. Bump the settled counter.

That budget is `consumerWeightCap`, and it is there because settling is unilateral: the customer
reports the result, and the customer also picks the notional the result is weighted by. Damage
therefore scales with a number the liar chooses while the cost is a tenth of a percent of it, and
no fee floor can close a gap the attacker scales both sides of. So no single counterparty gets to
define an agent's reference. Think of it as one signature on a reference letter: it counts, and it
counts for a lot, but a reputation is the stack of them and no one signature is the stack. The
budget refills on the same 90-day half-life the score itself decays on, so a customer of long
standing keeps its voice; spending is symmetric, because it is an influence budget and not a
punishment.

**`recordFault`** — the agent failed. Decay to today, then apply a flat multiplicative cut:
15% off for a liveness fault (accepted a job and never delivered), 60% off for a verification
fault (challenged and could not prove it).

The line separating those two is the most important design decision in this contract:

> A fault is **not** folded in as an observation. It is applied directly.

If a fault went through the averaging, an agent could dilute it by doing a large volume of
routine jobs — and volume is exactly the thing a bad actor can manufacture. **Analogy:** a driving
conviction does not get averaged away by the thousands of times you didn't crash. It goes on the
licence as its own mark.

The other thing to notice: **the score decays lazily.** Nobody pays gas to keep every score
current. Instead the stored score is a snapshot with a date on it, and every *read* applies the
decay from then to now. So the number you get is always up to date, and it costs nothing to keep
it that way. **Analogy:** the milk isn't thrown out on a schedule; you check the date when you
reach for it.

---

### 3.8 `AgentRegistry.sol` — identity, bond and credit limit

The biggest contract after the router, and the one holding the bonds. It answers "who is this
agent, what have they staked, and how big a job are they good for?"

**What an agent record contains:** an owner (the business), an operator (the signing key), a
`modelCommitment`, a tier, an active flag, a declared loss tolerance, the bond, the currently
open exposure, and any unbonding amount in progress.

Two of those deserve attention.

**The operator key rotates; the model commitment does not.** You can change the locks without
losing the address — a compromised or retired signing key is replaced and the history stays with
the agent. But the model is fixed at registration. **Changing the model means registering a new
agent, from scratch, at a neutral score.** The reputation was earned by the old model, and it does
not transfer. This is the anti-bait-and-switch rule: you cannot build a record with a careful
model and then quietly swap in a reckless one.

**The declared loss tolerance** is the agent stating, up front, how much downside is within spec
for what it does. A market-making strategy that never loses more than 2% declares 200. This is
what the scoring measures adherence against — see section 5.

#### The central formula

```
maximum open job size  =  effective bond  ×  leverage(score)  ×  tier factor
                                                              (capped globally)
```

Leverage is a **step function**, not a smooth curve — small score wobbles should not silently move
an agent's capital ceiling:

| Score | Leverage |
|---|---|
| below 5,000 | 0.5× |
| 5,000–6,999 | 1.0× |
| 7,000–8,499 | 2.0× |
| 8,500–9,499 | 4.0× |
| 9,500+ | 6.0× |

Tier factor: Bronze 0.5×, Silver 1.0×, Gold 1.5×. So the absolute ceiling is **9× the posted
bond** — a perfect-scoring Gold agent.

**Why it is built this way — and this is the heart of the whole economic design:** reputation is
a *multiplier on capital you have actually posted*, never a substitute for it. A great score with
no bond gets you nothing, because anything × zero is zero. That single property is what makes
mass fake-identity attacks pointless: creating a thousand agents does not create extraction
capacity, because each one has to be separately funded with money that can be taken away.

**Analogy:** a bank's credit line for a business. A spotless payment history gets you a better
multiple — but on *your* collateral. Nobody hands you an unsecured facility for being nice.

#### Reserving and releasing

When a job is ordered the router calls `reserve`, which adds the job size to the agent's open
exposure and refuses if that would blow the limit. It is released in exactly three places, all of
them final: settlement, a lost challenge, and expiry. Nothing is released at delivery, or at
finalisation. So while a job is anywhere in flight, that capacity is genuinely spoken for.

**Analogy:** a hold on a card. It isn't spent yet, but you can't spend it twice either.

#### Getting the bond back

Three exits, and the differences matter:

- **`startUnbonding`** — announce an intention to withdraw. The amount is removed from the credit
  calculation immediately, and the contract checks right there that current open exposure still
  fits inside the reduced limit. Critically, **the money remains slashable for the whole 21-day
  period.** Announcing you are leaving does not take you out of range.
- **`withdraw`** — after 21 days, take it.
- **`withdrawEarly`** — leave sooner, paying a 10% toll to the treasury, **but only if open
  exposure is exactly zero**.

That last condition is doing all the work, and the reasoning is worth following because it's a
good illustration of how this codebase thinks. A toll alone would be a *price on escaping
liability*, and the wrong price: a lost challenge costs 20% of the bond while the toll costs 10%
of what's leaving. An agent expecting a fault would just pay the smaller number and walk. You
cannot fix that by raising the toll, because the payoff it's weighed against comes out of job
size, which leverage carries to nine times the bond — the two sides aren't even denominated in
the same thing.

So the toll isn't asked to. `openNotional == 0` *is* "nothing outstanding", exactly rather than
approximately, because release only happens in the three terminal states. Zero exposure means
every job the agent ever took has already reached a state where the bond can no longer be reached
for it. There is nothing left to outrun, and the toll goes back to being what it should have
been: a charge on churn.

And the agent can clear the gate rather than merely wait it out — a forgotten pending job holds
exposure open indefinitely, but marking a job expired is open to anybody, including the agent
itself.

#### The consumer-facing reads

The registry is also the **front door for customers**, via a small read interface:

- `getProfile` — the full public picture, score already decayed to now.
- `getScore` — just the number.
- `availableCredit` — how much more this agent can take on right now.
- `meetsPolicy` — *"here are my hiring rules; does this agent pass?"* One call, yes or no.

`meetsPolicy` is the one that matters. **The protocol never tells a customer what a good agent
is.** A conservative vault demands Gold tier, zero faults, high bond. A prediction market accepts
Bronze with a small ceiling. Both are served by the same call with different rules.

The staleness rule inside it is easy to miss and worth knowing: because scores decay lazily, a
high score attached to an agent that hasn't worked in six months is a *historical* fact, not a
current one. Checking score alone means accepting stale reputation. That's what
`maxStalenessSeconds` is for.

---

### 3.9 `ExecutionRouter.sol` — the works desk

The largest contract, and the only one a customer or an operator directly transacts with during a
job. It holds the fees, drives every state change, and calls the other four contracts at the
right moments. Section 4 walks it step by step.

Three properties from its own header are the substance of the design:

1. **Jobs are ordered by customers, not self-submitted by agents.** The customer supplies the
   input commitment, so an agent cannot pick its own data, and every job has a unique id bound
   into its evidence — no replay, no substitution, no permissionless score inflation.
2. **Not delivering is a first-class fault.** In an earlier design the only negative signal was a
   failed proof — which never lands on chain, because it simply reverts. The real failure mode is
   a job accepted and not honoured, and this contract can see it.
3. **Cheap tiers are made honest by escalation, not by trust.** A Bronze or Silver delivery can be
   challenged, and the agent must then produce a Gold proof of the same execution or be slashed.

**The fee floor** is a small piece worth understanding. The protocol's revenue is a cut of the
fee, which the customer sets freely — so without a floor, a customer and an agent who know each
other set the fee to zero, settle privately, and take the service for nothing. The floor is a
percentage of the *job size*, which is the one number in a request that is expensive to misreport
in either direction: understating it means a smaller score update, overstating it eats the
agent's own credit line.

---

### 3.10 `Mocks.sol` — test doubles

Not deployed. A fake token, a fake proof verifier, and a harness that exposes the scoring maths
for direct testing.

One detail there is a real lesson: the fake token's decimal precision is *settable* rather than
fixed at 18. On Bohr the bond token has 6 decimals, and the two parameters that break under a
decimals mismatch — the score half-weight and the challenge deposit — **break silently**. A test
suite that can only mint an 18-decimal token can only ever prove the protocol at 18 decimals.

---

## 4. The lifecycle, step by step

Five phases and two bad endings. Let's follow one job the whole way.

### Step 1 — Before anything: the agent registers

The owner calls `registerAgent` with an operator key, a model commitment, a tier, a declared loss
tolerance, and a bond of at least the minimum. The registry takes the bond, files the record, and
asks the reputation engine to open a file at the neutral score of 5,000.

Nothing else can happen until this exists.

### Step 2 — The customer prepares the data

Off chain. The customer collects publisher-signed readings, hashes the ordered bundle, and now has
an `inputCommitment`. It also has somewhere to publish the bundle so the agent can fetch it.

This is the part that isn't a contract call, and it's where the honesty comes from. **The
customer freezes the data before the agent knows it's being hired.**

### Step 3 — `requestExecution` — the order

The customer calls the router with:

- **which agent**
- **the input commitment** — the frozen data
- **notional** — how much capital this decision governs. Not a price. It is the weight of the
  eventual score update and the thing checked against the agent's credit line. **It cannot be
  zero.** An order with nothing at risk is still a live obligation the agent can be slashed over,
  but reserving zero adds nothing to `openNotional` — and `openNotional == 0` is the whole of the
  early-exit gate on the registry. A customer could otherwise park a free order against an agent,
  watch it walk out through `withdrawEarly` with its bond, and leave the slash computing a
  percentage of nothing. The gate reads `openNotional` as a proxy for "no open orders"; refusing a
  zero notional here is what makes that proxy faithful.
- **fee** — what the agent gets paid, at least the floor percentage of notional. Escrowed now.
- **deliverBy** — an absolute deadline, and it must be at least `minDeliveryWindow` away. "In the
  future" is not enough: a deadline in the next block is one no operator could ever meet, and
  ordering one is how you slash an agent for a job it never had a chance at.
- **inputURI** — where to fetch the bundle. **Emitted only, never stored, never trusted.** A hash
  tells you *what* the data is, not *where* it is, so without this the agent has nowhere to look.
  But the agent must still check what it fetches hashes to the commitment — a hostile link can
  waste its time, never change what it's judged on.

The router generates a unique request id, tells the registry to reserve the notional against the
agent's credit (this fails if the agent is over its limit or inactive), files the record as
`Pending`, and pulls the fee into escrow.

*Gotcha for anyone actually calling this: approve the token first, or it reverts on the transfer.*

### Step 3b — `reject` — the agent's right of refusal

Anyone may place an order, and `inputCommitment` is taken entirely on trust — it is a bare 32-byte
hash, and nothing on chain can distinguish a commitment to a real publisher-signed bundle from a
number somebody made up. An order built on a made-up commitment can never pass the input check in
Step 4, so it can never be delivered.

Without a way out, that is a weapon. Anyone could order impossible work from any active agent, wait
for the deadline, call `markExpired` themselves, and collect half the slash as the bounty — paying
only gas, repeatable, and the agent could do nothing about it. It could not deliver, and it could
not decline.

So it can decline. Within `rejectionWindow` (5 minutes) of the order being placed, the **operator**
may close it: the credit is released, the fee is refunded, and **nothing is recorded against the
agent** — no fault, no slash, no mark on the score.

The window is what keeps this honest. An unlimited right of refusal would be a different thing
entirely — the agent would sit on every order and bail out the moment one looked like going badly,
and the liveness fault would never fire again. Five minutes means the decision is made at *order*
time, before the agent knows anything about how the job would have gone.

**Analogy:** a market maker may decline to quote. It may not un-fill a quote it has already
filled. Declining is free; reneging is what the liveness fault is for.

### Step 4 — `deliver` — the work comes back

The **operator** — nobody else — calls this before the deadline with the output commitment, the
actual input bundle, and the tier-appropriate evidence.

The router checks, in order:

1. The job is still `Pending` and the deadline hasn't passed.
2. The caller is the registered operator.
3. **The input bundle is genuine** — passed to the `InputAttestor`, which checks publisher
   signatures, quorum, freshness, and that it hashes to the commitment from step 3.
4. **The evidence is valid** — assembled into a `VerificationContext` and handed to the adapter
   for that agent's tier.

If any check fails the whole thing reverts and nothing is recorded. This is why *"failed proofs"*
are not a reputation signal — they never land.

Then it forks:

- **Gold** → status jumps straight to `Finalized`. A valid ZK proof needs no challenge period.
- **Bronze or Silver** → status becomes `Delivered`, and a challenge window opens (1 hour by
  default).

Either way the settlement clock starts: 7 days.

### Step 5 — the challenge window (Bronze and Silver only)

Anyone may call `challenge`, posting a deposit — but only against an agent that could actually
answer. The status becomes `Challenged` and the agent has 6 hours to produce a Gold proof.

**Analogy:** demanding an inspection. It costs you something to demand it, so you don't do it
idly — but if you're right, you're paid.

**Who can be challenged.** Registering the circuit a Gold proof is checked against is
`ZkAdapter.setVerifier`, which is owner-only — so whether an agent *can* escalate is not the
agent's decision. Against an agent with no registered circuit the inspection has a predetermined
result: it cannot pass, whatever it did. The sequence was post the deposit, wait 6 hours, take a
bounty out of the bond, and get the deposit back — because the deposit is only forfeited on the
branch where the agent *does* resolve. Free, repeatable, and it establishes nothing.

So `challenge` asks `canEscalate(agentId)` first and reverts with `NotEscalatable` if the answer
is no. It is read live rather than snapshotted at delivery, which fails safe both ways: an agent
whose circuit is de-registered mid-flight stops being challengeable instead of becoming free to
slash, and one that registers a circuit becomes challengeable exactly when it can answer.

**The cost of this is real and worth stating: an agent with no registered circuit has deliveries
nobody can dispute.** Its Bronze signature is backed by the bond and by `markExpired` alone.
`canEscalate` is public precisely so a customer can check that before hiring — the honest answer
is that the recourse was never there, not that it was taken away.

**Analogy:** you cannot fine a contractor for failing an inspection you never licensed anyone to
perform. What you can do is check, before you hire them, whether an inspection is available.

Three ways out:

- **`resolveChallenge`** — the operator produces a **Gold proof of the same execution**. If it
  verifies, the job is `Finalized` at Gold tier and **the challenger's deposit goes to the agent
  owner**. Frivolous challenges are expensive, which is what stops challenge-spam being a
  griefing tool.
- **`slashUnresolvedChallenge`** — the 6 hours pass with no proof. The agent is slashed 20% of
  its remaining bond, half of which goes to the challenger as a bounty and half to the treasury.
  A verification fault is recorded — a 60% haircut to the score. The exposure is released and
  **the customer's fee is refunded**. Status: `Faulted`, terminal.
- Nothing happens at all — but note the challenge cannot simply expire quietly; someone has to
  call the slash, and the bounty is what pays them to bother.

If nobody challenges, anyone calls **`finalize`** once the window closes, and the status becomes
`Finalized`.

### Step 6 — `settle` — the outcome, and the only thing that moves reputation

The **customer** calls this within 7 days, reporting the `Outcome`: profit or loss in basis
points, whether the SLA was breached, whether risk limits were breached.

The router:

1. Marks it `Settled`.
2. Releases the reserved exposure back to the agent's credit line.
3. Calls `recordOutcome` on the reputation engine — **this is the score update**.
4. Pays out: a 5% protocol cut of the fee to the treasury, the rest to the agent owner.

**Nothing before this point moves the score.** Not delivery, not verification, not finalisation.

There is a good reason, and it's the single most counter-intuitive thing about the protocol:
**proof validity carries no information.** Invalid proofs revert and never appear on chain, so
every agent's proof record is identical — 100% valid. A "score per verified proof" number would
be measuring nothing. What actually distinguishes agents is whether they deliver, whether they
stay inside their declared limits, and what happens to the capital they were trusted with.

### Step 7 — `settleDefault` — the silent customer

If the customer never reports, anyone can call this after 7 days and the job settles **at par** —
zero P&L, no breaches. The agent gets paid and its exposure is freed.

Without this, a customer could hold an agent's fee and credit line hostage forever by simply
saying nothing. **Analogy:** the invoice is deemed accepted if nobody disputes it in a month.

**"At par" is about the money only. The score does not move here.** This is the one place the two
meanings of settlement come apart, and it matters because they are not symmetric. A zeroed outcome
is not a neutral grade: `quality()` starts at a perfect 10,000 and only ever subtracts, so no loss
and no breaches reads as *flawless* rather than as *unknown*. Recorded at full weight, silence
would have been the strongest compliment the protocol can pay — and an agent could manufacture it
by ordering its own work through a second address that then says nothing, paying only the 5%
protocol cut on a fee that returns to its other pocket. So the observation is recorded at **zero
weight**, which `observe()` already treats as "leave the score alone". The execution still counts
as activity and still pays; nobody vouched for it, so nobody's word is entered.

**Analogy:** the invoice being deemed accepted means you get paid. It does not go in the file as a
five-star review, because the customer never wrote one.

### Bad ending — `markExpired`

The agent accepted a job and never delivered. "Accepted" is a real thing now: the operator had
five minutes to decline it (Step 3b) and let them pass. Once the deadline passes, **anyone** can
call this:

- 2% of the remaining bond is slashed, half of it a bounty to whoever called
- a **liveness fault** is recorded — a 15% haircut to the score
- the exposure is released and **the customer's fee is refunded**

Permissionless on purpose. It shouldn't depend on the injured party bothering, and the bounty
means it doesn't.

Note the asymmetry: 2% of bond and a 15% haircut for not showing up, versus 20% and a 60% haircut
for being caught claiming something it couldn't prove. **Being unreliable is a problem. Lying is
a much bigger one.**

### The full picture

```
  registerAgent ──▶ [agent exists, score 5000, bond posted]
                              │
  requestExecution ───────────┤  reserve credit, escrow fee
                              ▼
                          PENDING ─── deadline passes ──▶ EXPIRED
                              │        markExpired:            (terminal)
                              │        −2% bond, −15% score,
                              │        fee refunded
                              │
                              ├─── within 5 min ────────▶ REJECTED
                              │     reject (operator):        (terminal)
                              │     credit released,
                              │     fee refunded,
                              │     nothing recorded
                              │
                     deliver  │  inputs checked, evidence checked
                              ▼
                 ┌────────────┴────────────┐
          Gold   │                         │  Bronze / Silver
                 ▼                         ▼
             FINALIZED  ◀── finalize ── DELIVERED
                 ▲          (window          │
                 │           closed)         │ challenge (deposit)
                 │                           ▼
                 │                      CHALLENGED
                 │                       │        │
   resolveChallenge (Gold proof)         │        │  6h, no proof
   deposit → agent owner  ───────────────┘        ▼
                 │                             FAULTED
                 │                            (terminal)
                 │                        −20% bond, −60% score,
                 │                        bounty to challenger,
                 │                        fee refunded
      settle  ───┤  or settleDefault after 7 days
                 ▼                (same money, no score:
             SETTLED  (terminal)   the outcome is recorded
             release credit,       at zero weight)
             record outcome → SCORE MOVES,
             fee paid: 95% agent, 5% treasury
```

---

## 5. The capital-weighted EWMA, in ordinary arithmetic

"EWMA" means *exponentially weighted moving average* — a running average that gives recent
observations more say than old ones. The twist here is that "recent" isn't the only thing that
buys influence. **Money does too.**

### Step A — what one job is worth: `quality`

Every job starts at a perfect 10,000 and loses marks:

- **Late or out of spec?** Halved. `10,000 → 5,000`
- **Breached declared risk limits?** Multiplied by 0.2. Severe, and it stacks — both flags means
  `10,000 × 0.5 × 0.2 = 1,000`.
- **Lost money?** *Only penalised past the tolerance the agent itself declared.*

That last rule is the philosophical core. Suppose the agent declared a 5% loss tolerance:

| Realised | Verdict | Quality |
|---|---|---|
| +12% | inside spec | 10,000 |
| −3% | inside spec | 10,000 |
| −8% | 3% over | 7,000 |
| −15% | 10% over — full penalty | 0 |

The penalty ramps from zero at the tolerance to total once the *excess* reaches twice the
tolerance — so with a 5% tolerance, quality hits zero at a 15% loss.

Read the first two rows again. **A big profit scores exactly the same as a small loss inside
tolerance.** That is not a bug. Rewarding raw profit rewards taking risk with other people's
money — the strategy that returns 400% and then loses everything would rank top right up until
the day it doesn't exist. **The protocol scores adherence: did you do what you said you would do?**
Customers can price returns themselves; they cannot easily price discipline.

**Analogy:** an airline's on-time record. It measures whether flights arrived when promised. It
does not award bonus points for arriving early by flying dangerously fast.

### Step B — how much that job counts: the weight

```
influence = notional ÷ (notional + halfWeight)
```

`halfWeight` is the job size at which one job moves the score **halfway** to its quality mark.
With a half-weight of 1,000:

| Job size | Influence | Score 5,000, perfect job → |
|---|---|---|
| 10 | 1% | 5,050 |
| 100 | 9% | 5,455 |
| 1,000 | 50% | 7,500 |
| 10,000 | 91% | 9,545 |

Notice the shape. It never reaches 100%, so **no single job can define an agent**, and there is a
hard cap on top of that anyway. And tiny jobs barely register — a dust-sized job carries almost no
signal, which is the whole anti-grinding mechanism. You cannot build a reputation out of ten
thousand one-cent jobs. To move the number you have to put real capital at risk, and capital at
risk is capital that can be lost.

**Analogy:** a restaurant's rating. One review from someone who bought a coffee shifts it barely
at all; a review from someone who booked the private room for twenty people counts for more. And
no single review, however large, replaces the whole history.

### Step C — folding it in: `observe`

```
new score = old score + (quality − old score) × influence
```

That's it. You move a fraction of the way from where you are toward what this job says you are.
Good jobs pull you up, bad ones pull you down, and the size of the tug is the influence from step
B.

Worked through, from neutral, with a half-weight of 1,000:

| | Job | Quality | Influence | Score |
|---|---|---|---|---|
| start | | | | 5,000 |
| 1 | 1,000, clean | 10,000 | 50% | **7,500** |
| 2 | 1,000, clean | 10,000 | 50% | **8,750** |
| 3 | 1,000, clean | 10,000 | 50% | **9,375** |
| 4 | 1,000, lost 8% (tol. 5%) | 7,000 | 50% | **8,187** |
| 5 | 100, clean | 10,000 | 9% | **8,352** |

Two things to see there. **Improvement gets harder** — each perfect job closes half the remaining
gap, so you approach 10,000 and never arrive. And **one mediocre job of real size undoes several
good small ones**: job 4 cost more than jobs 5 through 12 could put back.

### Step D — time: `decay`

An idle agent's score drifts back toward the neutral 5,000, halving its distance every 90 days.

| Time idle | A 9,000 score becomes | A 3,000 score becomes |
|---|---|---|
| 0 | 9,000 | 3,000 |
| 90 days | 7,000 | 4,000 |
| 180 days | 6,000 | 4,500 |
| 1 year | ~5,240 | ~4,880 |

It cuts **both ways** — a damaged score recovers toward neutral too. Reputation is a claim about
what an agent is like *now*, and a two-year-old record is not evidence about today. **Analogy:** a
reference letter. A glowing one from 2019 isn't worthless, but you wouldn't weigh it like one from
last month. And a bad patch from 2019 shouldn't follow someone forever either.

Applied at read time, as described in 3.7 — so it costs nobody any gas, and there are no
scheduled updates to fail.

### Step E — faults: `haircut`

Faults do **not** go through any of the above. They multiply the score directly:

- Liveness fault (accepted, never delivered) → **×0.85**
- Verification fault (challenged, couldn't prove it) → **×0.40**

From 9,375, one verification fault gives 3,750 — one call wipes out more than the previous three
jobs built. Climbing back takes four more perfect thousand-sized jobs, and it costs four times the
capital at risk to undo what one failure did for free. The fault also stays on the record as a
*separate counter* that customers can filter on directly, so it is visible whatever the score
says.

The reason for the bypass, again: volume is what a bad actor can manufacture. If a fault were
averaged in, an agent could bury it under routine traffic. Faults must not be dilutable.

### Putting it together

An agent's score is: *the capital-weighted average quality of everything it has settled, faded
toward neutral by time, with faults punched straight through.*

And because leverage is a step function of that score, the number cashes out in exactly one way —
**how big a job you're allowed to take on, per unit of bond you've posted.**

---

## 6. Why the pieces are separate

The obvious question is why this is five contracts and not one. Each split earns its keep.

**Each contract answers exactly one question, and no contract is allowed to answer its own.**

| Contract | The one question | Who is not allowed to answer it |
|---|---|---|
| InputAttestor | Is this data real? | The agent — it can't choose its inputs |
| Adapters | Is this evidence real? | The router — it delegates to specialists |
| ReputationEngine | What is this agent's record? | The agent — writers are locked to registry + router |
| AgentRegistry | How big a job are they good for? | The agent — it's derived from bond and score |
| ExecutionRouter | What state is this job in, and where does the money go? | Anyone in a hurry — deadlines and windows are enforced |

Trace the permissions and you'll find a closed loop with nobody able to write their own
credential:

- Only the **router** may reserve, release and slash in the registry.
- Only the **registry and router** may write to the reputation engine.
- Only the **operator** may deliver, and only the **customer** may settle.
- **Anyone** may challenge, mark expired, finalise, or settle-by-default — because those are the
  actions that keep the system honest when a party goes quiet, and they all pay whoever bothers.

Now the second question: **why do the pieces need each other?**

- The **registry needs the engine**, because a credit limit that ignores track record is just
  collateral, and that's a pawn shop, not a reputation system.
- The **engine needs the router**, because the only trustworthy source of "how did it go" is a
  job whose whole life was witnessed — ordered by a real customer, evidenced, finalised, and
  weighted by capital that was genuinely locked.
- The **router needs the registry**, because it must know an agent is good for a job *before*
  accepting it, and must have something to take away afterwards.
- The **router needs the attestor**, because otherwise every proof is a proof about numbers the
  agent invented.
- The **router needs the adapters**, because "evidence" means three completely different things
  and it shouldn't know how any of them work.
- Everyone **needs `Digest` and `Types`**, because the whole security argument is that every
  document is stamped with the same job number, and two rooms with slightly different ideas of
  what a job number is would be a hole big enough to walk through.

And the **circular dependency at the centre is the point**, not an accident:

```
   bond  ──────▶  credit limit  ──────▶  bigger jobs
     ▲                  ▲                     │
     │                  │                     │
     │             score ◀────────────── settled outcomes
     │                  │
     └── slashing ◀─────┘   faults cut both the bond and the score
```

Good work earns a higher score, which unlocks bigger jobs, which carry more weight, which move
the score faster — in both directions. And because bigger jobs are only unlocked against posted
bond, **the amount an agent can extract by finally behaving badly is always bounded by money it
has actually locked up and can lose.** That is the whole security model in one sentence.

---

## 7. What this does not claim

Worth being precise, because the adjacent claim is much larger and false.

**BotID does not certify that an agent is good, profitable, or safe to trust.** It certifies that
a specific execution ran a specific registered model over inputs the agent did not choose, and it
publishes a number summarising how cleanly that agent has delivered inside its own declared
limits, on outcomes that have already settled. Those are narrow, checkable statements.

Known limits, stated plainly:

- **Verification tier and score are unrelated.** A Gold proof says the model ran as registered. It
  says nothing about whether the model is any good.
- **The outcome is customer-reported.** The protocol cannot check whether a P&L number is
  truthful. What it can do is make it expensive to lie — the reporter is a party with money in
  the job, and the alternative to reporting is settling at par.
- **Silver trusts a chip vendor and a notary set.** Stated in the contract itself.
- **The contracts are unaudited** and deployed to Bohr testnet (chain 968) only. The bond token
  there has no value. The numbers are real; the stakes are not.

---

## 8. Where they live

Bohr testnet, chain 968, deployed 2026-08-28 16:39Z, first block 21,465,564. Bond token has 6
decimals.

| Contract | Address |
|---|---|
| ReputationEngine | `0x054a5019c75184850F96C276607b2A2127a3Be73` |
| AgentRegistry | `0xB6D13d5BC5BC87462AaD431cd2Fd22e3a374e6Dc` |
| InputAttestor | `0x0814675fa013B7d7440530E010DCe7B09283fe4C` |
| ExecutionRouter | `0x0E9d52514195C7CC3f17E90D3c4af363c2a5Eb47` |
| SignatureAdapter (Bronze) | `0x9B2e1e4aD190bC15cdE98993593F8992Ad664A13` |
| TeeAdapter (Silver) | `0xde6D31Cd9089Fd236E6c35B04c73568f3183C12b` |
| ZkAdapter (Gold) | `0x4889cbC3Ce84Cb169b1bf21AfF3Bd4c764627fE8` |
| Halo2Verifier | `0xDdf0D8b4ECFCa9a630EE54b9dC0FF62Ed16bd346` |
| Bond token (test) | `0x75edC9335175Fc0552D51D48439F229c10420fe3` |

**Two of these eight are source-verified. The other six cannot be, from this repository.**
`scripts/verify.js` was re-run on 2026-08-31: `InputAttestor` and `Halo2Verifier` came back
already verified, and the remaining six failed with "bytecode doesn't match any of your local
contracts". That is the correct answer rather than a tooling failure. Exactly six contract sources
have changed since this set was deployed — `ReputationEngine`, `AgentRegistry`, `ExecutionRouter`,
`SignatureAdapter`, `TeeAdapter` and `ZkAdapter` — and they are exactly the six that failed. The
two that passed are the two nobody touched, and Blockscout matched them on bytecode it had already
seen rather than on anything submitted here.

Verifying the other six would mean checking out the tree as of the deploy and publishing from
there, which is work with the lifespan of one redeploy. The honest position is that this set is
unverifiable from `main` and stays that way until a set built from `main` replaces it. A reader
who wants to check the running code against source has, for now, no way to do it.

**This replaced the set deployed earlier the same day (registry `0x39FF…aA83`), which had replaced
the one dated 2026-08-25, which had replaced the one dated 2026-08-11.**
Nothing here is upgradeable — `registry`, `engine` and `bondToken` are `immutable`, so one contract
cannot be swapped while the rest stay, and every redeploy is therefore the whole set. Unlike the
previous redeploy, which carried `Halo2Verifier` over because its bytecode was untouched, this one
deployed a fresh verifier: `EZKL_VERIFIER` was unset, so `deploy.js` built one from
`circuits/build/Verifier.sol` and bound the model to it. The binding was read back — `modelFor`
returns the new verifier at `inputScaleBits` 8, matching the manifest — so the Gold tier is live
rather than merely named.

Superseded addresses are not merely old, they are incompatible: the EIP-712 domain includes the
verifying contract, so an attestation signed for a previous Bronze adapter does not verify at the
current one. There is no window in which two sets work. Agents registered against an earlier
registry are not visible here at all; their bonds and scores remain on chain at the old addresses
and nothing reads them.

The wiring was reported by the deploy script and recorded in the manifest: `adapters(1..3)`
resolve to the three adapters, `engine.writers()` is true for both the registry and the router,
and `bootstrapped()` is true on all three timelocked contracts — so the 21-day notice period is
armed and the trust-redirecting setters are behind it.

The `settleDefault` and `challenge` fixes **are** live here, contrary to what this section said
until 2026-08-31. Commit `8c03858` landed at 16:32:33Z and this set went out at 16:39:32Z, seven
minutes later; the deployed router's runtime bytecode carries `canEscalate(uint256)` and the
Bronze adapter carries `canVerify(bytes32)`, both introduced by that commit. Its own message says
"None of this is live", which was true when it was written and stopped being true seven minutes
afterwards, and the redeploy did not go back to correct it — which is how a claim that was
carefully argued at the time becomes the most confidently wrong line in the file.

What this set does **not** carry is the four fixes after it: weight bought with protocol fees,
tier demonstrated rather than declared, the self-dealing check at `requestExecution`, and the
`provenBy` attribution record with `onlyRouter` on `verifyAndAttribute`. Checked by selector
against the deployed bytecode on 2026-08-31, `weightPerFeeUnit()`, `voice(address)`,
`effectiveTier(uint256)`, `recordDelivery(uint256,uint8)`, `provenBy(bytes32)` and `router()` are
all absent. Read anything on this page about those four as describing source, not this chain.

The protocol owner and deployer for this set is `0x08c8108383b69052C04B898676a08Bbbb9ca69F4`, which
is **not** the key that deployed the previous two (`0x3Ae2AfdeF2391E2AC78e1eb901aF4092E5cb6731`).
Treasury is unchanged at `0x27F2b72256bAAFF93dCfD50addBFd63F45e2e091`.

### After a redeploy

`deploy.js` writes `contracts/deployments/bohr-968.json` and stops there. That manifest is the
only sanctioned source for the addresses, and everything below is a copy of it that the deploy
does not touch. The relayer is the exception and the model: `relayer/src/config.js` reads the
manifest off disk, so it needs nothing. Every other item here is hand-maintained, which is
exactly why it goes stale quietly — nothing fails loudly when an address is a set behind, the
reads simply return nothing and the page renders an empty protocol.

| Update | Where | If you skip it |
|---|---|---|
| The manifest itself | `contracts/deployments/bohr-968.json` — **commit it**; the script overwrites in place and git is the only history | The previous set's addresses are unrecoverable |
| The interface's address table | `interface/lib/contracts.ts`, `ADDRESSES.bohr` | The whole app reads a dead set. `npm run check-abi` does not check addresses, only shapes |
| This section's table, first block, and the "replaced the deployment dated…" line | `docs/contract.md` §8 | The documented protocol and the running one are different protocols |
| Explorer verification | re-run `scripts/verify.js` | Source-unverified contracts on a page that claims all eight are verified |
| The timelocked-setter **count** | `interface/app/docs/page.tsx`, `interface/app/security/page.tsx` (twice), `interface/app/legal/disclaimer/page.tsx` | These say **five**, correct for the deployed set. The source now has **six** — `ZkAdapter.setRouter` joined them — so they become wrong on the first deploy that carries it, in the direction of overstating what is protected |
| `deployedAt`, and whether Gold is live | the manifest's `goldModel.verifier` and `timelock.bootstrapped` | A claim that the Gold tier is live rather than merely named, with nothing behind it |

Do the address updates in the same commit as the manifest. A redeploy split across two commits
has a window in which the repo describes two different deployments, and that window is where the
stale copy survives.

### The tunable numbers

Every one of these is settable by the protocol owner, and the ones that matter economically are
deliberately separated from the ones that matter for safety so that changing one doesn't require
restating all eight.

| Parameter | Default | What it does |
|---|---|---|
| `challengeWindow` | 1 hour | How long a Bronze/Silver delivery stays challengeable |
| `escalationWindow` | 6 hours | How long the agent has to answer a challenge |
| `settlementWindow` | 7 days | How long the customer has to report the outcome |
| `UNBONDING_PERIOD` | 21 days | Withdrawal delay — **fixed, not settable** |
| `minFeeBps` | 0.1% of notional | Fee floor, so the service can't be taken for free |
| `protocolFeeBps` | 5% of fee | The protocol's cut |
| `faultSlashBps` | 20% of bond | Lost challenge |
| `livenessSlashBps` | 2% of bond | Never delivered |
| `challengerBountyBps` | 50% of slashed | The rest goes to the treasury |
| `halfWeight` | job size for 50% influence | The anti-grinding dial — raising it makes reputation slower and dearer to manufacture |
| `weightCap` | ceiling on weight | So one outsized job can't dominate |
| `consumerWeightCap` | half of `halfWeight` | Weight one *customer* may spend per half-life, so one counterparty can't dominate either |
| `decayHalfLife` | 90 days | How fast idle scores fade to neutral |
| `livenessHaircutBps` | 15% | Score cut for not delivering |
| `verificationHaircutBps` | 60% | Score cut for a lost challenge |
| `minBond` | — | Below this, credit is zero regardless of score |
| `globalNotionalCap` | — | Hard ceiling per agent |

One safety rule is enforced in code rather than left to care: the settlement and escalation
windows together must fit **inside** the unbonding period. Otherwise an agent could withdraw its
bond before the outcomes it is responsible for had landed against it.

---

---
---

# Part A — the vocabulary

Everything above described *what happens*. This part is the dictionary: every keyword, type and
built-in that appears in these files, then every single named thing in every contract.

You can read Part A once and then use Part B as a lookup table.

## A.1 Things Solidity hands you for free

These appear everywhere and are never declared, because the blockchain itself provides them.

| What | What it actually is |
|---|---|
| `msg.sender` | **Whoever is calling right now.** Not the person who started the chain of calls — the immediate caller. If you call the router and the router calls the registry, then inside the registry `msg.sender` is *the router*, not you. This is the single most important word in the codebase: nearly every permission check is a comparison against it. |
| `block.timestamp` | The clock — seconds since 1970, as reported by the block. Every deadline in the protocol is a comparison against this. It can be nudged a few seconds by a block producer, which is why nothing here depends on second-level precision. |
| `block.chainid` | Which chain we are on. Mixed into every signed digest so a signature made on the testnet is worthless on the mainnet. **Analogy:** the country code on a phone number. |
| `address(this)` | The contract's own address. Also mixed into digests, so a signature meant for the Bronze adapter cannot be replayed at the Silver one. |
| `address(0)` | The null address — the "nobody" value. `owner == address(0)` is how the code asks "does this record exist?", because an unwritten slot reads as zero. Also what a failed signature recovery returns, which is why you'll see `signer != address(0)` checks. |
| `keccak256(...)` | The hash function. Feed it any amount of data, get back a fixed 32-byte fingerprint. Change one bit of input and the output is unrecognisably different. Cannot be run backwards. |
| `abi.encode(...)` | Lays several values out in one unambiguous byte string, so they can be hashed together without two different sets of values ever producing the same bytes. Almost always seen as `keccak256(abi.encode(a, b, c))`. |
| `ecrecover(...)` | Signature recovery. Give it a digest and a signature, it returns **the address that must have signed it**. This is how the chain checks signatures — not by "verifying", but by recovering the signer and comparing. Returns `address(0)` if the signature is nonsense. |
| `revert` / `require` | Abort. Undo **everything** the transaction did and stop. There is no partial failure in a contract — either the whole call happened or none of it did. |
| `emit` | Write a log entry. Costs a little gas, cannot be read back by contracts, but is permanently recorded and is how the website and the indexer learn anything happened. |

## A.2 The types

| Type | Meaning | Why this one |
|---|---|---|
| `uint256` | Whole number, 0 to a number with 78 digits | The default. Cheapest to work with in isolation |
| `uint128` | Smaller whole number | Used for `notional` and `fee` so two of them pack into one storage slot — storage is the expensive resource |
| `uint64` | Used for timestamps | A timestamp needs about 32 bits; 64 is comfortable forever and packs well |
| `uint32` | Used for scores, basis points, counters | A score is 0–10,000 and basis points are 0–10,000; 32 bits is generous |
| `uint8` | 0–255 | `inputScaleBits`, which is at most 64 |
| `int256` | **Signed** — can be negative | Only used for `realizedPnlBps` and the ZK reveal values, because those are the only quantities in the system that can genuinely be below zero |
| `bool` | true / false | |
| `address` | A 20-byte account identifier | Either a person's wallet or another contract — the type does not distinguish, which is occasionally the point |
| `bytes32` | Exactly 32 bytes | Every hash, commitment and identifier. Fixed-size, so cheap |
| `bytes` | A variable-length blob | Proofs, signatures, encoded bundles — things whose length isn't known ahead of time |
| `string` | Text | Appears exactly once in the protocol, as `inputURI` |
| `enum` | A short fixed list of named options | `Tier`, `Status`, `FaultKind`. Stored as a small number — `Tier.Gold` is really `3` |
| `struct` | Several values bundled under one name | `Agent`, `Request`, `Outcome` — a form with named fields |
| `mapping(A => B)` | A lookup table from A to B | See below |
| `T[]` | A list | `bytes[] signatures`, `uint256[] instances` |

### On `mapping`

`mapping(address => bool) public publishers` reads as: *for any address, is it a publisher?*

The thing to understand is that a mapping is **not a list.** You cannot ask it how many entries it
has, and you cannot walk through it. Every possible key already "exists" and returns the zero value
— `false`, `0`, or an all-zero struct. Nothing is created when you write to it; you just change what
comes back.

**Analogy:** an infinite filing cabinet where every drawer already exists and is empty. Filing a
document doesn't create a drawer, it fills one. And there's no index at the front telling you which
drawers have anything in them.

That is why `InputAttestor` keeps a separate `publisherCount` — the mapping cannot count itself.
And it's why "does this agent exist?" is asked as `owner == address(0)`, because there is no
membership test.

You'll see these shapes in the code:

| Declaration | Reads as |
|---|---|
| `mapping(address => bool) writers` | is this address allowed to write? |
| `mapping(uint256 => Agent) _agents` | agent id → the whole agent record |
| `mapping(address => uint256) agentIdByOperator` | operator key → which agent it belongs to |
| `mapping(bytes32 => Request) _requests` | request id → the whole job record |
| `mapping(Tier => IVerificationAdapter) adapters` | tier → which specialist checks it |
| `mapping(bytes32 => Model) modelFor` | model commitment → its verifier and scale |

> **On the two names in your question:** there is no `registerOperator()` in this codebase and no
> `mapping(address => uint256) bonds`. Registration is a single call, `registerAgent`, which takes
> the operator key as an argument — and the operator is changed afterwards with `rotateOperator`,
> not re-registered. Bonds are **not** a standalone mapping keyed by address; each bond is the
> `bond` field inside the `Agent` struct, keyed by agent id. That difference matters: bonds belong
> to *agents*, not to *addresses*, so one owner can run several agents with separately bonded,
> separately slashable identities and one bad agent doesn't drag down its siblings.

## A.3 Who can call it — visibility

| Keyword | Who can call |
|---|---|
| `external` | Anyone outside the contract. The normal choice for the public surface |
| `public` | Anyone outside **and** the contract itself internally |
| `internal` | This contract and anything inheriting from it. Not reachable from outside |
| `private` | This contract only |

Convention in this codebase: a **leading underscore** means internal plumbing. `_settle`,
`_verify`, `_load`, `_slash`, `_maxOpenNotional`, `_decayed`, `_toField`, `_records`, `_agents`,
`_requests`, `_nonce`, `_locked` — all off-limits from outside, all naming a helper or a store
rather than an action a user takes.

A **trailing underscore** is a different convention: `router_`, `treasury_`, `minBond_`. It marks a
*function argument whose name would otherwise collide with a state variable of the same name*.
`setRouter(address router_)` sets `router = router_`. Without the underscore the two would be
indistinguishable.

## A.4 What it's allowed to touch — mutability

| Keyword | Meaning |
|---|---|
| `view` | Reads state, changes nothing. **Free** when called from outside |
| `pure` | Doesn't even read state — pure arithmetic on its arguments. Also free |
| *(neither)* | Writes state. Costs gas, produces a transaction |
| `payable` | Can receive the chain's native coin. **Not used anywhere in this protocol** — all value moves as tokens |

`leverageBps` and `tierFactorBps` are `pure`: you can work out any agent's leverage from its score
without touching the chain. `getProfile` is `view`: it reads, and costs nothing.

## A.5 Where the data lives — storage / memory / calldata

This trips up everyone, and it changes behaviour, not just cost.

| Keyword | Meaning |
|---|---|
| `storage` | **A live reference to the real record on chain.** Writing through it writes permanently |
| `memory` | A scratch copy that vanishes when the function ends. Writing to it changes nothing permanent |
| `calldata` | The incoming transaction's raw data. Read-only, and the cheapest of the three |

Look at the difference in the router:

```
Request storage r = _load(requestId);   // real record — r.status = Settled sticks
AgentRegistry.Agent memory agent = registry.getAgent(r.agentId);   // a photocopy
```

The `Request` is `storage` because the router is about to change the job's status for real. The
`Agent` is `memory` because it came from another contract and is only being read — a change to it
would be scribbling on a photocopy.

**Analogy:** `storage` is the master ledger in the vault. `memory` is a photocopy on your desk.
`calldata` is the letter that arrived in the post — you can read it, you can't rewrite it.

Two related keywords, both about values that never change:

| Keyword | Meaning |
|---|---|
| `constant` | Fixed when the code is written. `UNBONDING_PERIOD = 21 days`, `NEUTRAL = 5000`, `MAX_ENROLMENT = 7 days` |
| `immutable` | Fixed once, when the contract is deployed, then never again. `bondToken`, `registry`, `engine` |

`immutable` is a security statement in itself: **the router's `registry`, `engine` and `bondToken`
addresses can never be changed, by anyone, including the owner.** They were burned in at deploy
time. Compare that with `inputAttestor` and `treasury`, which are ordinary variables the owner can
point elsewhere — behind a 21-day queue once `finalizeBootstrap()` has run (see `Timelocked`), but
still, eventually, elsewhere. That distinction *is* the trust model — worth checking on any
protocol, not just this one. A notice period changes when a redirection lands, not whether it can.

## A.6 The four declaration kinds

**`function`** — something that can be called.

**`modifier`** — a reusable check bolted onto a function. This:

```
modifier onlyRouter() {
    if (msg.sender != router) revert NotRouter();
    _;          // <- the function's own body runs here
}
```

means any function tagged `onlyRouter` gets that check run first, automatically. The `_;` is the
placeholder where the real body goes. **Analogy:** a doorman on a room. You write the rule once and
hang it on every door that needs it, instead of retyping it and eventually mistyping it.

**`event`** — a log line. `event Slashed(uint256 indexed agentId, uint256 amount, address indexed
recipient)`. The `indexed` keyword on up to three parameters makes them **searchable**: because
`agentId` is indexed, the website can ask the chain "every slash for agent 4" and get an answer.
Non-indexed fields are stored but can only be read once you've found the log. **Analogy:** indexed
fields are the tabs on a filing cabinet; the rest is the contents of the folder.

**`error`** — a named failure. `error CreditExceeded()` is the modern replacement for a text
message like `require(x, "credit exceeded")`. It costs dramatically less gas and it's precise: a
tool can tell `DeadlinePassed` from `DeadlineNotPassed` exactly, where two similar strings are just
two similar strings. Every error in this codebase is listed in Part B, and each one tells you
precisely what you did wrong.

## A.7 `transferFrom` vs `safeTransferFrom` — the one you asked about

These are two different things with confusingly similar names.

**`transferFrom(from, to, amount)`** is a function on the **token contract**. It means: *move
somebody else's tokens.* It only works if that somebody has already granted permission by calling
`approve(spender, amount)` on the token.

This is why every guide says "approve first." The sequence is always:

```
1. You  →  token contract  :  approve(router, 100)      "the router may take up to 100"
2. You  →  router          :  requestExecution(...)
3.         router → token  :  transferFrom(you, router, 100)   the router pulls it
```

Step 1 is a separate transaction, to a completely different contract. Skip it and step 3 fails and
the whole request reverts.

**Why pull instead of push?** Because a contract cannot ask you to send it money mid-call. Allowance
inverts it: you pre-authorise a ceiling, and the contract draws down what it needs, when it needs
it. **Analogy:** a direct debit mandate. You authorise the counterparty to take up to an amount;
they collect. You don't stand at the bank each month.

**`safeTransferFrom(token, from, to, amount)`** is not on the token. It's a helper in this
codebase's `SafeTransfer` library, and it *wraps* the token call. Its job is to handle a genuine
mess in the token standard: the spec says transfers return true or false, but a number of widely
used tokens — including USDT, which is the intended bond token here — **return nothing at all.**

Naive code that insists on reading a `bool` back simply fails against those tokens. Naive code that
ignores the return value silently treats a *failed* transfer as a success — which is far worse,
because the protocol then credits money it never received.

So the helper handles all three cases: the call must succeed, and *if* any data came back it must
decode to true; no data is accepted as success. Anything else raises `TransferFailed`.

**Analogy:** some couriers give you a signed receipt and some just leave the parcel. The rule that
works for both is: it arrived, and if there *is* a receipt it doesn't say "refused." A rule
demanding a receipt from everyone rejects half the couriers; a rule ignoring receipts entirely
accepts a "refused" slip as a delivery.

**That tolerance is exactly why the helper also checks the address has code.** Accepting silence as
success has a sharp edge: calling an address with *no contract at it* also succeeds and also returns
nothing. Byte for byte, "the token moved your money and said nothing" and "there is no token here at
all" are the same answer. Without a check, the library reports both as a transfer.

The failure that produces is silent, total and permanent. A wrong constructor argument — a typo in
an address, a testnet token pasted into a mainnet deploy — and every deposit, fee and slash appears
to work while nothing moves. `getProfile` reports bonds the protocol does not hold, and the first
sign of trouble is a withdrawal that cannot be paid. So `safeTransfer` and `safeTransferFrom` each
begin with a one-word check that the address has code, and raise `NotAContract` if it does not.

**Analogy:** the courier rule above works only if the address on the parcel is a building. Deliver to
an empty lot and the driver comes back reporting no problem — nobody refused anything. "No
complaint" is only evidence of delivery once you know there was somebody there to complain.

The check costs one `EXTCODESIZE` per transfer and moves the failure to the **first deposit**, where
it is a revert on the very first transaction against a misconfigured deployment, rather than to the
first withdrawal, where it is a hole in the balance sheet.

The same pattern gives `safeTransfer` for sending the contract's own tokens.

## A.8 Basis points

`Bps` is on the end of a dozen variable names. A **basis point is one hundredth of one percent**, so
`10_000` bps = 100%.

| Bps | Percent |
|---|---|
| 10 | 0.1% |
| 200 | 2% |
| 500 | 5% |
| 2,000 | 20% |
| 6,000 | 60% |
| 10,000 | 100% |

Percentages are used because contracts have **no decimals** — there is no 0.05 in Solidity. So a
percentage is expressed as a whole number of basis points and applied as `amount * bps / 10_000`.
The multiply comes before the divide, always, because dividing first would round the fraction away
to zero before it could do anything.

Two things: the underscores in `10_000` are just readability, ignored by the compiler. And note that
`bps` values in this codebase are used two different ways — as a **share** (`protocolFeeBps` is 5% of
the fee) and as a **rate** (`realizedPnlBps` of −300 means the job lost 3% of its notional). Same
unit, different sentence.

---
---

# Part B — every named thing, contract by contract

Listed in dependency order: the shared pieces first, then the ones built on them.

---

## B.1 `Utils.sol`

Three separate pieces in one file.

### `interface IERC20`

Not a contract — a description of the shape of a token, so this codebase can talk to one.

| Function | What it does |
|---|---|
| `transfer(to, amount)` | Move **my own** tokens to someone |
| `transferFrom(from, to, amount)` | Move **someone else's** tokens, using an allowance they granted |
| `balanceOf(account)` | How many tokens an account holds |

Deliberately minimal. It declares only what `SafeTransfer` actually calls — so it has **no
`approve` and no `decimals`.** That is intentional: approving is something *users* do to the token
directly, never something the protocol does on their behalf, and a protocol that could call
`approve` on your behalf would be a protocol that could move your money.

### `library SafeTransfer`

| Member | Kind | What it does |
|---|---|---|
| `TransferFailed()` | error | The token call failed, or returned an explicit false |
| `NotAContract()` | error | There is no code at the token address, so "no complaint" proves nothing |
| `safeTransfer(token, to, amount)` | internal | Send the contract's own tokens, checking the result properly |
| `safeTransferFrom(token, from, to, amount)` | internal | Pull tokens using an allowance, checking the result properly |

See A.7 for the reasoning. A `library` is a bundle of functions with no storage of its own — the
`using SafeTransfer for IERC20` line at the top of the registry and router is what lets them write
`bondToken.safeTransfer(...)` as though the token had that function itself.

### `abstract contract Ownable`

`abstract` means it can't be deployed on its own — it exists to be inherited. `AgentRegistry`,
`ExecutionRouter`, `ReputationEngine`, `InputAttestor`, `TeeAdapter` and `ZkAdapter` all inherit it.
(`SignatureAdapter` does not — it has nothing to configure.)

| Name | Kind | Detail |
|---|---|---|
| `owner` | `address public` | Who currently controls admin functions |
| `pendingOwner` | `address public` | Nominated successor who hasn't accepted yet |
| `NotOwner()` | error | You aren't the owner — or, on `acceptOwnership`, you aren't the nominee |
| `OwnershipTransferStarted(from, to)` | event | A handover was proposed |
| `OwnershipTransferred(from, to)` | event | A handover completed. Also emitted at deployment, from `address(0)` |
| `onlyOwner` | modifier | Reverts unless `msg.sender == owner` |
| `constructor(initialOwner)` | | Runs once at deployment, sets the first owner |
| `transferOwnership(newOwner)` | onlyOwner | **Nominates.** Does not transfer |
| `acceptOwnership()` | nominee only | **Completes.** Clears `pendingOwner` |

A `constructor` is the one function that runs exactly once, at deployment, and then no longer
exists. It's the setup, not part of the running contract.

### `abstract contract Timelocked is Ownable`

A queue-then-execute notice period on the handful of setters that can **redirect trust**.
`AgentRegistry`, `ExecutionRouter`, `ReputationEngine` and `ZkAdapter` inherit it.

| Name | Kind | Detail |
|---|---|---|
| `TIMELOCK_DELAY` | `uint64 public constant` = 21 days | How long a queued action waits. Equal to `AgentRegistry.UNBONDING_PERIOD` |
| `TIMELOCK_GRACE` | `uint64 public constant` = 14 days | How long after its `eta` a queued action stays executable |
| `timelockEta` | `mapping(bytes32 => uint64) public` | Earliest execution time by action id. **Zero means not queued** |
| `bootstrapped` | `bool public` | Whether the delay is live. One-way |
| `NotQueued()` | error | No entry for this action id — including "you queued a *different* action" |
| `Premature()` | error | Before the `eta` |
| `Stale()` | error | Past `eta + TIMELOCK_GRACE` |
| `AlreadyBootstrapped()` | error | `finalizeBootstrap` called twice |
| `ActionQueued(action, eta)` | event | Alongside the typed `*Queued` event on each contract |
| `ActionCancelled(action)` | event | A queued action was withdrawn |
| `Bootstrapped()` | event | The delay went live |
| `finalizeBootstrap()` | onlyOwner | Closes the deployment window. **Cannot be undone** |
| `cancel(action)` | onlyOwner | Withdraw a queued action before it executes |
| `_queue(action)` | internal, onlyOwner | Stamps `block.timestamp + TIMELOCK_DELAY` and emits. Re-queueing restarts the clock |
| `_consume(action)` | internal | Checks the window and **deletes the entry**, so executing twice needs announcing twice. No-op while `!bootstrapped` |

**What it covers, and why only that.** Six setters: `AgentRegistry.setRouter` and `setTreasury`,
`ReputationEngine.setWriter`, `ExecutionRouter.setAdapter` and `setInputAttestor`, and
`ZkAdapter.setRouter`. These are the
ones that point a contract at code it did not previously depend on. Swapping the Bronze adapter for
one whose `verify` returns true unconditionally does not look like theft in any event these
contracts emit — every delivery afterwards is simply accepted and every challenge against one
loses. The economic parameters are deliberately **not** covered: each is bounded in its own setter,
they move on a different cadence, and none of them can make a dishonest execution verify. Three
weeks in front of a fee change buys nothing and teaches everyone to route around the mechanism.

**Why 21 days.** An agent that objects to a rewiring has exactly one remedy — withdraw its bond —
and that takes `UNBONDING_PERIOD`. A notice period shorter than the exit it exists to permit is a
notice period that does nothing. Both are constants, and each constructor asserts the relation, so
they cannot drift apart silently.

**Why a grace window.** Without an expiry, a queue entry is a standing option: an owner could queue
a rewiring, let the objection pass unremarked, and execute it two years later against an audience
that had long since stopped watching. Past `eta + 14 days` the plan has to be announced again.

**Why `bootstrapped` exists.** Wiring a protocol takes six calls that all have to land before
anything works, and a three-week wait between deploying the router and telling the registry about
it would make deployment impossible rather than safe. The setters therefore run immediately until
`finalizeBootstrap()`, which the deploy script calls **last** on every contract that has one —
the engine, the registry, the router, and the Gold adapter — and records in the manifest. That it is one-way is the whole guarantee — and it is worth being explicit about what
it does not guarantee: a deployment that never calls it has no timelock at all. `bootstrapped()`
returning false on a live deployment is a finding, not a detail.

**Action ids.** Each guarded setter has a matching `queue*` and a `*Action(...)` view returning the
id, because `cancel` takes a raw `bytes32` and an id reconstructed by hand off a slightly different
encoding cancels nothing while looking exactly like it worked. The id commits to the **selector and
every argument**, which is what stops a queued grant from executing as a revocation, an adapter
queued for Silver from landing on Gold, or a queued treasury change from executing as a router
change to the same address.

**Analogy:** a landlord can change the tenancy terms whenever they like, but changing the locks
takes notice — long enough that anyone who objects can move out first. It is a notice period, not a
veto. Nobody can stop a queued change; they can only see it coming and leave.

---

## B.2 `Types.sol`

No functions, no storage — pure definitions shared by everything else.

### `enum Tier`

| Value | Number | Meaning |
|---|---|---|
| `None` | 0 | Unset. Never valid for a real agent |
| `Bronze` | 1 | Operator signature |
| `Silver` | 2 | Secure-hardware attestation |
| `Gold` | 3 | Zero-knowledge proof |

The order matters mechanically: `meetsPolicy` does `a.tier < policy.minTier`, which only means
anything because the numbers ascend with strength. `None` being 0 is also load-bearing — an
unwritten record naturally reads as `None`, so "no tier" and "never registered" are the same value.

### `enum Status`

| Value | Number | Meaning |
|---|---|---|
| `None` | 0 | No such job. Unwritten storage reads as this, which is how `_load` detects a bad id |
| `Pending` | 1 | Ordered, awaiting delivery |
| `Delivered` | 2 | Delivered, inside the challenge window |
| `Challenged` | 3 | Challenged, awaiting an escalation proof |
| `Finalized` | 4 | Evidence settled, awaiting economic settlement |
| `Settled` | 5 | **Terminal.** Outcome recorded, fee paid |
| `Expired` | 6 | **Terminal.** Never delivered — liveness fault |
| `Faulted` | 7 | **Terminal.** Lost a challenge — verification fault |
| `Rejected` | 8 | **Terminal.** The operator declined the order inside the rejection window. No fault, no slash, fee refunded |

### `struct VerificationContext`

The seven facts describing one execution. Built fresh by the router on every delivery, handed to an
adapter, never stored.

| Field | Type | What it is |
|---|---|---|
| `requestId` | `bytes32` | Which job. Stops a proof being reused on a different one |
| `agentId` | `uint256` | Which agent |
| `modelCommitment` | `bytes32` | Which model. Stops a silent model swap |
| `inputCommitment` | `bytes32` | Which data |
| `outputCommitment` | `bytes32` | Which result |
| `deliverBy` | `uint64` | The deadline |
| `operator` | `address` | The key expected to have signed. **Not hashed into the digest** — see 3.3 |

### `struct Outcome`

| Field | Type | What it is |
|---|---|---|
| `realizedPnlBps` | `int256` | Profit or loss in basis points of notional. **Signed** — negative is a loss |
| `slaBreached` | `bool` | Late or out of spec |
| `limitBreached` | `bool` | Exceeded the agent's declared risk limits |

### `struct Request`

The full record of one job, kept in the router's `_requests` mapping.

| Field | Type | What it is |
|---|---|---|
| `consumer` | `address` | Who ordered it. Only this address may `settle` |
| `agentId` | `uint256` | Who was hired |
| `inputCommitment` | `bytes32` | The frozen data, fixed at order time |
| `outputCommitment` | `bytes32` | The result. Zero until delivery |
| `notional` | `uint128` | Capital the decision governs. Weight of the score update |
| `fee` | `uint128` | Escrowed payment |
| `createdAt` | `uint64` | When ordered. **Input freshness is measured against this** |
| `deliverBy` | `uint64` | Delivery deadline. Past it, anyone may `markExpired` |
| `finalizeAt` | `uint64` | When the challenge window closes. Set at delivery |
| `settleBy` | `uint64` | Settlement deadline. Set at delivery |
| `tier` | `Tier` | The tier actually delivered at. Upgraded to Gold by a won challenge |
| `status` | `Status` | Where it is in the lifecycle |
| `challenger` | `address` | Who challenged, if anyone |
| `challengeBond` | `uint128` | Their deposit, held here |
| `escalationDeadline` | `uint64` | When the agent's window to answer closes |

### `struct Policy`

The customer's hiring rules, passed into `meetsPolicy`. Not stored anywhere.

| Field | Type | Rule |
|---|---|---|
| `minScore` | `uint32` | Reject below this score |
| `minTier` | `Tier` | Reject weaker evidence |
| `maxFaults` | `uint32` | Reject more faults than this |
| `minBond` | `uint256` | Reject a thinner bond |
| `maxStalenessSeconds` | `uint64` | Reject if idle longer than this. **Zero disables the check** |

### `struct Profile`

The public summary, assembled by `getProfile`. Never stored — built fresh on read, which is why the
score in it is always decayed to now.

| Field | What it is |
|---|---|
| `owner`, `tier`, `active` | Identity |
| `score`, `faults`, `settledExecutions`, `lastActiveAt` | Track record |
| `bond`, `openNotional`, `maxOpenNotional` | Capital position |

---

## B.3 `Digest.sol`

| Name | Kind | Detail |
|---|---|---|
| `DOMAIN_TYPEHASH` | `bytes32 internal constant` | `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` |
| `DOMAIN_NAME`, `DOMAIN_VERSION` | `bytes32 internal constant` | `keccak256("BotID")` and `keccak256("1")`, hashed at compile time |
| `EXECUTION_TYPEHASH` | `bytes32 internal constant` | A hash of the *text of the field list*. If the field list ever changes, this constant changes, and every old signature stops verifying automatically |
| `domainSeparator(verifyingContract)` | `internal view` | The EIP-712 domain hash. Reads `block.chainid` **live** rather than caching it in an immutable — the saving is one keccak over five words, and the cost of caching is that every signature stays valid on both sides of a chain split |
| `toTypedDataHash(verifyingContract, structHash)` | `internal view` | `keccak256(0x1901 ‖ domainSeparator ‖ structHash)` |
| `execution(ctx, verifier)` | `internal view` | Hashes six of the seven context fields into a struct hash, then wraps it in the envelope for `verifier` |

Three levels of scoping in one hash: **which schema** (typehash), **which chain** (chainid), **which
checker** (verifying contract). A signature is valid for exactly one job, on one chain, at one
adapter. The last two now live in the domain rather than in the struct, which is where EIP-712 puts
them; they bind exactly as tightly as before.

`Digest` is a library, so its constants have no on-chain getter. Two mixins in the same file supply
what tooling and the relayer need:

| Name | Kind | Detail |
|---|---|---|
| `EIP712Domain.DOMAIN_SEPARATOR()` | `external view` | The separator this contract verifies under. What the relayer checks its own domain against at startup |
| `EIP712Domain.eip712Domain()` | `external view` | ERC-5267 discovery. Returns `fields = 0x0f`, `"BotID"`, `"1"`, `block.chainid`, `address(this)`, no salt, no extensions |
| `ExecutionVerifier.executionDigest(ctx)` | `external view` | The exact bytes an attestation for `ctx` must be signed over **at this adapter** |

`InputAttestor` inherits `EIP712Domain`; `SignatureAdapter` and `TeeAdapter` inherit
`ExecutionVerifier`, which extends it. `ZkAdapter` inherits neither: a Gold attestation is a proof,
not a signature, so it has no execution digest to disagree about.

---

## B.4 `ScoreMath.sol`

| Name | Kind | Detail |
|---|---|---|
| `MAX_SCORE` | `uint32 constant` = 10,000 | Top of the scale |
| `NEUTRAL` | `uint32 constant` = 5,000 | Starting score, and the value decay pulls toward |
| `decay(score, elapsed, halfLife)` | `internal pure` | Halves the *distance from neutral* once per half-life, interpolating the remainder. Returns `NEUTRAL` outright after 32 half-lives — beyond that the distance has rounded away anyway |
| `observe(score, quality, weight, halfWeight)` | `internal pure` | The EWMA. `score + (quality − score) × weight ÷ (weight + halfWeight)`. **Weight zero returns the score unchanged** — a zero-notional job carries no signal at all |
| `haircut(score, bps)` | `internal pure` | Multiply the score down. Faults only |
| `quality(outcome, lossToleranceBps)` | `internal pure` | Turn one finished job into a mark out of 10,000. Section 5A |

`internal` here means these are compiled directly into whoever uses them — the engine holds the
maths, not a call out to another address.

---

## B.5 The four interfaces

An `interface` declares function signatures without bodies. It's a contract's advertised shape,
letting one contract call another it has never seen the code of.

### `IVerificationAdapter`

| Function | Purpose |
|---|---|
| `tier()` | Which tier do you attest to? Used by `setAdapter` to check an adapter isn't registered under the wrong tier |
| `verify(ctx, attestation)` | Is this evidence valid for exactly this context? |

### `IInputAttestor`

| Member | Purpose |
|---|---|
| `struct FeedAttestation` | One reading: `feedId`, `valueHash`, `timestamp`, `bytes[] signatures` |
| `verifyInputs(commitment, bundle, asOf)` | Genuine, fresh, and matching the commitment? |
| `commit(feeds)` | The canonical hash of an ordered bundle |

`commit` is on the *interface* rather than kept private for one specific reason: the Gold adapter
re-derives a commitment from revealed values, and it calls this rather than reimplementing the
hashing rule. **One definition, so the two can never drift apart** — two copies of a hashing
convention is a bug waiting for someone to edit one of them.

### `IReputationEngine` — the write side

| Member | Purpose |
|---|---|
| `enum FaultKind` | `Liveness` (0) = accepted and never delivered; `Verification` (1) = lost a challenge |
| `initAgent(agentId)` | Open a file at neutral |
| `recordOutcome(agentId, consumer, outcome, notional, lossToleranceBps)` | Fold in a settled job, weighted by `consumer`'s remaining budget |
| `recordFault(agentId, kind)` | Apply a haircut and increment the counter |
| `getScore` / `getStats` / `remainingWeight` | Reads |

### `IReputationOracle` — the read side, for customers

| Function | Purpose |
|---|---|
| `getProfile(agentId)` | Everything public, score decayed to now |
| `getScore(agentId)` | Just the number |
| `meetsPolicy(agentId, policy)` | Yes or no against **your** rules |
| `availableCredit(agentId)` | How much more they can take on right now |

The split is the point. **A consumer protocol integrates against `IReputationOracle` and nothing
else.** Everything on the write side is internal machinery. Two interfaces instead of one is what
lets the read surface stay small and stable while the internals change.

---

## B.6 `InputAttestor.sol`

### State

| Name | Type | What it is |
|---|---|---|
| `FEED_TYPEHASH` | `bytes32 public constant` | The EIP-712 type hash for a single reading — `FeedReading(bytes32 feedId,bytes32 valueHash,uint64 timestamp)`. Public, so the relayer can check its own copy against the chain |
| `publishers` | `mapping(address => bool) public` | Which data sources count |
| `publisherCount` | `uint256 public` | How many, because a mapping cannot count itself |
| `quorum` | `uint256 public` | How many independent signatures each reading needs. Default 1 |
| `maxAge` | `uint64 public` | How stale a reading may be. Default 5 minutes |

### Functions

| Function | Who | What it does |
|---|---|---|
| `setPublisher(publisher, allowed)` | owner | Add or remove a source. Returns early if nothing changes, so `publisherCount` can't drift |
| `setQuorum(quorum_, maxAge_)` | owner | **Cannot set a quorum above the publisher count** — that would be an unmeetable threshold that bricks every delivery |
| `feedDigest(feedId, valueHash, timestamp)` | anyone, view | The exact bytes a publisher signs — an EIP-712 typed-data hash under this contract's own domain |
| `DOMAIN_SEPARATOR()` | anyone, view | Inherited from `EIP712Domain`. See §B.3 |
| `eip712Domain()` | anyone, view | ERC-5267 discovery. Inherited. See §B.3 |
| `commit(feeds)` | anyone, view | Hash of the ordered bundle. **Order is significant.** Signatures are *not* part of it, so a caller wanting only the hash can pass empty signature arrays |
| `verifyInputs(commitment, bundle, asOf)` | anyone, view | The real check — decode, verify each reading, then compare the commitment |
| `_tryRecover(digest, signature)` | private, pure | Recover a signer, returning `address(0)` rather than reverting on a malformed one |

### Events and errors

| Name | Kind | When |
|---|---|---|
| `PublisherSet(publisher, allowed)` | event | A source was added or removed |
| `QuorumSet(quorum, maxAge)` | event | Thresholds changed |
| `InvalidParameter()` | error | Quorum of zero, quorum above the publisher count, or max age of zero |

### What `verifyInputs` actually checks, in order

1. The bundle decodes and isn't empty.
2. For each reading: not from the future (`timestamp > asOf` fails), and not older than `maxAge`
   before `asOf`.
3. Each signature recovers to a **registered publisher**, and signers are in **strictly ascending
   address order.** That ordering is a cheap deduplication — the same publisher cannot sign three
   times to satisfy a quorum of three alone, because the second one wouldn't be greater than the
   first.
4. Enough valid signatures to meet the quorum.
5. Finally, the re-derived commitment equals the one from the request.

A note on `_tryRecover`'s `s > 0x7FFF...` check: every valid signature has a mirror-image twin that
is equally valid for the same key. Left alone, that means one signature has two forms, and anything
counting distinct signatures could be fooled by the same one twice. Rejecting the upper half of the
range makes the form unique.

---

## B.7 `SignatureAdapter.sol` — Bronze

The whole contract is two functions and no storage.

| Function | Detail |
|---|---|
| `tier()` | Returns `Tier.Bronze` |
| `verify(ctx, attestation)` | `attestation` is exactly 65 bytes: r (32) + s (32) + v (1). Recovers the signer and returns whether it equals `ctx.operator` |

Four rejections, all silent `false` rather than reverts: wrong length, `s` in the upper range,
`v` outside {27, 28}, and a recovered `address(0)`.

Note `verify` is `view` even though this adapter has no storage at all. It has to be: it calls
`Digest.execution`, which reads `block.chainid`, and reading anything from the chain — even a
constant of the chain itself — is enough to disqualify `pure`.

---

## B.8 `TeeAdapter.sol` — Silver

### State

| Name | Type | What it is |
|---|---|---|
| `MAX_ENROLMENT` | `uint64 public constant` = 7 days | Longest an enrolment may last |
| `allowedMeasurements` | `mapping(bytes32 => bool) public` | Which code fingerprints are approved |
| `enrolments` | `mapping(address => Enrolment) public` | Enclave key → what it's running and when it expires |
| `notaries` | `mapping(address => bool) public` | Who may enrol and revoke |

`struct Enrolment { bytes32 measurement; uint64 expiresAt; }` — a measurement is a hash of the
exact code loaded into the secure compartment. Change one line of that program and the measurement
changes, so approving a measurement is approving a specific build.

### Functions

| Function | Who | What it does |
|---|---|---|
| `tier()` | anyone | Returns `Tier.Silver` |
| `setNotary(notary, allowed)` | owner | Who may vouch |
| `setMeasurement(measurement, allowed)` | owner | Which builds are acceptable |
| `enroll(enclaveKey, measurement, expiresAt)` | **notary** | Vouch for a key. Rejects an unapproved measurement, an expiry in the past, or one more than 7 days out |
| `revoke(enclaveKey)` | **notary** | Kill an enrolment immediately |
| `verify(ctx, attestation)` | anyone, view | `attestation` decodes to (enclave key, signature). Checks the enrolment is unexpired, its measurement still approved, and the signature is over the digest **combined with the measurement** |

### Events and errors

| Name | Kind | When |
|---|---|---|
| `NotarySet` / `MeasurementSet` | events | Configuration changed |
| `EnclaveEnrolled(key, measurement, expiresAt)` | event | A key was vouched for |
| `EnclaveRevoked(key)` | event | A key was killed |
| `NotNotary()` | error | You aren't a notary |
| `InvalidParameter()` | error | Zero key, unapproved measurement, or a bad expiry |

Two asymmetries worth noticing, both deliberate. `revoke` needs no owner action and no waiting —
**revocation must be faster than enrolment, never slower.** And the measurement is checked *again*
at verification time, not only at enrolment, so disapproving a build instantly invalidates every
key running it without having to hunt them down individually.

---

## B.9 `ZkAdapter.sol` — Gold

The most intricate contract here.

### State and constants

| Name | Type | What it is |
|---|---|---|
| `P` | `uint256 internal constant` | The bn254 field size. Proof values live in a finite number system that wraps around at this number — so a negative value `−x` arrives as `P − x` |
| `MAX_ABS` | `int256 internal constant` = 2^128 | Values beyond this are rejected **before** being mapped into the field |
| `MAX_SCALE_BITS` | `uint8 internal constant` = 64 | Ceiling on the registered shift |
| `modelFor` | `mapping(bytes32 => Model) public` | Model commitment → its verifier and shift |
| `inputAttestor` | `IInputAttestor public` | Where the hashing convention comes from |
| `provenBy` | `mapping(bytes32 => uint256) public` | Work key → the agent credited with proving it first. Written once, never rewritten |
| `router` | `address public` | The only caller allowed to write `provenBy`. See `verifyAndAttribute` |

`struct Model { IEzklVerifier verifier; uint8 inputScaleBits; }`
`struct Reveal { bytes32 feedId; uint64 timestamp; int256 value; bytes32 salt; }`

The `MAX_ABS` bound is a real attack being closed, not caution. Without it, a value just below `P`
would fold into a small innocent-looking positive number, letting a reveal claim one figure while
the circuit saw another. No honest quantisation produces magnitudes near that bound, so nothing
legitimate is excluded.

The `salt` in a `Reveal` is a random value hashed alongside the number. Its job: an input commitment
is public from the moment the order is placed, and without a salt anyone could guess-and-check small
values against the hash until they found the price. The salt makes the reading unguessable until
it's deliberately revealed.

### Functions

| Function | Who | What it does |
|---|---|---|
| `tier()` | anyone | Returns `Tier.Gold` |
| `setVerifier(modelCommitment, verifier, inputScaleBits)` | owner | Register a circuit. The shift comes from the model's own settings file — guessing it makes every proof for that model fail |
| `setInputAttestor(attestor)` | owner | Must match the router's, or every honest proof fails closed |
| `queueRouter(router_)` / `setRouter(router_)` / `routerAction(router_)` | owner | Point at the router. Queued 21 days ahead once bootstrapped, for the same reason `AgentRegistry.setRouter` is |
| `canVerify(modelCommitment)` | anyone, view | Whether a circuit is registered for this model at all — "could this agent be held to a proof", which is what `ExecutionRouter.challenge` asks before it accepts one |
| `verify(ctx, attestation)` | anyone, view | The main event, below |
| `verifyAndAttribute(ctx, attestation)` | **router only** | `verify`, plus the first-write-wins record of who presented this proof first. Reverts `NotRouter` for anyone else |
| `workKeyFor(modelCommitment, instances)` | anyone, pure | **Helper.** The key `provenBy` records under, so an operator can check whether the work it is about to deliver has already been claimed |
| `inputCommitmentFor(reveals)` | anyone, view | **Helper.** What commitment these reveals produce |
| `expectedInputInstances(modelCommitment, reveals)` | anyone, view | **Helper.** What the circuit's input cells must be |
| `outputCommitmentFor(outputs)` | anyone, pure | **Helper.** What the output cells must hash to |
| `_bindsInputs(...)` | private | Reveals reproduce the commitment, and match the instance cells |
| `_bindsOutputs(...)` | private | The tail of the instances hashes to the output commitment |
| `_commit(reveals)` | private | Re-derives the bundle hash **via the attestor** |
| `_toField(value, bits)` | private, pure | Quantise, then fold negatives around the modulus |

The three helpers exist for a practical reason: generating a proof takes minutes. A prover can call
these first and find out for free whether the bundle was ever going to bind, instead of discovering
it after the compute is spent.

`_commit` deliberately passes **empty signature arrays**. The router already checked the publisher
quorum against this same commitment at delivery; re-checking here would only re-prove a settled
fact, at cost.

### Verification order

1. Look up the model. Unknown commitment → `false`.
2. Decode into `(proof, instances, reveals)`.
3. `nIn = reveals.length`. Reject if zero, or if there's no room for outputs.
4. Bind the inputs. Bind the outputs.
5. **Only then** call the verifier, inside a `try/catch` so a reverting verifier surfaces as
   `false` rather than an opaque failure.

Note step 3: **the split point between input cells and output cells is `reveals.length`, and
reveals are pinned by the customer's commitment.** So the boundary is fixed by the customer, not by
the party being checked. Let the agent choose it and it could reclassify an input as an output.

### `interface IEzklVerifier`

| Function | Detail |
|---|---|
| `verifyProof(proof, instances)` | The generated verifier contract's only function. Returns whether the proof is valid for those public values |

### Events and errors

| Name | Kind | When |
|---|---|---|
| `VerifierSet(modelCommitment, verifier, inputScaleBits)` | event | A circuit was registered |
| `InputAttestorSet(attestor)` | event | The attestor was pointed elsewhere |
| `RouterSet(router)` / `RouterQueued(router, eta)` | event | The router was pointed elsewhere, or announced |
| `WorkAttributed(workKey, agentId, requestId)` | event | An instance vector was credited to an agent for the first time |
| `InvalidParameter()` | error | Zero commitment, a shift above 64, or an unconvertible value |
| `NotRouter()` | error | Someone other than the router tried to write an attribution |

---

## B.10 `ReputationEngine.sol`

### State

| Name | Type | Default | What it is |
|---|---|---|---|
| `halfWeight` | `uint256 public` | 100,000 tokens | Job size at which one observation moves the score halfway. **The anti-grinding dial** |
| `weightCap` | `uint256 public` | 1,000,000 tokens | Ceiling on weight, so one outsized job can't dominate |
| `consumerWeightCap` | `uint256 public` | 50,000 tokens | Weight one **customer** may spend on one agent per half-life. Zero disables it |
| `decayHalfLife` | `uint256 public` | 90 days | How fast an idle score fades toward neutral |
| `livenessHaircutBps` | `uint32 public` | 1,500 (15%) | Cut for not delivering |
| `verificationHaircutBps` | `uint32 public` | 6,000 (60%) | Cut for a lost challenge |
| `_records` | `mapping(uint256 => Record) private` | | Agent id → its record |
| `_budgets` | `mapping(uint256 => mapping(address => Budget)) private` | | Agent id → customer → weight already spent. Read through `ScoreMath.fade`; the stored figure is stale by design |
| `writers` | `mapping(address => bool) public` | | Who may write. **The registry and the router, nobody else** |

`struct Record`:

| Field | What it is |
|---|---|
| `score` | The **stored** score — a snapshot, not necessarily current |
| `faults` | Lifetime fault count. Never decays, never resets |
| `settledExecutions` | Lifetime settled count |
| `lastUpdateAt` | When `score` was written. **Decay is measured from here** |
| `lastActiveAt` | Last time the agent **did its job**. What `maxStalenessSeconds` is checked against |
| `initialized` | Does this record exist? Distinguishes "new agent, score 5,000" from "no such agent" |

The two timestamps mean different things and are no longer always equal. `lastUpdateAt` moves on
every write, including a fault, because decay has to be measured from the last time the score was
written. `lastActiveAt` moves only on `initAgent` and `recordOutcome`, because it answers "when did
this agent last do its job" — and a fault is the opposite of doing the job. Stamping it on a fault
was self-defeating: an agent that had gone dark would accrue a liveness fault through `markExpired`,
and the fault itself would refresh its freshness, so any passer-by could restore a stale agent to
`meetsPolicy` eligibility for the price of gas by reporting that it had failed.

### Functions

| Function | Who | What it does |
|---|---|---|
| `queueWriter(writer, allowed)` | owner | Announce a change to the writer list. See `Timelocked` |
| `setWriter(writer, allowed)` | owner | Grant or revoke write access. **Queued 21 days ahead** once bootstrapped — including revocation, so the owner cannot silently stop the router recording faults |
| `writerAction(writer, allowed)` | anyone, view | The action id the pair above uses, and `cancel` expects |
| `setParameters(halfWeight_, weightCap_, consumerWeightCap_, decayHalfLife_, livenessHaircutBps_, verificationHaircutBps_)` | owner | Retune. Rejects zeros, haircuts above 100%, and a consumer cap that won't fit in 128 bits |
| `initAgent(agentId)` | **writer** | Open a file at neutral. Reverts if already open |
| `recordOutcome(agentId, consumer, outcome, notional, lossToleranceBps)` | **writer** | Decay → quality → cap the weight → **draw it from the customer's budget** → fold in → increment the settled count |
| `recordFault(agentId, kind)` | **writer** | Decay → haircut → increment the fault count |
| `getScore(agentId)` | anyone, view | **Decayed to now.** Returns 0 for an unknown agent |
| `getStats(agentId)` | anyone, view | Score, faults, settled count, last active |
| `remainingWeight(agentId, consumer)` | anyone, view | Weight that customer may still spend on that agent. `type(uint256).max` when the cap is disabled |
| `_spend(agentId, consumer, weight)` | private | Fades the stored budget to now, clamps `weight` to what's left, and books it |
| `_decayed(record)` | private, view | Applies decay from `lastUpdateAt` to now |

A customer whose budget is exhausted still gets weight zero rather than a revert, and `observe`
leaves the score untouched at zero weight. Its reports still settle, still pay the agent, and still
count toward `settledExecutions` — they simply stop moving the score. The protocol is declining to
take one party's word for it again, not declining to do business.

The counters use `unchecked { r.faults += 1; }`. Normally Solidity checks every addition for
overflow; `unchecked` skips that check to save gas. It's safe here because overflowing a 32-bit
counter needs four billion faults — the check is guarding against something that cannot occur.

### Events and errors

| Name | Kind | When |
|---|---|---|
| `WriterSet(writer, allowed)` | event | Write access changed |
| `WriterQueued(writer, allowed, eta)` | event | A change to the writer list was announced |
| `AgentInitialized(agentId, score)` | event | A file was opened |
| `OutcomeRecorded(agentId, consumer, quality, weight, newScore)` | event | A job settled. **Publishes the quality and the weight actually applied** — already clamped by both caps — so anyone can recompute the score move themselves, and see when a report was discounted |
| `FaultRecorded(agentId, kind, newScore, faults)` | event | A fault landed |
| `ParametersUpdated()` | event | Retuned |
| `NotWriter()` | error | You aren't on the writer list |
| `AlreadyInitialized()` / `NotInitialized()` | errors | Double registration / no such agent |
| `InvalidParameter()` | error | A zero or an out-of-range haircut |

---

## B.11 `AgentRegistry.sol`

### State

| Name | Type | Default | What it is |
|---|---|---|---|
| `bondToken` | `IERC20 public immutable` | | The bond currency. **Fixed at deployment, unchangeable** |
| `engine` | `IReputationEngine public immutable` | | The reputation engine. Also unchangeable |
| `UNBONDING_PERIOD` | `uint64 public constant` | 21 days | Withdrawal delay. **Not settable by anyone** |
| `minBond` | `uint256 public` | 500 tokens | Below this, credit is **zero** regardless of score |
| `globalNotionalCap` | `uint256 public` | 5,000,000 tokens | Hard ceiling per agent |
| `earlyExitPenaltyBps` | `uint32 public` | 1,000 (10%) | Toll for leaving early |
| `router` | `address public` | | The only address allowed to reserve, release and slash |
| `treasury` | `address public` | | Where penalties and the non-bounty share of slashes go |
| `_nextAgentId` | `uint256 private` | 1 | Next id. **Starts at 1, so 0 means "no agent"** |
| `_agents` | `mapping(uint256 => Agent) private` | | The records |
| `agentIdByOperator` | `mapping(address => uint256) public` | | Operator key → agent id. Enforces one key, one agent |

`struct Agent`:

| Field | Type | What it is |
|---|---|---|
| `owner` | `address` | The business. Receives fees, controls the bond |
| `operator` | `address` | The signing key. **Rotatable** |
| `modelCommitment` | `bytes32` | Which model. **Immutable — a new model is a new agent** |
| `tier` | `Tier` | Evidence strength |
| `active` | `bool` | Accepting work. Inactive means credit of zero |
| `lossToleranceBps` | `uint32` | Declared within-spec downside |
| `bond` | `uint256` | Posted capital. **This is where bonds live — not in a standalone mapping** |
| `openNotional` | `uint256` | Capital currently committed to in-flight jobs |
| `unbondingAmount` | `uint256` | Amount announced for withdrawal |
| `unbondingAt` | `uint64` | When it can be taken |

### Functions — admin

| Function | Who | What it does |
|---|---|---|
| `queueRouter(router_)` | owner | Announce a change of router. See `Timelocked` |
| `setRouter(router_)` | owner | Point at the router. **This is what wires the system together.** Queued 21 days ahead once bootstrapped |
| `queueTreasury(treasury_)` | owner | Announce a change of treasury |
| `setTreasury(treasury_)` | owner | Where penalties go. Queued 21 days ahead once bootstrapped. Nothing is held at this address between transactions, so a change cannot take anything retroactively — it redirects every future payment, which is worth announcing |
| `routerAction(router_)` / `treasuryAction(treasury_)` | anyone, view | The action ids the pairs above use |
| `setLimits(minBond_, globalNotionalCap_)` | owner | Rejects zeros |
| `setEarlyExitPenaltyBps(bps)` | owner | Capped at 100% |

### Functions — agent lifecycle

| Function | Who | What it does |
|---|---|---|
| `registerAgent(operator, modelCommitment, tier, lossToleranceBps, bondAmount)` | **anyone** | Creates the agent, takes the bond, opens the reputation file. Rejects a bond below the minimum, a zero or already-used operator key, tier `None`, or a tolerance above 100%. **Returns the new agent id** |
| `rotateOperator(agentId, newOperator)` | agent owner | New locks, same address. Clears the old key's mapping entry |
| `increaseBond(agentId, amount)` | **anyone** | Top up. Note: genuinely open — a third party can strengthen an agent's bond, and they cannot get it back, because only the owner can withdraw |
| `setActive(agentId, active)` | agent owner | Stop accepting new work. **Does not cancel jobs in flight** |
| `startUnbonding(agentId, amount)` | agent owner | Announce a withdrawal. Removes it from credit **immediately** and re-checks that open exposure still fits. Still slashable |
| `withdraw(agentId)` | agent owner | After 21 days, take it. Clamped to the remaining bond if slashed meanwhile |
| `withdrawEarly(agentId)` | agent owner | Leave sooner for a toll — **only with `openNotional == 0`**. Reverts if the period already elapsed, pointing you at the free door |

### Functions — router hooks

| Function | Who | What it does |
|---|---|---|
| `reserve(agentId, notional)` | **router only** | Add exposure. Reverts on an unknown agent, an inactive one, or an exceeded limit |
| `release(agentId, notional)` | **router only** | Free exposure. Floors at zero rather than underflowing |
| `slash(agentId, amount, bountyRecipient, bounty)` | **router only** | Take bond, split between bounty and treasury. Clamped to the remaining bond, and shrinks any pending unbonding to match |

### Functions — credit

| Function | Kind | What it does |
|---|---|---|
| `leverageBps(score)` | `public pure` | The step function. Callable by anyone, off chain, for free |
| `tierFactorBps(tier)` | `public pure` | Bronze 0.5×, Silver 1.0×, Gold 1.5× |
| `_maxOpenNotional(agentId, agent)` | `private view` | The formula. Returns **zero** for an inactive agent or an effective bond below the minimum |

### Functions — reads

| Function | What it returns |
|---|---|
| `getAgent(agentId)` | The whole `Agent` struct |
| `getProfile(agentId)` | The `Profile` — everything a customer wants, one call, score already decayed |
| `getScore(agentId)` | Forwards to the engine |
| `availableCredit(agentId)` | Headroom right now |
| `previewWithdrawEarly(agentId)` | `(allowed, paid, penalty)` — **so an interface can show the choice instead of discovering it by reverting.** Reports the penalty even when not allowed, because "you may not leave yet" and "leaving costs this much" are two different things an operator wants at once |
| `meetsPolicy(agentId, policy)` | One yes/no against the caller's own rules |
| `operatorOf(agentId)` | The current signing key |

### Events

| Event | When |
|---|---|
| `AgentRegistered(agentId, owner, operator, tier, modelCommitment, bond)` | Registration |
| `OperatorRotated(agentId, from, to)` | Key rotation |
| `BondIncreased(agentId, amount, total)` | Top-up |
| `UnbondingStarted(agentId, amount, availableAt)` | Exit announced |
| `Withdrawn(agentId, amount)` / `WithdrawnEarly(agentId, paid, penalty)` | Exit completed |
| `Slashed(agentId, amount, recipient)` | Bond taken |
| `ExposureChanged(agentId, openNotional)` | Every reserve and release |
| `ActiveSet(agentId, active)` | Availability toggled |
| `RouterSet(router)` | Wiring changed |
| `TreasurySet(treasury)` | Where penalties go changed. **Previously silent** |
| `RouterQueued(router, eta)` / `TreasuryQueued(treasury, eta)` | Either change was announced |

### Errors

| Error | Meaning |
|---|---|
| `NotRouter()` | Only the router may call that |
| `NotAgentOwner()` | Only the agent's owner may call that |
| `UnknownAgent()` | No such agent |
| `AgentInactive()` | The agent has switched itself off |
| `OperatorInUse()` | That key is zero, or already belongs to another agent |
| `BondTooLow()` | Below the minimum, or unbonding more than you have |
| `CreditExceeded()` | This job would blow the limit |
| `NothingToWithdraw()` | No unbonding in progress |
| `UnbondingNotElapsed()` | The 21 days aren't up |
| `UnbondingElapsed()` | They *are* up — use the free `withdraw` |
| `OutstandingLiability()` | You still have jobs in flight |
| `InvalidParameter()` | A bad admin value |

### Modifiers

| Modifier | Check |
|---|---|
| `onlyRouter` | `msg.sender == router` |
| `onlyAgentOwner(agentId)` | `msg.sender` owns that agent |
| `onlyOwner` | Inherited from `Ownable` |

---

## B.12 `ExecutionRouter.sol`

### State

| Name | Type | Default | What it is |
|---|---|---|---|
| `bondToken` | `IERC20 public immutable` | | Fee and bond currency. **Unchangeable** |
| `registry` | `AgentRegistry public immutable` | | **Unchangeable** |
| `engine` | `IReputationEngine public immutable` | | **Unchangeable** |
| `inputAttestor` | `IInputAttestor public` | | Data checker. **Changeable by the owner** — the one dependency that is |
| `adapters` | `mapping(Tier => IVerificationAdapter) public` | | Tier → its specialist |
| `challengeWindow` | `uint64 public` | 1 hour | How long a Bronze/Silver delivery is challengeable |
| `minDeliveryWindow` | `uint64 public` | 15 min | Shortest deadline an order may set. Below this every order is undeliverable by construction |
| `rejectionWindow` | `uint64 public` | 5 min | How long the operator has to decline an order. Must stay under `minDeliveryWindow` |
| `escalationWindow` | `uint64 public` | 6 hours | How long the agent has to answer |
| `settlementWindow` | `uint64 public` | 7 days | How long the customer has to report |
| `challengeBondAmount` | `uint256 public` | 100 tokens | Deposit to challenge. Held per request in a `uint128`, and `setParameters` refuses anything larger — see below |
| `faultSlashBps` | `uint32 public` | 2,000 (20%) | Lost challenge, of remaining bond |
| `livenessSlashBps` | `uint32 public` | 200 (2%) | Non-delivery, of remaining bond |
| `challengerBountyBps` | `uint32 public` | 5,000 (50%) | Share of the slash paid to whoever caught it |
| `protocolFeeBps` | `uint32 public` | 500 (5%) | The protocol's cut of the fee |
| `minFeeBps` | `uint32 public` | 10 (0.1%) | Fee floor as a share of notional |
| `treasury` | `address public` | | Where the cut goes |
| `_nonce` | `uint256 private` | | Counter making each request id unique |
| `_locked` | `uint256 private` | 1 | The reentrancy flag |
| `_requests` | `mapping(bytes32 => Request) private` | | Every job |

### The reentrancy guard

`nonReentrant` is on nearly every state-changing function. The attack it stops: a contract that
receives tokens can run code on receipt, and that code can call *back into* the router before the
first call has finished tidying up — potentially withdrawing twice from a balance that hasn't been
decremented yet. Reentrancy has drained more money from this industry than any other single bug.

The guard is a flag: set on the way in, cleared on the way out, and a second entry while it's set
reverts. **Analogy:** an engaged sign on a door that isn't just a courtesy — the door is actually
locked while you're inside.

### Functions — admin

| Function | Who | What it does |
|---|---|---|
| `queueAdapter(tier, adapter)` | owner | Announce an adapter change. See `Timelocked` |
| `setAdapter(tier, adapter)` | owner | Register a specialist. **Refuses an adapter whose own `tier()` disagrees** — you cannot register the Bronze checker as the Gold one. Refuses tier `None`. Address zero unregisters. **Queued 21 days ahead** once bootstrapped: an adapter *is* the verification, so this is the single most valuable thing the owner key can do |
| `queueInputAttestor(attestor)` | owner | Announce a change of input attestor |
| `setInputAttestor(attestor)` | owner | Swap the data checker. Queued 21 days ahead once bootstrapped. An attestor that accepts anything lets an agent pick its inputs after the fact |
| `adapterAction(tier, adapter)` / `inputAttestorAction(attestor)` | anyone, view | The action ids the pairs above use |
| `setMinFeeBps(minFeeBps_)` | owner | Capped at 1,000 (10%). Kept off `setParameters` because it's an economic lever on a different cadence — and because a call that must restate eight values to change one invites transcription mistakes |
| `setParameters(...eight values...)` | owner | The safety windows and slash rates. **Enforces that `settlementWindow + escalationWindow` stays inside the 21-day unbonding period**, or an agent could withdraw before the outcomes it is responsible for landed. Also refuses a `challengeBondAmount` above 2^128 − 1: `challenge` collects the full `uint256` but records `uint128(challengeBondAmount)` on the request, and every refund pays out the *recorded* field, so above that bound the amount taken and the amount returned are different numbers and the difference is unrecoverable. The bound is enforced here rather than at the cast so the revert lands on the governance call that is wrong, where it can still be corrected, instead of on the first challenger to post a bond |
| `setDeliveryWindows(minDeliveryWindow_, rejectionWindow_)` | owner | The order-time windows. Set together because they are the only two parameters with an invariant *between* them — rejection must be strictly shorter than delivery. Neither may be zero: either one alone reopens the griefing vector |

### Functions — the lifecycle

| Function | Who | Phase |
|---|---|---|
| `requestExecution(agentId, inputCommitment, notional, fee, deliverBy, inputURI)` | **anyone — the customer** | Order. Reserves credit, escrows the fee, returns the request id. Rejects a zero notional, a fee under the floor, and a deadline inside `minDeliveryWindow` |
| `deliver(requestId, outputCommitment, inputBundle, attestation)` | **operator only** | Deliver. Checks inputs, checks evidence, sets the clocks |
| `challenge(requestId)` | **anyone** | Demand escalation, posting a deposit. Only against an agent `canEscalate` answers true for |
| `resolveChallenge(requestId, zkProof)` | **operator only** | Answer with a Gold proof. **The deposit goes to the agent owner** |
| `slashUnresolvedChallenge(requestId)` | **anyone** | No proof in time. Slash, pay the challenger, refund the customer |
| `finalize(requestId)` | **anyone** | Close an unchallenged window. The only lifecycle function with **no** reentrancy guard, because it moves no money |
| `settle(requestId, outcome)` | **customer only** | Report the result. **The score moves here** |
| `settleDefault(requestId)` | **anyone** | After the window, settle at par so a silent customer can't hold the agent hostage. **The score does not move** — the outcome is recorded at zero weight |
| `canEscalate(agentId)` | **view** | Whether the agent could answer a challenge with a Gold proof today. False means its deliveries are undisputable |
| `reject(requestId)` | **operator only** | Decline an order, within `rejectionWindow` of it being placed. Releases the credit and refunds the fee. **No fault, no slash** |
| `markExpired(requestId)` | **anyone** | Never delivered. Slash, record a liveness fault, refund the customer |

### Functions — internal

| Function | What it does |
|---|---|
| `_verify(...)` | Builds the `VerificationContext` and calls the tier's adapter. Reverts `NoAdapter` if none is registered |
| `_settle(...)` | Release exposure → record the outcome → split the fee 5%/95% |
| `_slash(agentId, bps, bountyRecipient)` | Works out the amount from the **remaining** bond and the bounty share, then asks the registry to do it |
| `_load(requestId)` | Fetches a job as `storage`, reverting `UnknownRequest` if its status is `None` |

| Read | Returns |
|---|---|
| `getRequest(requestId)` | The whole `Request` struct |

### Events

| Event | When |
|---|---|
| `ExecutionRequested(requestId, agentId, consumer, inputCommitment, notional, fee, deliverBy, inputURI)` | Ordered. **The only place `inputURI` appears — emitted, never stored** |
| `ExecutionDelivered(requestId, agentId, outputCommitment, tier)` | Delivered |
| `ExecutionChallenged(requestId, challenger)` | Challenged |
| `ChallengeResolved(requestId, challenger, bondToAgent)` | Challenge answered |
| `ExecutionFaulted(requestId, agentId, slashed)` | Challenge lost |
| `ExecutionFinalized(requestId, tier)` | Evidence final |
| `ExecutionSettled(requestId, agentId, realizedPnlBps)` | Settled |
| `ExecutionExpired(requestId, agentId, slashed)` | Never delivered |
| `ExecutionRejected(requestId, agentId, consumer)` | Declined at order time. No fault, no slash |
| `AdapterSet(tier, adapter)` / `ParametersUpdated()` | Configuration |
| `InputAttestorSet(attestor)` | Where every input bundle is checked. **Previously silent** |
| `AdapterQueued(tier, adapter, eta)` / `InputAttestorQueued(attestor, eta)` | Either change was announced |

The nine lifecycle events above the configuration rows are the entire history of the protocol —
the rest are governance. The website is built from them, and
anyone can rebuild the same view independently — that is what "verifiable" means in practice.

### Errors

| Error | Meaning |
|---|---|
| `Reentrancy()` | A call tried to re-enter mid-flight |
| `UnknownRequest()` | No such job |
| `BadStatus()` | Right job, wrong phase — e.g. settling something not yet finalised |
| `NotOperator()` / `NotConsumer()` | Wrong party |
| `DeadlinePassed()` | Too late |
| `DeadlineNotPassed()` | **Too early** — the mirror image, and a separate error so tools can tell them apart |
| `InputAttestationFailed()` | The bundle isn't genuine, fresh, or matching |
| `VerificationFailed()` | The evidence didn't check out |
| `NoAdapter()` | No specialist registered for that tier |
| `InvalidParameter()` | A bad admin value |
| `FeeBelowFloor()` | The fee is under `minFeeBps` of notional |
| `DeliveryWindowTooShort()` | The deadline is under `minDeliveryWindow` away — including a deadline already in the past |
| `ZeroNotional()` | The order puts nothing at risk, so the registry's early-exit gate could not see it |

---

## B.13 `Mocks.sol` — test doubles

Not deployed. Listed for completeness.

| Contract | What it stands in for |
|---|---|
| `MockERC20` | A token. `mint`, `approve`, `transfer`, `transferFrom`, `balanceOf`, plus `setDecimals` — **settable precision**, because the real bond token has 6 decimals and `halfWeight` and `challengeBondAmount` break *silently* under a mismatch |
| `MockEzklVerifier` | A proof verifier. `setResult` and `setShouldRevert`, so the try/catch path can be tested |
| `ScoreMathHarness` | Exposes the four scoring functions publicly for direct testing |
| `IRouterLike` | A minimal router shape for consumer stubs |

---

## B.14 The permission map

Every access rule in one place. This table *is* the security model.

| Action | Who exactly |
|---|---|
| Register an agent | **Anyone**, with a bond |
| Top up a bond | **Anyone** |
| Rotate the operator, toggle active, unbond, withdraw | **The agent owner** |
| Deliver, resolve a challenge | **The registered operator only** |
| Order a job | **Anyone** — that party becomes the consumer |
| Settle | **That job's consumer only** |
| Challenge | **Anyone**, with a deposit |
| Mark expired, finalize, settle-by-default, slash an unresolved challenge | **Anyone** — these are the keep-honest actions, and each either pays a bounty or unblocks a stuck party |
| Reserve, release, slash | **The router only** |
| Write reputation | **The registry and the router only** |
| Enrol or revoke an enclave key | **A notary** |
| Everything named `set…` | **The protocol owner** |

Read it in the other direction and the important property appears: **no party can write its own
credential.** An agent cannot order its own work, cannot settle, cannot write to the engine, cannot
raise its own credit line. The only thing it controls is whether it delivers — and whether it can
prove it did.

---

## Where to go next

- [`docs/relayer.md`](relayer.md) — the same treatment for the off-chain half: the agent, the
  watchtower, the consumer client and the SDK
- [`docs/architecture.md`](architecture.md) — the shorter technical map
- `/docs#lifecycle` on the site — the same lifecycle, narrated live against real chain state
- `/docs#request` — how to actually place an order, with the real function signature
- `contracts/src/` — the source. Every file carries its reasoning in the comments; this document
  is a translation of them, not a substitute
