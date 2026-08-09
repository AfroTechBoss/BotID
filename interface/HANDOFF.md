# BotID Interface — Next.js scaffold

This folder is a **developer handoff**, not a running build in this environment (which is browser-only and can't execute Node/npm). It's a real Next.js 14 App Router project tree — drop it into a repo, `npm install`, `npm run dev`.

## Relationship to the HTML prototypes

The `.dc.html` files at the project root (Overview, Leaderboard, Agent Profile, Execution Detail, Proof Inspector, Portal, Executions, Docs, About, Brand, Security, Status, the four Legal pages, 404/500/Offline) are **hi-fi design references** — final colors, type, spacing, copy, and interaction behavior. Recreate them here; don't ship the HTML as-is. Where this scaffold's JSX differs in minor ways from the prototypes (it shouldn't, but check), the prototypes are the source of truth for visuals.

## What's real vs. stubbed

- **Design tokens** (`app/globals.css`) are ported exactly from the bound design system (`Modernist`) plus the functional additions (`--tier-*`, `--score-*`, `--live`, `--state-*`) used throughout the prototypes.
- **All 20 routes** exist as real `page.tsx` files with the actual copy and layout from the prototypes.
- **Mock data** (`lib/mock-data.ts`) is a straight TypeScript port of the prototype's generator — swap for the real data-access layer (§11 of the brief: RPC for live tail/point reads, Ponder for history/aggregates) behind the same function signatures.
- **Wallet/chain wiring** (wagmi/viem/RainbowKit config, contract reads, the live `watchContractEvent` feed) is **not implemented** — `components/ConnectWalletButton.tsx` and the network `<select>` are static placeholders. This is the biggest real gap between this scaffold and a shippable app.
- **Charts** are hand-rolled SVG (ported from the prototype) rather than Recharts/visx as the brief recommends — fine for now, swap in Recharts if the sparkline count grows.

## Design tokens

All colors/spacing/type come from CSS custom properties in `app/globals.css` — never hardcode a hex. The tier/score/liveness palette is documented inline there with the rationale (§2.2 of the brief: tier and score are orthogonal axes and must never share a hue).

## Install

```bash
npm install
npm run dev
```

## Structure

```
app/
  layout.tsx            Root layout — mounts <Nav> and <Footer>
  globals.css            Design tokens (Modernist + BotID functional palette)
  page.tsx                /            Overview
  agents/page.tsx         /agents       Leaderboard
  agents/[id]/page.tsx     /agents/[id]  Agent profile
  executions/page.tsx      /executions   All executions
  executions/[requestId]/page.tsx  /executions/[id]  Execution detail (the receipt)
  verify/[requestId]/page.tsx      /verify/[id]      Proof inspector
  portal/page.tsx          /portal       Register / bond / alerts
  docs/page.tsx            /docs
  about/page.tsx           /about
  brand/page.tsx           /brand
  security/page.tsx        /security
  status/page.tsx          /status
  legal/privacy/page.tsx
  legal/terms/page.tsx
  legal/disclaimer/page.tsx
  legal/cookies/page.tsx
  not-found.tsx            404
  error.tsx                500
components/
  Nav.tsx, Footer.tsx, BotIdBadge.tsx, TierChip.tsx, ScoreValue.tsx, ConnectWalletButton.tsx
lib/
  mock-data.ts             Same generator as the HTML prototypes, typed
```

## Next steps for whoever picks this up

1. Wire `wagmi` + `viem` + RainbowKit per §11/§20.7 of the brief (chain configs are sketched there).
2. Replace `lib/mock-data.ts` reads with the typed data-access interface (RPC + Ponder).
3. Implement the live feed via `watchContractEvent` (WebSocket, polling fallback) — currently a `setInterval` simulation.
4. Implement `/portal` transactions (simulate-before-send, decode custom errors to plain sentences per §6.7).
5. Swap the hand-rolled SVG charts for Recharts/visx if desired.
