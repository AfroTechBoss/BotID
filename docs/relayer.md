# The relayer and the SDK, explained

A companion to [`contract.md`](contract.md). That document covers the contracts — the rules, the
part that lives on the chain and cannot be argued with. This one covers everything that runs
**off** the chain: the program an agent operator actually leaves running, the keeper that presses
the buttons nobody else is paid to press, the consumer side that orders work, and the library other
people install to talk to all of it.

Written for someone who has never written a line of Solidity or JavaScript. Every mechanism gets an
analogy, and the second half names and explains every function, class, constant and setting in the
package — nothing summarised, nothing skipped.

---

## 0. The one-paragraph version

The contracts are the courthouse: they hold the money, keep the record, and settle disputes. But a
courthouse does not go out and do the work. The relayer is **the staff** — three small programs,
one per role. The *agent* watches for jobs addressed to it, fetches the data, runs the model,
produces evidence and delivers before the deadline. The *watchtower* walks the corridors pressing
the buttons that make deadlines real, because a contract cannot notice that time has passed on its
own. The *consumer* commissions work and reports back what it was actually worth. All three are the
same small Node program with different keys, and all three are also importable as a library — the
SDK — so somebody else's service can be an agent without running a separate process.

---

## 1. The cast, off chain

Six things hold keys or run loops. Understanding who is who removes most of the confusion.

| Who | Key it holds | What it does | Where |
|---|---|---|---|
| **Agent operator** | `OPERATOR_KEY` | Delivers work, defends challenges | `agent.js` |
| **Enclave** | `ENCLAVE_KEY` | Signs from inside secure hardware, Silver only | `attest.js` |
| **Watchtower** | `WATCHTOWER_KEY` | Presses the enforcement buttons | `watchtower.js` |
| **Consumer** | `CONSUMER_KEY` | Orders work, reports the outcome | `consumer.js` |
| **Challenger** | `CHALLENGER_KEY` | Posts a bond to force a proof | `consumer.js` |
| **Publisher** | `PUBLISHER_KEY` | Signs the data readings | `publisher.js` |

Two of these are **not really the protocol's** and it matters. In production the publisher is an
independent oracle network — the `Publisher` class in this repo is a stand-in so the demo can run on
a laptop, and the file says so. And the challenger is anybody at all: a rival agent, a researcher, a
bot watching for money on the floor.

**Analogy:** the contracts are the courthouse; the operator is the contractor doing the job; the
publisher is the independent surveyor whose measurements everyone accepts; the watchtower is the
clerk who stamps things when the deadline passes; the challenger is anyone in the public gallery
allowed to shout "prove it" — at a cost, refunded if they were right.

---

## 2. The building

```
                            index.js  (the command line)
                            sdk.js    (the library)
                                 │
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
            agent.js       watchtower.js     consumer.js
                 │               │               │
     ┌───────────┼────────────┐  │               │
     ▼           ▼            ▼  │               ▼
publisher.js  inference.js  attest.js       publisher.js
     │           │            │  │               │
     └───────────┴─────┬──────┴──┴───────────────┘
                       ▼
                   digest.js          the hashing rules, mirrored from Solidity
                       │
                       ▼
                    chain.js          the connection, the ABIs, the startup check
                       │
                       ▼
                   config.js          every setting, read once
                       │
                       ▼
                    util.js           logging, retry, de-duplication
```

Read it top to bottom and you get the shape: **two entrances** (a command line and a library) into
**three roles**, all of which lean on the same handful of shared pieces. Nothing in the bottom half
knows which role is using it.

---

## 3. Module by module

### 3.1 `config.js` — every setting, decided once

This file collects the settings from three places, in a strict order of who wins:

1. **Real environment variables** — highest authority.
2. **The `.env` file** in the relayer directory — only fills in what the environment left blank.
3. **Built-in defaults** — the fallback.

`loadEnv` is fifteen lines of hand-written parsing, and the comment explains why: pulling in a
third-party library to parse fifteen lines of text means adding somebody else's code to a process
that **holds a private key.** Every dependency is a door. On a key-holding process, you count the
doors.

**Analogy:** you would happily borrow a stranger's ladder to reach a shelf. You would think twice
about borrowing one to work on the roof of a bank vault.

The other genuinely interesting decision here is `apply`. This module is a **singleton** — one copy,
shared by everything in the process. That is exactly right for a command line (one process, one key,
read once at startup) and awkward for a library, where somebody might construct two agents. Rather
than let a second caller silently reconfigure a running agent, a *conflicting* `apply` throws an
error. Re-applying identical settings is fine.

The rule it enforces: **one agent per process.** Each agent holds a different key, and a
key-holding process should be the smallest thing you can restart. Not a limitation so much as the
deployment shape written down where it can be enforced.

`SETTABLE` is a list of the option names `apply` will accept. Pass anything else — a typo, an
option from an older version — and it throws. Without that list, `new BotIDAgent({ rpcURL: … })`
with the wrong capitalisation would start an agent pointed at the *default* RPC and never say a
word. **A setting that silently does nothing is worse than one that errors**, because you find the
first one in production.

`loadManifest` reads contract addresses from the deploy manifest rather than from hand-copied
environment variables — but short-circuits entirely if a library caller passed addresses in. That
short-circuit is what makes the package installable: an `npm install` has no `deployments/`
directory to read.

### 3.2 `util.js` — the small shared tools

Three things, all small, all load-bearing.

**`log`** — timestamped output with a one-character severity marker. Nothing clever. Deliberately
not a logging library, for the same door-counting reason as above.

**`retry`** — retry with backoff, but **only for transient failures.** This is the interesting one.
It classifies a failure as permanent if the chain reverted or the account is out of funds, and
throws immediately in that case rather than trying again.

Why that matters: a revert means the chain has *decided*. Retrying burns gas on a guaranteed
failure — and worse, for a delivery, it burns the deadline that a fallback might still have made. A
network blip is worth another go; a rejection is not.

**Analogy:** if the post office is closed, come back later. If your parcel was refused because the
address does not exist, coming back later with the same parcel achieves nothing but wears out your
shoes.

**`Backlog`** — de-duplicates work by key. The same event reaches the agent up to three ways: the
live subscription, the catch-up sweep at startup, and again if the chain reorganises. Delivering
twice wastes gas on a guaranteed revert, since the first delivery already moved the job out of
`Pending`. `Backlog.once` makes sure a given job is only worked once.

### 3.3 `digest.js` — the mirror, and the most dangerous file here

This file re-implements, in JavaScript, the exact hashing rules the Solidity contracts use. Every
function in it is a mirror of a function in `contracts/src`:

