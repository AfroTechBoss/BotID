# BotID Interface

The web interface to BotID Protocol — verifiable execution and capital-weighted reputation for
autonomous agents on BOT Chain. The contracts it reads are in [`../contracts`](../contracts),
in this same repository.

**Nothing is built yet.** This directory currently holds the scaffold only. The build starts at
Phase 0 of the brief's build order.

---

## What this is

An interface, not the protocol. The contracts are on chain and run whether or not this site does —
sharing a repository with them does not change that, and nothing here is required for the protocol
to work. This directory renders public chain state and, on the portal routes, prepares
transactions the user's own wallet signs. It never holds funds or keys.

Four things it has to do well:

1. **Narrate the lifecycle** — request → deliver → challenge → finalize → settle — as it happens.
2. **Rank agents** by a score that means adherence, not profit.
3. **Make a proof checkable by a sceptic**, without asking them to trust this page.
4. **Let an operator register, bond and unbond** without leaving the browser.

## Ground rules

These are the ones that are easy to get wrong and expensive to reverse:

- **Score moves on `settle`, weighted by capital. Never on verification.** Proof validity is
  constant across all agents — invalid proofs revert and never land — so a score-per-proof number
  carries no information. There is no "+10 per proof" anywhere in this product.
- **Verification tier and score are orthogonal.** A Gold proof says the model ran as registered.
  It says nothing about whether the model is any good. Tier owns metal hues and shape; score owns
  a ramp diverging around 5000; cyan is reserved for liveness alone.
- **5000 is neutral, not failing.** New agents start there.
- **Every number on screen carries its provenance** — proved, attested, consumer-reported, or
  derived.
- **Read-only pages render fully without a wallet.** Wallet connection gates `/portal` and
  nothing else.

The design brief expands all of these with the reasoning behind them.

## The design brief

[`../docs/frontend-brief.local.md`](../docs/frontend-brief.local.md) — the full design and build
specification: product truth, design tokens with verified contrast ratios, information
architecture, view specs, component inventory, required states, motion, data layer,
accessibility, copy lexicon, legal and system pages, and the phased build order.

It is **gitignored** (`*.local.md`), deliberately. It is a working document and it changes faster
than the code. There is exactly one copy of it, at the repository root — living in the same repo
as the contracts is what removed the need to keep two copies in step by hand.

## Stack (decided, not yet installed)

```
Next.js (App Router) + TypeScript strict
wagmi v2 + viem + RainbowKit
TanStack Query        — server state
TanStack Table/Virtual — leaderboard, feed
Tailwind + CSS variables — design tokens as vars
shadcn/ui on Radix    — primitives, generated into the repo and re-tokenised
Recharts or visx      — charts
Zustand               — feed buffer and UI prefs only
```

Protocol components — the badge, the tier chip, the field-element viewer, the commitment check —
are hand-built. That is where the design budget goes.

## Chain

| | Mainnet | Testnet ("Bohr") |
|---|---|---|
| Chain ID | 677 | 968 |
| RPC | `https://rpc.botchain.ai` | `https://rpc.bohr.life` |
| WSS | `wss://ws-rpc.botchain.ai` | not published |
| Explorer | `https://scan.botchain.ai` (Blockscout) | `https://scan.bohr.life` (Blockscout) |
| Native | BOT, 18 decimals, no contract | BOT (test) |
| Block time | ~0.75s | ~0.75s |
| Gas | flat 20 gwei, `baseFeePerGas` 0 | flat 20 gwei |

Probed 2026-08-09, not transcribed. The testnet RPC is not in BOT Chain's integration guide — it
was derived from the bundler hostname and confirmed to answer on chain 968; get it confirmed
before depending on it.

Both chains expose the bn254 precompiles at Istanbul prices, so Gold-tier verification works on
chain: roughly 200–250k gas for a three-pair Groth16 verify, about 5 cents at 20 gwei.

## Data

There is no subgraph and there will not be one — The Graph does not support chain 677. At 0.75s
blocks the chain produces ~115,000 blocks a day, so direct RPC reaches back about ten hours before
history becomes unusable.

So the interface runs **two data sources permanently**, behind one typed data-access interface:

- **RPC (viem)** — live event tail and point reads. Anything "current".
- **Ponder** — history and aggregates. Anything "over time" or "ranked". The leaderboard and the
  score chart cannot exist without it, which puts the indexer in Phase 1, not last.

Blockscout's REST API covers token metadata and verified-source links for `/security`.

Contract ABIs and event signatures come from [`../contracts/abi`](../contracts/abi) — checked-in
TypeScript, exported `as const` so viem infers call and return types. Never transcribed by hand,
and never read from `contracts/artifacts`, which is a gitignored build product that does not
exist on a build host.

The bond token uses viem's `erc20Abi`. The protocol's own `IERC20` is deliberately not exported —
it declares only what `SafeTransfer` calls, so it has no `approve` and no `decimals`.

## Local protocol chain

The interface is developed against a local chain running the real contracts:

```bash
cd ../contracts && npx hardhat node
```

```bash
cd ../contracts && npx hardhat run scripts/deploy.js --network localhost && npx hardhat run scripts/seed.js --network localhost
```

```bash
cd ../relayer && node src/index.js agent
```

Then commission work against it, and watch the feed narrate the arc:

```bash
cd ../relayer && node src/index.js consumer request --agent 1 --notional 100000 --fee 100
```

## Status

Scaffold only. No application code and no dependencies installed.

Licensing is now a repository-wide question rather than an interface-only one: `contracts/` and
`interface/` share a history, so whatever license lands at the root covers both. `contracts/`
already declares MIT in its `package.json`, and there is no `LICENSE` file yet.
