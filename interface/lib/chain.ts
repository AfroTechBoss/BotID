// Chain definitions and read clients. No 'use client': a server component reading a point value
// should be able to import this, and nothing here touches the browser.
//
// viem rather than wagmi, matching how this repo has resolved every other dependency question —
// contracts/hardhat.config.js writes six lines of .env parsing rather than take dotenv. wagmi's
// value is React state management around a connector zoo; we support one connector (whatever
// injected provider the browser has) and one piece of state (the selected account). That is a
// context and a hook, in lib/wallet.tsx, and it costs less than the wrapper would.

import { createPublicClient, http, defineChain, type Chain, type PublicClient } from 'viem';

// RPC and explorer URLs are the ones probed on 2026-08-09 and recorded in interface/README.md.
// Block time is ~0.75s on both, which matters here only in that `pollingInterval` is set below it
// rather than at viem's 4s default — a receipt that lands in one block should not take four
// seconds to show up in the UI.
export const bohr = defineChain({
  id: 968,
  name: 'Bohr Testnet',
  nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.bohr.life'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://scan.bohr.life' } },
  testnet: true,
});

export const botchain = defineChain({
  id: 677,
  name: 'BOT Chain',
  nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.botchain.ai'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://scan.botchain.ai' } },
});

/**
 * What BotID needs to know about a chain that viem's chain object does not say.
 *
 * This is the widening point. `NetworkId` used to be the hand-written union `'testnet' | 'mainnet'`,
 * which worked while there were exactly two chains and one of each kind — and stops working the
 * moment there is a second mainnet, because "mainnet" then names a category rather than a chain.
 * The ids are chain slugs now, and whether a chain is a testnet is read off the viem object where
 * it was always recorded.
 *
 * `blockTimeMs` and `logWindow` were module constants shared by both chains, which was true only by
 * coincidence: Bohr and BOT Chain both produce a block about every 0.75s. They are properties of a
 * chain, and holding them per chain is what stops a 12s chain and a sub-second chain from being
 * scanned with the same window — the first concrete thing that breaks on a mixed list.
 *
 * `live` means BotID has contracts here, not that the chain exists. See `Network.live` in
 * network.tsx for why that distinction is load-bearing.
 */
export interface NetworkMeta {
  chain: Chain;
  /** Lowercase short form, for the status bars that sit in mono type. */
  short: string;
  /** Whether BotID is actually deployed on this chain. */
  live: boolean;
  /** Approximate seconds per block, in ms. Used for bucketing, never to date a single event. */
  blockTimeMs: number;
  /** The largest span a single `eth_getLogs` may cover on this chain. */
  logWindow: bigint;
}

/**
 * Every chain the interface knows about. Adding one is an entry here and a row in
 * `ADDRESSES` (lib/contracts.ts); nothing else in the app enumerates chains.
 *
 * Order is the order of the nav switcher, and the first entry is the fallback for an id that does
 * not resolve — so array order, switcher order and the default are one thing rather than three.
 */
export const NETWORKS = {
  botchain: { chain: botchain, short: 'botchain', live: true, blockTimeMs: 750, logWindow: 50_000n },
  bohr: { chain: bohr, short: 'bohr', live: true, blockTimeMs: 750, logWindow: 50_000n },
} as const satisfies Record<string, NetworkMeta>;

export type NetworkId = keyof typeof NETWORKS;

/** Every known id, in switcher order. */
export const NETWORK_IDS = Object.keys(NETWORKS) as NetworkId[];

/**
 * The viem chain per id. Derived rather than written out a second time: the switcher and the RPC
 * client cannot end up describing different chains if there is only one place they come from.
 */
export const CHAINS: Record<NetworkId, Chain> = Object.fromEntries(
  NETWORK_IDS.map((id) => [id, NETWORKS[id].chain as Chain])
) as Record<NetworkId, Chain>;

/**
 * The network a caller gets when nothing says otherwise.
 *
 * BOT Chain since 2026-09-03. It was Bohr for as long as Bohr was the only deployment, and the flip
 * is not cosmetic: the default decides which chain an unmodified wallet prompt is asking about and
 * which addresses every table on the site is showing. BOT Chain is where a bond is real money, so
 * it is the one a first-time reader should be looking at — landing on a testnet and assuming
 * otherwise is the more expensive mistake of the two.
 *
 * It lives here rather than in network.tsx because server components need it too, and anything
 * exported from a 'use client' module becomes a client reference when the server imports it. See
 * the header of lib/contracts.ts for how that bites.
 */
export const DEFAULT_NETWORK: NetworkId = 'botchain';

/**
 * Resolve a `?network=` parameter against the registry, by slug or by chain id.
 *
 * One resolver for three call sites that each had their own. The two server pages both read
 * `search.network === 'mainnet' ? 'mainnet' : 'testnet'`, which silently answered testnet for
 * anything it did not recognise — including a chain id, and including the string 'botchain' — while
 * the read API resolved properly against the registry and defaulted the other way. A link carrying
 * the wrong chain's receipt is exactly the failure the network switcher exists to prevent.
 *
 * Returns undefined for a value that names no known chain, so a caller can tell "not given" from
 * "given and wrong" and answer a wrong one with an error rather than a different chain's data.
 */