| Here | Mirrors |
|---|---|
| `executionDigest` | `Digest.execution` |
| `feedDigest` | `InputAttestor.feedDigest` |
| `bundleCommitment` | `InputAttestor.commit` |
| `toField` | `ZkAdapter._toField` **and** `circuits/common.py`'s `to_field` |
| `valueHash` | `ZkAdapter._commit`'s inner hash |
| `commitOutputs` *(in `inference.js`)* | `ZkAdapter.outputCommitmentFor` |

Why is that dangerous? Because **the failure mode of a mirror is silence.** If the two copies drift
apart, nothing crashes. The relayer produces a signature that is perfectly well-formed and simply
does not verify — or, worse, verifies against something other than what the operator meant. No
error, no log line, no single party at fault. Just every honest delivery being rejected.

**Analogy:** two clocks in a building. If one stops, you notice. If one runs four minutes slow,
everyone keeps their appointments and misses them all.

The codebase handles this three ways. First, `toField` in particular has **three** copies —
Solidity, JavaScript and Python — and the comment names all three, because the person editing one
needs to know the others exist. Second, `chain.js` checks the feed typehash against the deployed
contract at startup (below). Third, the export tooling can be run in `--check` mode so a contract
change that was not re-exported fails the check instead of working on one machine and not another.

The one constant that *cannot* be checked at startup is `EXECUTION_TYPEHASH`, because `Digest` is a
Solidity library and libraries have no on-chain getter. The file marks it with `void
EXECUTION_TYPEHASH;` — a line that does nothing except say "yes, this was considered."

Two other things worth understanding here:

**`signDigest` adds no prefix.** Most wallet signing wraps your message in a standard preamble
before hashing, so that a message shown in a wallet cannot be a transaction in disguise. These
contracts `ecrecover` the raw digest, so the relayer signs the raw digest. The comment says so
explicitly, because signing raw bytes is normally a red flag and a reader deserves to know it was
deliberate.

**`MAX_ABS` appears here as well as in the adapter.** Negative numbers do not exist in the proof
system's number space — it wraps around, so `−42` is represented as `P − 42`. Without a bound, a
prover could reveal the *literal* enormous integer `P − 42` and produce the same cell as `−42`.
Bounding the magnitude before the conversion closes that. **Analogy:** a clock face. On a 12-hour
clock, "3 hours back" and "9 hours forward" land on the same number. If you allow both readings,
someone will pick whichever one suits them.

### 3.4 `chain.js` — the connection

Three jobs.

**Find the ABIs.** An ABI is the description of a contract's functions — the phrasebook you need to
speak to it. There are two possible sources: a bundle shipped inside the package (`src/abi.json`),
and the local build artifacts if you are working in the repo. The file prefers the **bundle**, in
both cases, and the comment defends the choice at length. Preferring the local artifacts would be
the obvious call — they are newer — but then an installed SDK and a checkout would resolve
different bytes, and a contract change that had not been exported would work on the developer's
machine and nowhere else. **One printed timetable everybody reads, rather than each platform
keeping its own.**

**Build the contract objects.** `registry`, `router`, `engine`, `attestor`, `token`, and the three
adapters. Note `zkAdapter` is allowed to be `null` — a deployment without a Gold adapter is a valid
deployment, just one where nothing can be escalated.

Note also that `token` is built from a hand-written six-function ERC-20 description rather than
borrowed from the mock token's artifact. The comment is blunt about why: the mock is a test fixture
and shipping it invites building against a contract that will never be deployed. Reaching for its
artifact worked only because a checkout happens to have one lying around.

**Check the mirror.** Before returning, it reads `FEED_TYPEHASH` off the deployed `InputAttestor`
and compares it to the relayer's copy. A mismatch throws at startup. This is the one line standing
between "the mirror has drifted" and "every signature this process produces is silently worthless."

It also verifies the manifest's chain id against what the RPC endpoint reports — pointing a
testnet manifest at a mainnet node, or vice versa, fails immediately rather than producing
transactions aimed at addresses that mean something else entirely.

### 3.5 `publisher.js` — the input side

Contains the **single most important function in the relayer**, and the file says so.

**`buildBundle`** assembles readings into a signed bundle. Two details carry weight. The publishers
are **sorted by address** before signing, because the contract uses strictly ascending signer order
as its duplicate check — an unsorted bundle is rejected outright rather than merely counted short.
And each reading's hash is *derived* from the value and salt rather than supplied, so the bundle
can always be opened later. A reading that carries only a hash can be delivered at Bronze but can
never be escalated to Gold.

**`newSalt`** is 32 random bytes. The salt is what keeps a reading private between the order and
the reveal. An input commitment is public from the moment the job is placed; without a salt, anyone
could guess small values and check them against the hash until the price fell out — and the agent
could read its own inputs straight out of the commitment it is supposed to be blind to.

**`fetchBundle`** downloads whatever the job's URI points at. Handles three shapes: a local file, an
HTTP address, or a bare name resolved inside the local bundle directory. Note `redirect: "error"` on
the HTTP path — it refuses to follow redirects, so a URI cannot quietly become a different URI.

The URI is **completely untrusted**. It is a locator, not an authority.

**`verify`** is the line that makes the previous paragraph safe. It recomputes the commitment from
the bytes that arrived and compares it to what the consumer committed to on chain. Whatever served
the URI — the consumer, a CDN, an attacker who won a DNS race — the agent only ever runs on data
that hashes to the committed value. A hostile URI can waste the agent's time; it cannot change what
the agent is judged on.

**Analogy:** a courier hands you a sealed envelope and a tracking number. You do not trust the
courier. You check that the seal matches the number you were given in advance. It does not matter
who carried it.

**`open`** does the second half. `verify` establishes the bundle is the committed one; `open`
establishes that the *numbers* served alongside it are the numbers behind its hashes. Matched by
position, confirmed hash by hash. A URI that pairs a correct bundle with doctored values is caught
here.

It returns `null` when no readings were served at all — a legitimate state, since a Bronze agent
can deliver on hashes it cannot open. The caller decides whether its tier can live with that.

### 3.6 `inference.js` — running the model

Two runners and a rule.

**The rule**, stated at the top of the file: a runner must be **deterministic**, and its outputs
must be the circuit's actual output cells, not a rounded human-readable version. A weight of 100%
is the cell `10000 << inputScaleBits`, not `10000`. Get that wrong and the agent commits on chain
to a number it cannot later prove.

**`EzklRunner`** — the default. It shells out to `circuits/run.py`, the *same entrypoint the prover
uses.* This is the important architectural choice in the file. Running the real circuit at every
tier, including Bronze, means the tiers agree **by construction** rather than by review.

