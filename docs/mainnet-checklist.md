# Deploying BotID to mainnet

BotChain, chain 677, `rpc.botchain.ai`. This is the checklist for putting the protocol somewhere
that real capital can reach it.

It is deliberately not a list of commands. The commands are the easy part — `deploy.js` already
knows how to deploy to 677, and has since the day the network table was written. What follows is
the set of decisions that are cheap to make now and expensive to discover afterwards, ordered so
that each one can still be reversed when you reach it.

The redeploy checklist in `contract.md` §8 covers what to update *after* any deployment. That list
applies here too and is not repeated. This document covers what is different about a deployment
you cannot take back.

---

## 0. What makes mainnet different

Three properties combine badly, and the whole document follows from them.

**The contracts are immutable.** Six of the eight have no upgrade path — `registry`, `engine` and
`bondToken` are `immutable` fields, so no single contract can be swapped while the rest stay. Any
change is a full new address set.

**The state that matters cannot be migrated.** An agent's score is the product. It is earned
slowly, on purpose, and `halfWeight` exists specifically to make it expensive to manufacture. There
is no export and no import; a new registry starts every agent at neutral. On testnet the four
redeploys so far cost nothing because the orphaned scores were worthless. On mainnet the orphaned
scores are the reason anyone is there.

**Signatures are bound to addresses.** The EIP-712 domain includes the verifying contract, so an
attestation signed for one adapter does not verify at its replacement. There is no window in which
both sets work and no way to drain one into the other.

Together: a redeploy on testnet is moving house. A redeploy on mainnet is burning the house down
and asking the residents to rebuild from memory. Everything below is written to avoid needing one.

---

## 1. Gates — decisions, not tasks

None of these are things to tick off during a deploy. They are conditions to satisfy before a
deploy is scheduled at all, and each one can stop the whole thing.

| Gate | Why it stops the deploy |
|---|---|
| **The fixes have run on a live chain** | ~~Met 2026-09-03.~~ The post-`8c03858` set was deployed to Bohr on 2026-09-01 (registry `0xB6D13d5B…74e6Dc`) and `canEscalate` has been read on chain returning true for a live agent. `weightPerFeeUnit` is set from the manifest, `effectiveTier`, `recordDelivery` and `provenBy` have still only executed in tests — nothing has settled on Bohr yet, so this gate is met only in the narrow sense that the code is no longer test-only |
| **A third-party audit exists** | What ran was an internal review. Three of its findings are still open. The docs say "unaudited" deliberately, and a mainnet address published under that word invites people to read it as a formality |
| **A full lifecycle has been exercised end to end on Bohr** | Register, request, deliver, challenge, resolve, settle, and a settlement that defaults. Against the redeployed set, not a memory of the last one |
| **The alert path has delivered at least one real webhook** | It never has — there were no agents to subscribe to. The first time that code posts should not be the time it is telling someone their bond is being slashed |
| **The owner is a multisig, and it has been tested** | See §3. Not "will be moved to a multisig later": the wiring calls in §4 are owner-only, and moving ownership afterwards is a separate trust event |

Bohr is producing blocks again — the halt at 21,768,658 cleared, and the set above was deployed
at 21,931,893. That unblocked the first gate and makes the third and fourth reachable rather than
impossible; neither has been done. As of 2026-09-03 the standing blockers are the audit, a full
lifecycle exercised end to end on Bohr, one real webhook delivery, and the owner key.

---

## 2. Decide before you open a terminal

`deploy.js` takes all of this from the environment, and **everything except `BOND_TOKEN` has a
default.** That is the trap: a deploy with a half-filled `.env` does not fail, it succeeds with
defaults that are wrong for mainnet in ways nothing will report.

### The two that default to the deployer

```
OWNER      protocol owner       (default: the deploying key)
TREASURY   fees and slash residue (default: the deploying key)
```

Left unset, a mainnet protocol is owned by whichever hot key happened to run the script, and every
fee flows to it. Both must be set explicitly. Set them even if the value you want *is* the deployer
address, so the manifest records a decision rather than an accident.

### The one with no default — and the trap inside it

```
BOND_TOKEN   the ERC-20 agents bond and consumers pay in
```

The script refuses to proceed without it on a non-local network. It is the unit every economic
parameter is denominated in, and it cannot be changed afterwards because `bondToken` is immutable.

For BotChain this is already determined and verified: **USDT at
`0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C`, 6 decimals**, recorded in
`interface/lib/contracts.ts` as `ADDRESSES.mainnet.bondToken`. Re-probed 2026-08-31 against
`rpc.botchain.ai`: `symbol()` returns USDT, `decimals()` returns 6.

