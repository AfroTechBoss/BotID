// Chain definitions and read clients. No 'use client': a server component reading a point value
// should be able to import this, and nothing here touches the browser.
//
// viem rather than wagmi, matching how this repo has resolved every other dependency question —
// contracts/hardhat.config.js writes six lines of .env parsing rather than take dotenv. wagmi's
// value is React state management around a connector zoo; we support one connector (whatever
// injected provider the browser has) and one piece of state (the selected account). That is a
// context and a hook, in lib/wallet.tsx, and it costs less than the wrapper would.

import { createPublicClient, http, defineChain, type PublicClient } from 'viem';
import type { NetworkId } from './network';

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

export const CHAINS = { testnet: bohr, mainnet: botchain } as const;

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
      }),
      // Below the ~0.75s block time, so a confirmation is noticed in the block it lands in.
      pollingInterval: 500,
    }) as PublicClient;
    clients.set(network, client);
  }
  return client;
}

/** Explorer URL for an address or a transaction hash on `network`. */
export function explorerLink(network: NetworkId, kind: 'address' | 'tx', value: string): string {
  return `${CHAINS[network].blockExplorers.default.url}/${kind}/${value}`;
}