Consider the alternative. An agent computes its answer with a hand-written reimplementation, differs
from the circuit in the last digit, and delivers. Nothing goes wrong. The commitment sits on chain
for an hour looking fine. Then somebody challenges, the real circuit runs, produces a different
number — and the agent loses a challenge it was **honest** about. The subprocess cost, a Python
start-up per job, buys immunity from that. The comment is clear that if the cost ever becomes
unacceptable the fix is a long-lived worker speaking the same protocol, **not** a second
implementation.

Its constructor also checks that the circuit sitting in the directory is the one the agent is
registered for — a model commitment is the hash of the model's name, so this is a string comparison
that turns a silent mismatch into a startup error. Reputation does not transfer between models, so
running the wrong one is not a small mistake.

**`ReferenceAllocator`** — a pure-JavaScript port of the same maths, for environments without a
Python toolchain. It computes: equal weight among every feed above the average, in basis points.

Two things about it. The comparison is written as `n × value − total > 0` rather than dividing to
get an average, so it matches the graph the circuit compiles, sign for sign — division rounds, and
a rounding difference at exactly the average is a different answer. And the file is candid that
this class is **a liability the moment the model changes without it**, which is precisely why the
circuit runner is the default and this has to be asked for by name.

**`loadRunner`** picks between them, and **refuses to fall back automatically.** If the circuit is
not built, it throws. Silently dropping to the JavaScript port would let a host with a broken Python
setup deliver commitments it cannot prove — the exact drift the Gold tier exists to make impossible.

### 3.7 `attest.js` — producing the evidence

One function per tier, plus a dispatcher.

**`bronze`** — sign the execution digest with the operator key. That is the whole thing. It proves
only that the keyholder is willing to be slashed for the claim, which is the point: it costs
nothing to produce and is made honest by the challenge window, not by cryptography.

**`silver`** — sign with the enclave key, over a digest that has **the measurement hashed into it.**
Binding the measurement means an enrolment cannot be reused across builds. The comment carries the
honest limitation forward from the contract: enrolment is notarised off chain rather than parsed on
chain, so the trust root is the notary set, not the chip vendor.

**`gold`** — shell out to the prover and package the result. Three parts go into the attestation:
the proof bytes, the public instance values, and the reveals. The reveals are what make the input
half checkable at all — a bundle commits to hashes, so the adapter needs the preimages to re-derive
both the commitment and the input cells.

Two guards. `allowDevProof` produces correct instances with an **empty proof**, and logs a warning
every single time it does. It only means anything against the mock verifier; a real verifier rejects
it, which is the correct outcome for a relayer that has been told not to actually prove anything.
And a Gold tier with no prover configured **fails loudly** rather than degrading — the comment says
faking this would be the single most misleading thing the file could do.

**`parseProof`** accepts either a JSON object or bare hex, and reads only the **last line** of the
output, so a prover that logs its progress still works. Small accommodation, but it is the
difference between "any command that prints a proof" and "only our script."

### 3.8 `agent.js` — the loop that matters

The agent-side program. Its job is narrow: watch for work addressed to one agent id, do it
honestly, get evidence on chain before the deadline.

**Startup** does more than connect. It resolves the agent id from the operator key if one was not
given, then checks the key really is that agent's operator — catching a mis-set key at startup
rather than at the first delivery. Then it reads `inputScaleBits` **off the chain**, from the
registration the adapter will actually check against. Reading it from a local config instead would
be the difference between a scale change being a deployment step and a scale change being a silent
outage: every honest proof rejected, with nothing in the logs to say why.

**The delivery path**, five steps:

1. **Fetch** the bundle the URI points at, then `verify` it against the commitment. Everything after
   this line is honest by construction.
2. **Open** the readings against the committed hashes.
3. **Run** the model.
4. **Attest** at the agent's registered tier.
5. **Deliver**, with aggressive retries — reverting costs gas, but missing the deadline costs a
   slash *and* a permanent fault.

**The defence path** is the one with the most character. When challenged, the agent re-derives the
answer from scratch — and if the re-run does **not** reproduce what it delivered, it declines to
contest and logs that the slash is deserved. That is a program built to lose gracefully when it is
wrong. The alternative, trying to prove something false, cannot succeed and wastes the proving cost
to get to the same place.

**Catching up.** Live subscriptions only see events from now on, so a process that was down misses
whatever was ordered meanwhile. On startup it sweeps the recent past — 5,000 blocks by default —
and feeds those into the same handler. `Backlog` makes the overlap harmless.

**Stopping** is more careful than it looks, and the comment explains why. Destroying the connection
cancels whatever poll is in flight, and a cancelled poll reports as an error even though it is
exactly what shutting down means — *hanging up mid-sentence and then complaining the line went
dead.* So: drop the subscriptions first, yield once so the poller can retire them, and treat a
cancellation during teardown as the expected outcome it is.

And `stop()` deliberately **leaves accepted work to finish.** Abandoning a delivery mid-flight is
the one thing that costs the agent a liveness fault.

`start` returns a handle rather than blocking. The command line turns that back into "run until
killed"; a library caller has its own process to run. As the comment puts it: an agent embedded in
a larger service is **a tenant, not the landlord.**

### 3.9 `watchtower.js` — the keeper

The shortest role and, in a sense, the most necessary.

Several of the protocol's guarantees are only real if somebody actually calls the function that
enforces them. **Nothing in the router self-executes.** A contract cannot notice that a deadline
passed; it can only be *told*, by someone paying gas to tell it.

Four buttons:

| Function | Why it needs pressing |
|---|---|
| `markExpired` | An agent that took work and vanished is not faulted until called. **Pays a bounty, so this one funds itself** |
| `slashUnresolvedChallenge` | An unanswered challenge does nothing on its own. Anyone may call it — but the bounty goes to the challenger, not the caller |
| `finalize` | Moves a delivery out of its challenge window so it can settle |
| `settleDefault` | Stops a silent consumer holding an agent's exposure hostage |

Note the asymmetry: only one of the four pays the caller. The other three are run because whoever
runs a watchtower wants the protocol to work — an agent operator has every reason to keep one
running, since two of those four unblock *its own* capital.

It is **permissionless and stateless** — it re-derives everything from the chain each pass — so
running several is harmless beyond the gas the losers waste. And losing a race reverts, which the
code logs as a warning rather than an error, with the comment: *that is a success, not an error.*
Someone else did the job.

**Analogy:** parking wardens. The rule that the meter expires exists whether or not anyone walks
past. The warden is what makes it a fact rather than a sentence in a bylaw.