**Do not carry Bohr's bond token address across.** The two USDT deployments live at different
addresses — Bohr's at `0x75edC933…20fe3` — and crossing them does not fail. The mainnet address on
Bohr resolves to **WES, a live and unrelated 18-decimal token**; verified on the same date, it
answers `symbol()` with WES and `decimals()` with 18. A deploy pointed there reads 18, scales every
capital parameter by a **trillion**, and reverts nothing. `MIN_BOND=100` becomes 100 × 10¹⁸ of a
token nobody holds, and the protocol is deployed, wired, and unusable, with a correct-looking
manifest.

This is the single most dangerous value in the environment, because it is the one where the wrong
answer looks exactly like the right one.

### The economic parameters

`HALF_WEIGHT`, `WEIGHT_CAP`, `MIN_BOND`, `GLOBAL_NOTIONAL_CAP`, `CHALLENGE_BOND`, all in whole
tokens. The testnet defaults (1000 / 10000 / 100 / 5000000 / 50) were chosen so a faucet could fund
a demonstration. They are not mainnet numbers and should not arrive by default.

`MIN_BOND` and `CHALLENGE_BOND` deserve particular thought because they are the two that set who
can participate. A challenge bond low enough to be free is an invitation; high enough to hurt is a
barrier to the watchtower economics the protocol depends on.

The rest of the tunables in `contract.md` §8 are owner-settable after the fact and are not
irreversible decisions. These five are, in effect: raising `MIN_BOND` later strands agents who
registered under the old floor.

### The operator sets

`PUBLISHERS` and `PUBLISHER_QUORUM` (input feeds), `TEE_NOTARIES` (who may enroll Silver enclaves).
Empty means that tier is inert. On mainnet, inert is a better failure than wrong — an empty notary
set means nobody can enroll an enclave, whereas a wrong one means someone you did not intend can.

### Gold

`DEPLOY_GOLD=false` skips the Gold adapter, its verifier and the model binding. Consider shipping
without it. Gold binds a specific circuit commitment at a specific input scale, that binding is the
part most likely to need revising, and a tier that does not exist yet is easier to add than a tier
bound to the wrong verifier. Adding an adapter later is `setAdapter` — which after §4 is a 21-day
round trip, so this is a real trade rather than a free option.

---

## 3. The owner key

On mainnet the owner is the protocol. It sets the router, the writers, the adapters and the input
attestor — the four things that determine who may take an agent's bond. That is why they end up
behind the timelock in §4 and why `AgentRegistry.sol:102` enforces `TIMELOCK_DELAY >=
UNBONDING_PERIOD`: a bond must never be re-pointable faster than its owner can withdraw it.

Use a multisig. But understand what it costs at deploy time, because it is not free:

**Every wiring call in §4 is owner-only, so with a multisig `OWNER` they all revert during the
deploy run.** The script expects this — it catches them, records them in the manifest as
`pendingOwnerCalls`, and prints:

> `! N owner-only call(s) still outstanding. The protocol is NOT usable until they are executed
> from <owner>.`

So a multisig deployment is inherently two phases, with a gap between them. Plan the gap. It is the
most dangerous window in the whole process and §4 is entirely about it.

The alternative — deploy from a hot key, wire it, then transfer ownership — closes that window and
opens a worse one, in which a single hot key has, at some point, held total control of a live
protocol. Prefer the multisig and manage the gap.

---

## 4. The wiring window

After deployment the contracts exist and do nothing. Owner-only calls make them a protocol —
**eight without Gold, twelve with it** — and they must be executed in this order:

```
engine.setWriter(registry, true)
engine.setWriter(router, true)
registry.setRouter(router)
router.setAdapter(Bronze, sigAdapter)
router.setAdapter(Silver, teeAdapter)
router.setAdapter(Gold,   zkAdapter)      — only if Gold is deployed
zkAdapter.setRouter(router)               — only if Gold is deployed
zkAdapter.setVerifier(commitment, verifier, scaleBits)
                                          — only if Gold is deployed
engine.finalizeBootstrap()
registry.finalizeBootstrap()
router.finalizeBootstrap()
zkAdapter.finalizeBootstrap()             — only if Gold is deployed
```

Order matters twice over.

**The wiring order is the one the test suite exercises.** The engine must accept writes from both
the registry and the router before anything settles; the registry must know the router before any
execution is requested. A set missing one of those calls looks healthy right up until the first
settlement reverts.

**`finalizeBootstrap` must be last, and it is one-way per contract.** It puts `setRouter`,
`setWriter`, `setAdapter` and `setInputAttestor` behind a 21-day notice period. Anything not wired
before it becomes a three-week round trip — on a live protocol, in public.

That produces the single worst mistake available here: **finalizing bootstrap on a contract whose
wiring is incomplete.** There is no recovery. The protocol sits visibly broken for 21 days while
the correction waits out a timelock built to protect against exactly the kind of change you are now
forced to make.

So, concretely:

- Batch the wiring calls in the multisig if it supports batching, with `finalizeBootstrap` in a
  **separate, later** batch.
