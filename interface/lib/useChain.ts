'use client';
// React bindings over lib/registry.ts and lib/activity.ts.
//
// Both hooks follow the same shape and the shape is the point: `data` is undefined until the first
// answer arrives and stays at the last good answer afterwards, so a refresh that fails leaves the
// numbers already on screen rather than blanking the page. `error` sits beside the data instead of
// replacing it — a stale table with a note is more useful than an empty one with an apology.
//
// Nothing here is seeded with a fixture. A page that has not heard back from the node yet says so.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readAllAgents, readAgent, registryAddress, type AgentView } from './registry';
import { readActivity, readAgentExecutions, readExecutions, type Activity, type AgentExecution } from './activity';
import type { NetworkId } from './network';

export interface Feed<T> {
  data: T | undefined;
  /** True until the first answer, and never again — later refreshes are silent. */
  loading: boolean;
  error?: string;
  /** True where the protocol has no deployment on this network, which is not an error. */
  deployed: boolean;
  refresh: () => void;
}

/**
 * Refresh intervals.
 *
 * The registry moves when someone registers or bonds, which is rare, and each poll costs three
 * calls per agent — so it is slow on purpose. Activity moves with executions and drives a block
 * counter a reader watches tick, so it is faster. Neither is a subscription: `eth_subscribe` over
 * a public HTTP endpoint is not available, and a websocket to an unauthenticated node is a
 * dependency this page does not need.
 */
const AGENTS_MS = 30_000;
const ACTIVITY_MS = 8_000;

export function useAgents(network: NetworkId): Feed<AgentView[]> {
  return usePolled(network, readAllAgents, AGENTS_MS);
}

export function useActivity(network: NetworkId): Feed<Activity> {
  return usePolled(network, readActivity, ACTIVITY_MS);
}

/** Every execution on the router, folded into one row per request. */
export function useExecutions(network: NetworkId): Feed<AgentExecution[]> {
  return usePolled(network, readExecutions, ACTIVITY_MS);
}

/**
 * One agent, and its executions.
 *
 * The id is closed over rather than passed through, so each reader is a `(network) => Promise`
 * like the other two and `usePolled` stays unaware that a second key exists. The dependency is the
 * id as a *string*: two bigints of equal value are not `===`, so a bigint dep would rebuild the
 * callback on every render and restart the poll each time.
 */
export function useAgent(network: NetworkId, agentId: bigint | undefined): Feed<AgentView> {
  const key = agentId?.toString();
  const read = useCallback(
    (n: NetworkId) => (key === undefined ? Promise.resolve(undefined) : readAgent(n, BigInt(key))),
    [key]
  );
  return usePolled(network, read, AGENTS_MS);
}

export function useAgentExecutions(network: NetworkId, agentId: bigint | undefined): Feed<AgentExecution[]> {
  const key = agentId?.toString();
  const read = useCallback(
    (n: NetworkId) => (key === undefined ? Promise.resolve(undefined) : readAgentExecutions(n, BigInt(key))),
    [key]
  );
  return usePolled(network, read, ACTIVITY_MS);
}

function usePolled<T>(
  network: NetworkId,
  read: (network: NetworkId) => Promise<T | undefined>,
  intervalMs: number
): Feed<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const deployed = registryAddress(network) !== undefined;

  // Bumped to force a re-run. A ref would not re-trigger the effect and a boolean toggle reads
  // worse at the call site than "ask again".
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Guards a late answer from a network we have since switched away from. Without it, switching
  // chains mid-request paints the old chain's agents under the new chain's heading — which is the
  // single worst thing a page like this can get wrong.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    let timer: ReturnType<typeof setTimeout>;

    setData(undefined);
    setLoading(true);
    setError(undefined);

    if (!deployed) {
      setLoading(false);
      return;
    }

    const tick = async () => {
      try {
        const next = await read(network);
        if (generation.current !== mine) return;
        setData(next);
        setError(undefined);
      } catch (e) {
        if (generation.current !== mine) return;
        // Kept beside the last good data rather than instead of it. The message is the node's, not
        // a paraphrase — "request failed" tells a reader nothing they can act on.
        setError(e instanceof Error ? e.message : 'Could not reach the node.');
      } finally {
        if (generation.current === mine) {
          setLoading(false);
          // Chained rather than setInterval: a slow answer must not overlap the next request, and
          // an interval with an async body will happily start a second read before the first ends.
          timer = setTimeout(tick, intervalMs);
        }
      }
    };
    tick();

    return () => {
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [network, read, intervalMs, deployed, nonce]);

  return { data, loading, error, deployed, refresh };
}

/**
 * A wall clock that only starts on the client.
 *
 * Seeded at 0 rather than at Date.now(), because a server render and the hydration that follows it
 * read the clock at different instants and React reports the difference as a mismatch. Callers
 * render relative times only once this is non-zero, which is the same moment the chain data they
 * belong to has arrived.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