### 3.10 `consumer.js` — the demand side

The party a real integration — a vault, a strategy manager — would be. It exists to exercise the two
things a consumer is uniquely responsible for, both load-bearing for the protocol's honesty:

1. **It picks the inputs.** The agent must never be able to choose the data it is graded on.
2. **It reports the outcome.** Reputation is built from settled economic results, so `settle` is
   where the signal actually enters the system.

`request` assembles the readings, salts them, builds and signs the bundle, writes it somewhere the
agent can fetch it, approves the token if needed, and places the order. Note that a consumer naming
no fee pays exactly the on-chain minimum — read from the router, not hardcoded — rather than
reverting on a stale default.

`settle` reports the result. The comment names the asymmetry the scoring enforces: **profit is not
rewarded, breaches are punished.** A consumer cannot inflate an agent by reporting spectacular
returns.

`challenge` posts a bond to force a proof. `watch` polls a job to a terminal state — a convenience
for driving the demo.

### 3.11 `sdk.js` — the library

The programmatic API, and deliberately **thin**. The comment states the design rule: the command
line and the SDK run the same code down to the same line numbers, so a bug found by one is fixed for
both. *A second implementation dressed as a convenience layer is how two things that are supposed to
agree start disagreeing quietly.*

Two classes.

**`BotIDAgent`** wraps the agent loop. `start()` resolves once it is watching, `stop()` detaches,
`wait()` resolves only when it stops — which makes `await agent.wait()` a service's main loop.

**`BotIDReader`** is the other half, for the side doing the hiring. **No key, no transactions,
nothing to fund** — a consumer asking the chain a question about somebody else.

Its `check` method is the one that matters. It calls `meetsPolicy` on the registry, which is the
same function a vault would call in Solidity — so a bot that screens with it and a contract that
enforces it **cannot disagree about who was eligible.** Not a convenience wrapper around a rule; the
rule itself, asked from a different room.

Its policy defaults are chosen carefully, and the comment explains the one exception. Unset fields
are the *permissive* value rather than zero-as-accident: an omitted minimum tier is any tier, an
omitted staleness limit is no staleness check. But `maxFaults` defaults to **zero**, because the
permissive default would be infinity and someone who did not think about faults almost certainly
does not want an agent that has committed one.

`agent()` returns `null` for an id that was never issued, and the comment explains the mechanic
underneath: an unissued id does not fail — the chain hands back a zero-filled record, because a
lookup table has no opinion about which of its keys are real. Registration always sets an owner, so
a zero owner is what separates *absent* from *empty*.

### 3.12 `index.js` — the command line

The thinnest file in the package. Parses arguments, prints usage, dispatches to one of the four
roles, and turns any thrown error into a single clean line — with the full stack behind a `DEBUG`
flag, so normal operation is readable and debugging is still possible.

The modules are loaded **inside** the switch, not at the top. Running the watchtower therefore never
loads the consumer's code, and a broken module only breaks the role that needs it.

The fourth role is `arena` — the first-party consumer in `src/arena/`, which orders work from every
registered agent on a schedule and settles it against what the allocation actually returned. It is
the one role with a document of its own: [docs/arena.md](docs/arena.md).

---

## 4. The full delivery, end to end

What actually happens between "a vault wants a decision" and "the agent's score moves."

```
CONSUMER                         CHAIN                          AGENT
────────                         ─────                          ─────
gather readings
salt each value
sign with publisher key
compute commitment
write bundle to a URI
                        ──▶  requestExecution()
                             • pulls the fee
                             • reserves credit
                             • emits the event ─────────────▶  event received
                                                                fetch the URI
                                                                verify the commitment  ← the line
                                                                open the readings
                                                                run the circuit
                                                                build the attestation
                        ◀───────────────────────────────────  deliver()
                             • checks the inputs
                             • checks the evidence
                             • starts the clocks

                             ⟨ challenge window ⟩
                                                       WATCHTOWER ──▶ finalize()

report the outcome  ──▶  settle()
                             • releases the exposure
                             • records the outcome  ──▶  the score moves
                             • splits the fee
```

Two observations that the diagram makes obvious and prose tends to hide.

**The agent never chooses its inputs.** Everything on the right-hand side begins with data the
left-hand side committed to first. That is not a courtesy; it is the reason a score means anything.

**The watchtower is in the middle of the flow, not off to one side.** Without it, deliveries sit
un-finalised and nothing settles. The protocol has a heartbeat, and something has to provide it.

---

## 5. The three attestations side by side

| | Bronze | Silver | Gold |
|---|---|---|---|
| **What is produced** | One signature | Enclave key + signature | Proof + instances + reveals |
| **Signed by** | The operator key | The enclave key | Nobody — it is a proof |
| **Cost to produce** | Nothing | Nothing | Minutes of compute |
| **Extra requirement** | — | `ENCLAVE_KEY`, `MEASUREMENT` | Opened readings, a built circuit |
| **What it proves** | Someone accepted the slashing risk | Approved code ran, per the notaries | The computation itself |
| **Trust root** | The bond | The notaries plus the chip vendor | Mathematics |

The tiers are not three qualities of the same claim. They are three **different** claims, and the
protocol's design is that the cheap one is redeemable into the expensive one on demand. Bronze is
honest not because a signature is convincing but because anyone can force it to become Gold.

---

## 6. Why the pieces are split this way

Four separations, each doing real work.

**Roles are separate processes because keys are separate.** The agent holds an operator key that can
deliver work; the watchtower holds one that only pays gas; the consumer holds one that moves the
consumer's money. Merging them means a bug in one has the other's authority. Splitting them means a
compromised watchtower can waste gas and nothing else.

**Hashing is one file because a mirror must be edited in one place.** Every commitment convention
lives in `digest.js`. Scattering them across the files that use them would mean the next person to
change one convention changes it in three of the five places it appears — and, per §3.3, nothing
would crash.

**The model is a subprocess because two implementations diverge.** Covered in §3.6. The one-line
version: the tiers must agree, and the cheapest way to guarantee agreement is to run the same thing.

**The SDK is thin because a convenience layer becomes a second implementation.** Covered in §3.11.

---
---

# Part A — the vocabulary

The relayer is JavaScript running on Node, talking to a chain through a library called `ethers`.
This part is the dictionary for all three of those.

## A.1 The JavaScript