export function networkFromParam(raw: string | string[] | undefined): NetworkId | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return NETWORK_IDS.find((id) => id === raw || String(CHAINS[id].id) === raw);
}

/**
 * One client per network, made on first use and kept.
 *
 * Cached because viem clients hold a request cache and a polling loop, and a fresh one per render
 * would mean every component that reads a value opens its own — the same block fetched a dozen
 * times a second against a public RPC with no key. The map is module scope, which on the server
 * means per process and in the browser means per tab; both are the right lifetime.
 */
const clients = new Map<NetworkId, PublicClient>();

export function publicClient(network: NetworkId): PublicClient {
  let client = clients.get(network);
  if (!client) {
    client = createPublicClient({
      chain: CHAINS[network],
      transport: http(undefined, {
        // A public RPC with no key will occasionally just fail. Two retries on top of the request
        // is the difference between a transient blip and a component that renders an error.
        retryCount: 2,
        retryDelay: 300,
        /**
         * Concurrent requests are collected for a tick and sent as one JSON-RPC batch.
         *
         * This is not a micro-optimisation, it is the single largest thing wrong with these pages.
         * Measured against rpc.bohr.life on 2026-08-11, with the connection already warm:
         *
         *   one eth_call                       516ms
         *   three eth_calls, in parallel      2431ms   ← slower than doing them one at a time
         *   three eth_calls, batched           471ms
         *
         * Three at once costing five times one is the giveaway: the endpoint is not serving them
         * in parallel at all. It is a single queue, and opening more connections just means waiting
         * in more of them — like sending three people to the same one-teller bank instead of
         * sending one person with three forms. Batching hands over the three forms.
         *
         * Everything above this line was already written to fire requests concurrently, so the
         * whole interface gets the improvement without changing a call site.
         */
        batch: true,
      }),
      // Below this chain's block time, so a confirmation is noticed in the block it lands in.
      // Floored at 250ms: on a chain producing blocks every few tens of milliseconds, polling at
      // the block time would hammer a public RPC for no visible gain.
      pollingInterval: Math.max(250, Math.round(NETWORKS[network].blockTimeMs * 0.7)),
    }) as PublicClient;
    clients.set(network, client);
  }
  return client;
}

/**
 * Approximate seconds per block on `network`, in ms. Used only to turn a block number into a rough
 * wall clock for bucketing — never to date a single event, which is read off the block itself.
 *
 * Was a single shared constant, correct only because both BOT Chain networks happen to run at the
 * same speed. On a list that also holds a 12s chain, one number for all of them puts every bucket
 * on the wrong day.
 */
export function blockTimeMs(network: NetworkId): number {
  return NETWORKS[network].blockTimeMs;
}

/**
 * The largest span a single `eth_getLogs` may cover, per chain.
 *
 * Public RPCs cap the range and answer a wider one with an error rather than a truncated result,
 * so the cap has to be ours or theirs — and theirs arrives as a failed page. 50k blocks is under
 * every limit we have seen and is about ten hours of Bohr.
 *
 * This matters more each day rather than less, and more still per chain added. 50k blocks is ten
 * hours of Bohr, about a week of Ethereum, and a matter of minutes on a chain producing blocks
 * faster than one a second — so a chain fast enough to make this many windows is a chain that needs
 * an indexer before it needs a switcher entry. Held per chain so that arrives as a number to tune
 * rather than a page that quietly times out.
 */
export function logWindow(network: NetworkId): bigint {
  return NETWORKS[network].logWindow;
}

/** Splits [from, to] into windows `network`'s RPC will accept. Inclusive at both ends. */
export function logWindows(network: NetworkId, from: bigint, to: bigint): { fromBlock: bigint; toBlock: bigint }[] {
  const span = logWindow(network);
  const out: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = from; start <= to; start += span) {
    const end = start + span - 1n;
    out.push({ fromBlock: start, toBlock: end > to ? to : end });
  }
  return out;
}

/**
 * Explorer URL for an address or a transaction hash on `network`.
 *
 * Empty string where a chain has no explorer configured. viem's `Chain` makes `blockExplorers`
 * optional and a new entry can legitimately arrive without one, so the caller gets a dead link
 * rather than a crashed render — and `explorerFor` below is how a caller checks first.
 */
export function explorerLink(network: NetworkId, kind: 'address' | 'tx', value: string): string {
  const base = explorerFor(network);
  return base ? `${base}/${kind}/${value}` : '';
}

/** The explorer base for `network`, no trailing slash, or undefined where there is none. */
export function explorerFor(network: NetworkId): string | undefined {
  return CHAINS[network].blockExplorers?.default.url;
}