- Between the two, read the state back on chain rather than trusting the transactions succeeded:
  `adapters(1..3)` resolve to the three adapters, `engine.writers()` is true for both the registry
  and the router, `registry.router()` is the router, and for Gold, `modelFor(commitment)` returns
  the verifier at the right scale.
- Only then finalize. `bootstrapped()` returning true on all four is the last thing that happens.
- A deployment that never reaches `finalizeBootstrap` **has no timelock at all.** The manifest
  records what `bootstrapped()` actually returns rather than what the script intended, so read that
  field and do not infer it.

---

## 5. The deploy itself

```bash
node scripts/deploy-botchain.js          # preflight and print, deploy nothing
node scripts/deploy-botchain.js --yes    # preflight, then deploy
```

`scripts/deploy-botchain.js` carries the §2 configuration as code and passes it to
`scripts/deploy.js` as environment for one child process. That is deliberate rather than
convenient: `hardhat.config.js` prefers real environment variables over `contracts/.env`, so the
mainnet values never have to be written into the shared `.env` — which is how the wrong-token case
above reaches a later `--network bohr` run. It refuses to start unless the RPC answers chain 677
and `BOND_TOKEN` answers USDT at 6 decimals, and it deploys nothing without `--yes`.

The raw form still works and is what the script runs:

```bash
npx hardhat run scripts/deploy.js --network botchain
```

Use it only with the environment set for that one command. Run bare, it takes whatever is in
`contracts/.env` — today, Bohr's values — and succeeds.

Notes specific to 677:

- The manifest is written to `contracts/deployments/botchain-677.json` — a **different file** from
  the Bohr one, so a mainnet deploy cannot clobber the testnet record. This is the one place the
  process is forgiving.
- `chainId: 677` is declared in `hardhat.config.js`, so ethers checks it against the node on
  connect. This matters more than it looks: BotChain and Bohr have the **same 0.750 s block time**
  and heights within ~172,000 blocks of each other, so an RPC pointed at the wrong one produces
  entirely plausible numbers. The chain-id check is the only thing that catches it.
- `PRIVATE_KEY` stays commented out in `contracts/.env` until the moment of the deploy, and goes
  back afterwards. `hardhat.config.js` returns an empty accounts list rather than throwing, so the
  failure mode without it is "no signer" rather than a signature from the wrong key.
- **Commit the manifest.** The script overwrites in place with no confirmation and git is the only
  history the addresses have.

---

## 6. Propagating the addresses

Everything in `contract.md` §8 "After a redeploy" applies, plus these, because that table assumes
Bohr:

| Update | Where |
|---|---|
| The interface's address table | `interface/lib/contracts.ts`, `ADDRESSES.mainnet` — the network key is `mainnet`, not `botchain`, and it currently holds only `bondToken`, which the page correctly renders as "nothing deployed here" because the dependency flag excludes it from the count |
| The log-scan start block | `DEPLOY_BLOCK.mainnet` in the same file — undefined today, and undefined means callers cannot scan a chain we are not on. Set it to the manifest's first block or every log query starts from genesis |
| The relayer | reads the manifest off disk and needs nothing — the model the rest of these should follow |
| The alerts daemon and API | both key on `(chain_id, registry)`; a 677 subscription is a new row, and nothing needs migrating |
| The timelocked-setter count | `interface/app/docs/page.tsx`, `security/page.tsx` (twice), `legal/disclaimer/page.tsx` — these say **five**, and become **six** the moment a set carrying `ZkAdapter.setRouter` is deployed |
| Explorer verification | `scripts/verify.js --network botchain`. Do it from the tree that produced the deploy, not from `main` later — that is exactly how six of Bohr's eight ended up permanently unverifiable |

Do the address updates in the same commit as the manifest. A deploy split across two commits has a
window in which the repository describes two different protocols.

---

## 7. The first week

Things worth watching that no test covers, because they only exist once real money does:

- **The first settlement.** It is the first time the wiring is proven in production, and the
  failure mode of missing wiring is a revert here rather than at deploy.
- **The first challenge.** Check `canEscalate` answers honestly for an agent with no registered
  circuit. That is the fix that has never run on a live chain.
- **`settleDefault` on a real silent consumer.** Confirm the score does not move and the money
  still splits.
- **Decay.** With a 90-day half-life nothing visible happens for weeks. The first real test of the
  score sweep in the alerts daemon is the first threshold crossing that no transaction caused, and
  it will arrive without an on-chain event to corroborate it.
- **The treasury balance.** It should be receiving the protocol cut. If it is not, the address is
  wrong and every fee since block one has gone somewhere else.

---

## 8. What this document cannot tell you

Whether to do it at all. The gates in §1 are conditions, not permission — an unaudited protocol
holding real bonds is a decision with an owner, and the owner is not this file.

The honest summary of the current position: the code is more careful than it was, the internal
review found real vulnerabilities and they were fixed, and none of those fixes has executed on any
live chain. That last clause is the whole argument for waiting.