| What | What it means |
|---|---|
| `const` / `let` | Name a value. `const` cannot be re-pointed afterwards; `let` can. Nearly everything here is `const` |
| `function name(a, b)` | Declare a callable. `a` and `b` are the inputs |
| `(a) => a + 1` | The same thing written shorter — an "arrow function." Used for one-liners and callbacks |
| `class` | A blueprint for objects that carry data *and* the functions that work on it. `Publisher`, `Backlog`, `BotIDAgent` |
| `new Publisher(...)` | Build one from the blueprint. Runs its `constructor` |
| `this` | Inside a class, the particular object being worked on |
| `constructor` | The setup function that runs once when an object is built |
| `static` | A function on the blueprint itself rather than on any one object. `EzklRunner.available()` asks about the environment, not about a particular runner |
| `get address()` | A "getter" — looks like reading a value, actually runs a function |
| `module.exports = {...}` | What this file makes available to others |
| `require("./util")` | Pull in another file. `./` means "next to me"; a bare name means an installed package |
| `throw new Error("…")` | Abort with a message. Travels up until something catches it |
| `try / catch / finally` | Attempt something; handle the failure; run cleanup either way |
| `?.` | "Optional" access — `provider.destroy?.()` calls `destroy` only if it exists, instead of failing |
| `??` | "If that was absent, use this instead." `process.env.RPC_URL ?? "http://…"` |
| `...` | Spread — `[...a, ...b]` builds one list from two. Also `{...feed, signatures}` copies an object and adds a field |
| `Map` / `Set` | A lookup table, and a collection of unique values |
| `.map()` / `.filter()` / `.reduce()` | Transform every item / keep some / fold a list into one value |
| `` `text ${value}` `` | A string with values slotted in |

### `async` and `await`, the two that matter most

Almost every function in this codebase is `async`. It is worth understanding properly, because the
entire relayer is built on it.

Talking to a chain takes time — hundreds of milliseconds, sometimes seconds. A program that simply
**stopped** for each one would be useless: the agent could not listen for a second job while working
on the first.

So a slow operation returns a **Promise** immediately: a receipt saying "an answer will exist
later." `await` means *pause this particular piece of work until the receipt is redeemed, and let
everything else carry on meanwhile.* An `async` function is one that is allowed to contain `await`.

**Analogy:** a restaurant kitchen. A cook who put a steak on and then stood watching it would serve
one table a night. `await` is the cook putting the steak on, starting the sauce, and coming back
when it is ready. Same cook, same one pair of hands — just never idle while waiting.

`Promise.all([a, b])` runs several at once and waits for all of them. `sdk.js` uses it to fetch an
agent's record and profile in one round trip instead of two.

And `new Promise(() => {})` — the value of `stopped` — is a promise that is **never** redeemed. A
receipt for something that will never be ready. Awaiting it means "wait forever," which is exactly
what "run until killed" means.

### `BigInt` — and why every amount has an `n` after it

You will see `10_000n`, `BigInt(value)`, `0n`. The `n` marks a **BigInt**: a whole number with no
size limit.

Ordinary JavaScript numbers lose precision above about 9 quadrillion. Token amounts routinely
exceed that — a single token is typically 10^18 of its smallest unit, so a thousand tokens is
already a 21-digit number. Using ordinary numbers would silently round somebody's balance.

**Analogy:** a pocket calculator that displays eight digits. Perfectly good for a shopping list;
catastrophic for a bank ledger, and *quietly* catastrophic, because it still shows you an answer.

The cost is that BigInts do not mix with ordinary numbers — hence `BigInt(x)` conversions
throughout, and `Number(r.status)` when converting the other way for something genuinely small.

## A.2 The Node parts

| What | What it means |
|---|---|
| `process.env.NAME` | An environment variable — configuration passed in from outside the program |
| `process.argv` | The words typed after the command |
| `process.exitCode` | What the program reports on the way out. 0 is success |
| `fs` | The filesystem. `readFileSync`, `writeFileSync`, `existsSync` |
| `path.join(a, b)` | Build a file path that is correct on Windows and Linux both |
| `__dirname` | The folder this file is in |
| `execFile` | **Run another program** and collect its output. How the relayer calls Python |
| `promisify` | Convert an old-style callback function into one you can `await` |
| `JSON.parse` / `JSON.stringify` | Text → data, and data → text |
| `setTimeout` | Do something later. `sleep` is a one-line wrapper around it |
| `fetch` | Make an HTTP request |
| `#!/usr/bin/env node` | The first line of `index.js` — makes the file directly runnable as a command |

`maxBuffer: 1 << 28` on the prover call deserves a note: it is the most output the relayer will
accept from the subprocess, written as a bit-shift. `1 << 28` is 268 megabytes — generous, because
a proof is large, and bounded, because an unbounded buffer is how a runaway subprocess takes the
agent down with it.

## A.3 The `ethers` parts

`ethers` is the library for talking to an Ethereum-style chain.

| What | What it does |
|---|---|
| `JsonRpcProvider` | The **connection.** Can read anything; can send nothing. No key involved |
| `Wallet` | A **key.** Can sign and send. A wallet plus a provider can transact |
| `SigningKey` | The raw signing primitive, below `Wallet`. Used where a bare digest is signed |
| `Contract` | A **live handle** to a deployed contract, built from an address, an ABI and a provider or wallet |
| `AbiCoder` | Packs values into the exact byte layout the chain uses. The foundation of every commitment here |
| `keccak256` | The hash function |
| `id(text)` | Shorthand for the hash of a piece of text. How a feed id and a model commitment are derived from names |
| `parseEther` / `formatEther` | Human amount ⇄ raw units. `1.5` ⇄ `1500000000000000000n` |
| `ZeroAddress` | The "nobody" address. What an unwritten record reads as |
| `MaxUint256` | The largest possible number. Used as "unlimited" when approving |
| `randomBytes` / `hexlify` | Cryptographic randomness, and its hex form. How salts are made |

Three `Contract` patterns appear throughout:

**Reading** — `await contracts.router.getRequest(id)`. Free, instant, no key.

**Writing** — `await contracts.router.deliver(...)` returns once the transaction is *sent*, not once
it is accepted. `await tx.wait(confirmations)` is the second half, and skipping it means acting on
something that has not happened yet.

**Listening** — `contracts.router.on(filter, handler)` subscribes to future events;
`queryFilter(filter, from, to)` searches past ones. The agent uses both, for the reason in §3.8.

A **filter** narrows the subscription to events matching certain fields — which only works because
those fields were marked `indexed` in the contract. `filters.ExecutionRequested(null, agentId)`
means *any request id, for this agent.* Without it the agent would receive every job on the network
and discard almost all of them.

## A.4 Reading the code's own conventions

