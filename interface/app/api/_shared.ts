// Shared plumbing for the read API.
//
// The API exists because the on-chain read is only usable by things that can make an on-chain
// read. A vault written in Solidity calls `meetsPolicy` directly and should keep doing so — it is
// the authority. But a trading bot in Python, a Discord gate, a dashboard someone is prototyping:
// none of those want an RPC client and an ABI decoder in order to ask whether an agent is
// trustworthy. This is the number on the door, not a replacement for the deeds at the registry.
//
// Underscore-prefixed so the App Router does not treat it as a route.

// CHAINS, not NETWORKS. lib/network.tsx is a 'use client' module, and anything exported from one
// becomes a client reference when the server imports it — calling .find() on it throws
// "Attempted to call find() from the server", which is the same trap lib/contracts.ts documents
// at the top of the file. It cost a 500 on every request that named a network explicitly, and
// only that: the no-parameter path returned before ever touching the array, so the bug hid behind
// the default. lib/chain.ts carries the same chain data and says in its first line that it has no
// 'use client' precisely so server code can read it.
import { CHAINS } from '@/lib/chain';
import type { NetworkId } from '@/lib/network';

const NETWORK_IDS = Object.keys(CHAINS) as NetworkId[];

/**
 * JSON with bigints written as strings.
 *
 * `JSON.stringify` throws on a bigint rather than guessing, which is correct of it — there is no
 * safe number to fall back to. Every quantity here is in base units and several exceed 2^53, so
 * serialising as a JSON number would silently round somebody's bond. Strings preserve the value
 * and force the reader to decide what to do about scale, which is the same discipline the
 * interface follows internally.
 */
export function json(data: unknown, init?: { status?: number; cache?: string }) {
  const body = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A public read of public chain state. Reads are free and always will be, and an API that
      // requires an origin allowlist is one no agent can call from wherever it happens to run.
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      // Short, because reputation moves. Long enough that a bot polling every few seconds is
      // answered from the edge instead of from an RPC node that serialises its callers.
      'cache-control': init?.cache ?? 'public, s-maxage=10, stale-while-revalidate=30',
    },
  });
}

/** An error the caller can act on: what went wrong, and which value caused it. */
export function fail(status: number, error: string, detail?: Record<string, unknown>) {
  return json({ error, ...detail }, { status, cache: 'no-store' });
}

/**
 * Resolve `?network=`, defaulting to testnet.
 *
 * Defaulting is safe here in a way it is not in `lib/contracts.ts`: this route only ever reads,
 * and a read against the wrong network returns a wrong answer rather than sending a transaction
 * into one. The response echoes the network back so a caller who forgot the parameter can see
 * which chain answered.
 */
export function parseNetwork(url: URL): { network: NetworkId } | { error: Response } {
  const raw = url.searchParams.get('network');
  if (!raw) return { network: 'testnet' };
  const match = NETWORK_IDS.find((id) => id === raw || String(CHAINS[id].id) === raw);
  if (!match) {
    return {
      error: fail(400, 'unknown network', {
        given: raw,
        known: NETWORK_IDS.map((id) => ({ id, chainId: CHAINS[id].id })),
      }),
    };
  }
  return { network: match };
}

/**
 * Parse an agent id from the path.
 *
 * Rejects anything that is not a non-negative integer rather than letting BigInt() throw a
 * SyntaxError that would surface as a 500. A bad id in a URL is the caller's mistake, and a 400
 * says so; a 500 would tell them the server is broken and send them to the wrong place looking.
 */
export function parseAgentId(raw: string): bigint | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const id = BigInt(raw);
  return id > 0n ? id : undefined;
}

export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}