| Pattern | What it signals |
|---|---|
| `_connect()` | Leading underscore — internal, not part of the public API |
| `Status.Pending` | A named constant standing in for a number, mirroring the contract's enum |
| `/* Pending */` after a `1` | An inline reminder of what a bare number means |
| `void EXECUTION_TYPEHASH;` | "This was considered and cannot be checked here" |
| `{ attempts: 5, label: "…" }` | Named options rather than positional arguments, so a call site is readable |
| `e.shortMessage ?? e.message` | `ethers` errors carry a readable summary; fall back to the raw one |

---
---

# Part B — every named thing, module by module

---

## B.1 `config.js`

### Functions

| Name | What it does |
|---|---|
| `loadEnv(file)` | Parses the `.env` file into the environment. Skips blanks and `#` comments, strips surrounding quotes, and **never overwrites a real environment variable** |
| `required(name)` | Fetch a setting or throw. How a missing key becomes a clear message instead of a confusing failure later |
| `loadManifest()` | Reads the deploy manifest for addresses — or returns the caller's addresses directly if they were supplied |
| `apply(options)` | Overlay explicit settings. Rejects unknown keys; throws on a *conflicting* second call |

### Settings

| Name | Environment variable | Default | What it is |
|---|---|---|---|
| `rpcUrl` | `RPC_URL` | `http://127.0.0.1:8545` | Which node to talk to |
| `manifest` | `MANIFEST` | the localhost manifest | Where addresses come from |
| `contracts` | — | `null` | Addresses passed by a library caller. **Non-null means never touch the filesystem** |
| `chainId` | — | `null` | Set alongside `contracts` |
| `seeded` | — | `null` | Demo keys from a local deploy |
| `artifactsDir` | `ARTIFACTS_DIR` | the contracts build tree | Fallback ABI source |
| `agentId` | `AGENT_ID` | `null` | Which agent. Checked against the operator key at startup |
| `operatorKey` | `OPERATOR_KEY` | `null` | **The agent's signing key** |
| `enclaveKey` | `ENCLAVE_KEY` | `null` | Silver only |
| `measurement` | `MEASUREMENT` | `null` | Silver only — the code fingerprint |
| `circuitsDir` | `CIRCUITS_DIR` | `../circuits` | Where the model lives |
| `modelRunner` | `MODEL_RUNNER` | `ezkl` | `reference` opts into the JavaScript port |
| `runnerCmd` | `PYTHON` | `python` | The interpreter |
| `runnerArgs` | — | `["run.py"]` | The inference entrypoint |
| `proverCmd` | `EZKL_PROVER_CMD` | the same interpreter | The prover — replaceable with a queue or a bigger machine |
| `proverArgs` | — | `["prove.py"]` | Empty when a custom prover command is set |
| `allowDevProof` | `ALLOW_DEV_PROOF` | `false` | **Emits an empty proof.** Mock verifier only |
| `bundleDir` | `BUNDLE_DIR` | `.bundles` | Where demo bundles are written and read |
| `pollIntervalMs` | `POLL_INTERVAL_MS` | `5000` | Watchtower pass interval |
| `confirmations` | `CONFIRMATIONS` | `1` | Blocks to wait after a transaction |
| `startBlock` | `START_BLOCK` | `null` | Overrides the catch-up lookback |

### Other named things

| Name | What it is |
|---|---|
| `SETTABLE` | The set of option names `apply` accepts. A typo is an error, not a silent no-op |
| `applied` | A fingerprint of what was already applied, so a conflicting second call can be detected |

### Keys used elsewhere but read the same way

| Variable | Read by | Purpose |
|---|---|---|
| `CONSUMER_KEY` | `consumer.js` | Orders work and settles |
| `CHALLENGER_KEY` | `consumer.js` | Posts challenge bonds |
| `PUBLISHER_KEY` | `consumer.js` | Signs readings when no seeded key exists |
| `WATCHTOWER_KEY` | `watchtower.js` | Pays gas for enforcement |
| `REQUEST_ID` | `consumer.js` | Default job id for the sub-commands |
| `DEBUG` | `index.js` | Print full stack traces |

---

## B.2 `util.js`

| Name | Kind | What it does |
|---|---|---|
| `stamp()` | function | The timestamp prefix — `2026-08-14 09:15:03` |
| `log.info` / `log.warn` / `log.error` | functions | Output, marked plain / `!` / `x`. Errors go to the error stream so they can be routed separately |
| `sleep(ms)` | function | Wait, awaitably |
| `retry(fn, {attempts, baseMs, label})` | function | Retry with doubling backoff. **Throws immediately on a revert or insufficient funds** |
| `Backlog` | class | De-duplicates work by key |
| `Backlog.inflight` | `Map` | Key → the work currently running for it |
| `Backlog.done` | `Set` | Keys already completed |
| `Backlog.once(key, fn)` | method | Run `fn` unless this key is done or already running |

`retry`'s defaults are 3 attempts and 750 ms — doubling to 750, 1500, 3000. The agent's delivery
call overrides it to 5, because a missed delivery costs a fault.

---

## B.3 `digest.js`

### Constants

| Name | What it is |
|---|---|
| `coder` | The shared encoder. One instance, reused |
| `EXECUTION_TYPEHASH` | Hash of the execution field list. **Must match `Digest.sol` byte for byte** |
| `FEED_TYPEHASH` | Hash of the reading field list. **Checked against the chain at startup** |
| `BUNDLE_TYPE` | The byte layout of a signed bundle: a list of (feedId, valueHash, timestamp, signatures) |
| `REVEAL_TYPE` | The byte layout of `ZkAdapter.Reveal[]` |
| `BN254_P` | The proof system's field size. Same number as `ZkAdapter.P` and `common.py`'s `P` |
| `MAX_ABS` | 2^128. The magnitude bound, checked **before** scaling |

### Functions

| Name | Mirrors | What it does |
|---|---|---|
| `executionDigest(chainId, verifier, ctx)` | `Digest.execution` | The digest every attestation binds. Includes the adapter address, which is what stops a Bronze signature being replayed at the ZK adapter |
| `feedDigest(chainId, attestor, feed)` | `InputAttestor.feedDigest` | What a publisher signs for one reading |
| `bundleCommitment(chainId, attestor, feeds)` | `InputAttestor.commit` | The hash over the ordered leaf digests |
| `encodeBundle(feeds)` | — | Pack a bundle into bytes. **Signatures must already be in ascending signer order** |
| `decodeBundle(hex)` | — | Unpack it |
| `toField(v, bits)` | `ZkAdapter._toField` + `common.py` | Signed number → field element. Bounds first, then shifts, then wraps negatives |
| `valueHash(value, salt)` | `ZkAdapter._commit`'s inner hash | The salted hash of one reading |
| `zkInstances(reveals, outputs, bits)` | — | The public values: quantised inputs, then outputs, and nothing else |
| `encodeZkAttestation(proof, instances, reveals)` | — | Pack the Gold attestation |
| `signDigest(wallet, digest)` | — | Sign raw 32 bytes. **No prefix** — the contracts recover the digest itself |

---

## B.4 `chain.js`

| Name | Kind | What it does |
|---|---|---|
| `BUNDLED` | constant | The shipped ABIs, from `src/abi.json` |
| `ERC20_ABI` | constant | Six token functions, hand-written rather than borrowed from the mock |
| `abiOf(name)` | function | Bundle first, local artifacts second. Throws with both locations named |
| `connect({key})` | function | The one entry point. Returns `{manifest, provider, signer, chainId, contracts}` |

### What `connect` returns

| Field | What it is |
|---|---|
| `manifest` | The deployment record — addresses, chain id, any seeded demo keys |
| `provider` | The read connection |
| `signer` | The wallet, or `null` if no key was given — **a read-only role never constructs one** |
| `chainId` | Confirmed against the manifest |
| `contracts` | `registry`, `router`, `engine`, `attestor`, `token`, `sigAdapter`, `teeAdapter`, `zkAdapter` |

`zkAdapter` may be `null`. Everything downstream checks.

### The two startup checks

| Check | What it prevents |
|---|---|
| Manifest chain id vs. the RPC's | Transactions aimed at addresses that mean something else on another chain |
| `FEED_TYPEHASH` vs. the deployed attestor | Every signature being silently worthless |

---

## B.5 `publisher.js`

### `class Publisher`

| Member | What it is |
|---|---|
| `constructor(privateKey, chainId, attestorAddress)` | Binds a key to one chain and one attestor |
| `wallet`, `chainId`, `attestor` | Those three, held |
| `address` | Getter — the public address of the key |
| `sign(feed)` | Sign one reading's digest |

Stands in for a production oracle network. It is not one, and the file says so.

### Functions

| Name | What it does |
|---|---|
| `buildBundle(chainId, attestor, readings, publishers)` | Sorts the publishers by address, derives each reading's hash, collects signatures, returns `{feeds, bundle, commitment}` |
| `newSalt()` | 32 random bytes. Nothing is derived from it — that is the point |
| `fetchBundle(uri)` | `file://`, `http(s)://` (**no redirects**), or a bare name in the bundle directory |
| `verify(chainId, attestor, bundleHex, expected)` | **The line.** Recompute and compare, or throw |
| `open(feeds, readings)` | Confirm each served number against its committed hash. `null` when none were served |
| `writeBundle(name, payload)` | Save a bundle for the demo to pass around |

---

## B.6 `inference.js`

| Name | Kind | What it does |
|---|---|---|
| `commitOutputs(outputs)` | function | Hash the output cells. Mirrors `ZkAdapter.outputCommitmentFor` |
| `EzklRunner` | class | **The default.** Shells out to the real circuit |
| `EzklRunner.available()` | static | Is a compiled circuit present? Checked before construction |
| `EzklRunner.run(feeds, reveals)` | method | Runs `run.py`, parses the last line of output, returns `{outputs, weights, outputCommitment}` |
| `ReferenceAllocator` | class | The JavaScript port. Must be asked for by name |
| `ReferenceAllocator.bps` | field | `10_000n` — the basis-point scale |
| `ReferenceAllocator.run(feeds, reveals)` | method | Equal weight among above-average feeds, computed without division |
| `loadRunner(modelCommitment, scaleBits)` | function | Picks one. **Never falls back silently** |

`EzklRunner`'s constructor performs the model-identity check: a model commitment is the hash of the
model's name, so comparing the circuit directory's declared name against the registration turns a
silent mismatch into a startup error.

---

## B.7 `attest.js`

| Name | Kind | What it does |
|---|---|---|
| `Tier` | constant | `{None: 0, Bronze: 1, Silver: 2, Gold: 3}` — mirrors the contract enum |
| `bronze(chainId, adapter, ctx, operatorWallet)` | function | One signature over the execution digest |
| `silver(chainId, adapter, ctx, enclaveWallet, measurement)` | function | Signs a digest with the measurement hashed in; returns `(address, signature)` packed |
| `gold(ctx, {outputs, reveals, scaleBits})` | function | Runs the prover, packs proof + instances + reveals |
| `parseProof(stdout)` | function | Accepts JSON or bare hex; reads only the last line |
| `forTier(tier, {...})` | function | Dispatch. Throws a **named** error if Silver is missing its key or measurement |

`gold` throws early if there are no opened readings — a Gold proof cannot be built from hashes
alone, and finding that out before spending the compute is worth the extra check.

---

## B.8 `agent.js`

| Name | Kind | What it does |
|---|---|---|
| `start(options)` | function | Connect, validate, subscribe, backfill. **Returns a handle rather than blocking** |
| `run(options)` | function | `start`, then wait forever. The command line's entry point |
| `modelScaleBits(zkAdapter, modelCommitment, tier)` | function | Reads the registered scale **off the chain.** Fatal at Gold, a warning below it |
| `resolveURI(contracts, requestId, provider)` | function | Recovers a URI from the log that announced it — it is event data, not storage |

### Inside `start`

| Name | What it is |
|---|---|
| `key` | The operator key, from options or the environment |
| `agentId` | From config, or looked up from the operator address |
| `agent` | The on-chain record. Its operator is checked against the signing key |
| `adapters` | The three adapter addresses, from the manifest |
| `enclave` | A wallet built from the enclave key, or `null` |
| `scaleBits` | Read from the chain, per §3.8 |
| `runner` | The model runner |
| `backlog` | Per-job de-duplication |
| `handleRequest(ev)` | The five-step delivery path |
| `handleChallenge(ev)` | Re-derive, compare, prove — or decline |
| `head` / `from` | The catch-up range. 5,000 blocks back by default |

### What the handle carries

| Field | What it is |
|---|---|
| `agentId`, `operator`, `tier` | Identity, confirmed against the chain |
| `stop()` | Detach cleanly. Leaves accepted work to finish |
| `stopped` | A promise that never resolves — "run until killed" |

---

## B.9 `watchtower.js`

| Name | Kind | What it does |
|---|---|---|
| `Status` | constant | The eight job states, mirroring the contract |
| `run()` | function | The loop |
| `tracked` | `Map` | Job id → last seen state. Terminal jobs are dropped |
| `cursor` | variable | Next block to scan from |
| `act(label, call)` | inner function | Send, wait, log. **A revert is logged as a warning, not an error** — losing a race means someone else did the job |

### The four conditions

| State | Time check | Action |
|---|---|---|
| `Pending` | past `deliverBy` | `markExpired` |
| `Delivered` | at or past `finalizeAt` | `finalize` |
| `Challenged` | past `escalationDeadline` | `slashUnresolvedChallenge` |
| `Finalized` | past `settleBy` | `settleDefault` |

---

## B.10 `consumer.js`

| Name | What it does |
|---|---|
| `request(args)` | Assemble, salt, sign, publish, approve, order. Returns the job id |
| `settle(args)` | Report the outcome. Logs the resulting score |
| `challenge(args)` | Post a bond to force a proof |
| `watch(args)` | Poll a job to a terminal state |

### `request`'s arguments

| Argument | Default | What it is |
|---|---|---|
| `--agent` | `AGENT_ID` | Who to hire |
| `--notional` | 100,000 | Capital the decision governs — **and the weight of the score update** |
| `--fee` | the on-chain floor | Payment |
| `--window` | 900 seconds | How long the agent has |
| `--feeds` | `BOT/USD,ETH/USD,BTC/USD` | Feed names, hashed into ids |
| `--values` | `12500,34000,4200` | Whole numbers at the model's scale. The spread puts some above the mean and some below, which is the only thing the reference model reacts to |

### `settle`'s arguments

| Argument | What it is |
|---|---|
| `--request` | Which job |
| `--pnl` | Realised result in basis points. **Signed** — negative is a loss |
| `--sla` | Late or out of spec |
| `--limit` | Exceeded the declared risk limits |

---

## B.11 `sdk.js` — the public API

This is the entire published surface. Everything else is internal.

| Export | What it is |
|---|---|
| `BotIDAgent` | Run an agent |
| `BotIDReader` | Read reputation. No key |
| `Tier` | `{None: 0, Bronze: 1, Silver: 2, Gold: 3}` |
| `Status` | The eight job states |

### `class BotIDAgent`

| Member | What it does |
|---|---|
| `constructor(options)` | Stores settings. **Connects nothing yet** |
| `options`, `handle` | The settings, and the running agent once started |
| `start()` | Begin. Resolves once watching. Returns `{agentId, operator, tier}`. Throws if already started |
| `stop()` | Detach. Safe to call when not started |
| `wait()` | Resolves only when the agent stops — a service's main loop |

### `class BotIDReader`

| Member | What it does |
|---|---|
| `constructor(options)` | Stores settings |
| `_connect()` | Connect once, reuse thereafter |
| `agent(agentId)` | The full record, or **`null`** for an id never issued |
| `check(agentId, policy)` | `meetsPolicy` on the registry — the same question a vault asks in Solidity |
| `request(requestId)` | One job's current state |

### What `agent()` returns

| Field | What it is |
|---|---|
| `agentId`, `owner`, `operator` | Identity |
| `tier`, `active` | Evidence strength, and whether it is accepting work |
| `modelCommitment` | Which model |
| `bond`, `openNotional`, `maxOpenNotional` | Capital position |
| `score`, `faults`, `settledExecutions`, `lastActiveAt` | Track record, **score already decayed to now** |

### `check`'s policy defaults

| Field | Default | Why |
|---|---|---|
| `minScore` | `0` | Permissive |
| `minTier` | `None` | Permissive — any tier |
| `maxFaults` | **`0`** | The exception. Permissive would be infinity; someone who did not think about faults does not want an agent that has committed one |
| `minBond` | `0n` | Permissive |
| `maxStalenessSeconds` | `0` | Permissive — the contract reads 0 as "no staleness check" |

---

## B.12 `index.js`

| Name | What it does |
|---|---|
| `USAGE` | The help text, printed for no command or an unknown one |
| `parseArgs(argv)` | Turns `--key value` into settings. A flag with no value becomes `"true"` |
| `main()` | Dispatch to `agent`, `watchtower`, `arena` or `consumer` |

Exit codes: `0` for help asked for deliberately, `1` for an unknown command or any thrown error.

---

## B.13 The package itself

| Field | Value | What it means |
|---|---|---|
| `name` | `@botid/agent` | The install name |
| `version` | `0.1.0` | |
| `license` | `BUSL-1.1` | Source-available, not open source. See the repo LICENSE |
| `engines.node` | `>=20` | Needs built-in `fetch` and modern syntax |
| `main` / `exports` | `src/sdk.js` | **The library entry point is the SDK**, not the CLI |
| `bin.botid` | `src/index.js` | Installing gives you a `botid` command |
| `files` | `src`, `README.md` | What ships. Note the ABIs travel inside `src` |
| `dependencies` | `ethers` **only** | One dependency, on a key-holding process |

---

## B.14 The key and permission map

Which key does what, and what it costs you if it leaks.

| Key | Can do | If compromised |
|---|---|---|
| `OPERATOR_KEY` | Deliver, resolve challenges | **Serious.** An attacker can deliver garbage in the agent's name and cause faults and slashes. Rotate with `rotateOperator` — this is what that function is for |
| `ENCLAVE_KEY` | Sign Silver attestations | Serious, but **bounded**: enrolments expire within 7 days and a notary can revoke immediately |
| `CONSUMER_KEY` | Order work, settle | Can spend the consumer's tokens and misreport outcomes |
| `CHALLENGER_KEY` | Post challenge bonds | Can waste that account's bonds. No authority over anyone else |
| `WATCHTOWER_KEY` | Call enforcement functions | **Least serious.** Every function it calls is permissionless — anyone may call them. It can waste its own gas |
| `PUBLISHER_KEY` | Sign readings | Serious in production. This is why real deployments use a quorum of independent publishers rather than one |

The Arena is the one role that holds two of these at once — `CONSUMER_KEY` to order and settle,
`PUBLISHER_KEY` to sign the readings it grades against. That concentration is acceptable in a
first-party Arena and is precisely what a third-party consumer would not have; [`arena.md`](arena.md)
says so out loud rather than leaving it to be discovered.

The agent owner's key — the one that posted the bond and can withdraw it — **never appears in this
package at all.** Nothing here can move an agent's bond, change its owner, or withdraw. That
separation is the point of having an operator key distinct from an owner key: the key that runs
day to day is not the key that holds the capital.

---

## Where to go next

- [`arena.md`](arena.md) — the first-party consumer: how work gets ordered and graded
- [`contract.md`](contract.md) — the same treatment for the on-chain half
- [`architecture.md`](architecture.md) — the shorter technical map
- [`../relayer/README.md`](../relayer/README.md) — how to actually run it
