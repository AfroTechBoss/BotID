'use client';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { DEFAULT_NETWORK, NETWORKS as REGISTRY, NETWORK_IDS, type NetworkId } from './chain';

// The selected network is app-wide state, not the nav's private business. It was local to
// NetworkSelect, so switching to mainnet changed the nav and nothing else — the footer and the
// overview's status bar went on saying "testnet" underneath a nav that said BOT Chain. On a
// protocol interface that is not a cosmetic bug: the whole page is claiming to describe a chain,
// and two parts of it were describing different ones.
// Re-exported rather than defined here. It lives in chain.ts now, beside the registry it is the
// key of, so that adding a chain cannot leave the id union and the chain table disagreeing. Kept
// exported from this module because seventeen files import it from here and none of them care
// where it is declared.
export type { NetworkId };

export interface Network {
  id: NetworkId;
  /** Full name, for the nav switcher. */
  name: string;
  /** Lowercase short form, for the status bars that sit in mono type. */
  short: string;
  chainId: number;
  /**
   * Blockscout base, no trailing slash. Lives here rather than in contracts.ts because it is a
   * property of the chain, not of any one address — and because a table that renders an address
   * under a network heading must build its link from the same object that supplied the heading.
   * Held apart, the two can disagree, which is how an address ends up linking to the wrong chain's
   * explorer and reading as confirmation.
   */
  explorer: string;
  /**
   * Whether this chain is a testnet.
   *
   * A property rather than an id, which is the whole point of the widening: `id === 'mainnet'` was
   * a workable test of "is this real money" while there was exactly one of each, and becomes a bug
   * the moment BotID is on Base as well as BOT Chain. Read off the viem chain object, where it was
   * already recorded and could not drift.
   */
  testnet: boolean;
  /**
   * Whether BotID is actually on this chain yet.
   *
   * Not a synonym for "the chain exists" — BOT Chain is live and producing blocks, it simply has
   * none of our contracts on it. Selecting it would leave every read returning nothing and every
   * write pointed at an address holding no code, which fails as an unhelpful revert rather than as
   * an explanation. So the switcher offers it and then declines, saying why.
   *
   * The flag rather than a hardcoded id check: on the day a chain is deployed to, one entry in
   * chain.ts changes and nothing else in the interface has to be found and edited.
   */
  live: boolean;
}

// Chain ids come from docs/architecture.md, which records them alongside the bn254 precompile
// probe run against each RPC on 2026-08-09. They were 71101/71100 here, which matched nothing:
// Bohr is 968 at https://rpc.bohr.life and BOT Chain is 677 at https://rpc.botchain.ai. A wrong
// chain id on an interface whose security page exists to answer "is this the real BotID" is not a
// cosmetic error, so it is worth stating where the right ones came from.
// Chain id, name and explorer come from lib/chain.ts, which is where viem's chain objects are
// defined, so the switcher and the RPC client cannot end up describing different chains. The
// direction of the import matters and only works one way: chain.ts is a plain module that a server
// component may import, and pulling values *out* of this 'use client' module into it would turn
// them into client references. See the header of lib/contracts.ts for how that bites.
//
// Bohr's explorer was recorded as "not published" in interface/README.md, which was true when that
// table was written and is not any more: scan.bohr.life answers, runs Blockscout, and its
// /api/v2/addresses endpoint returns our AgentRegistry with the right creator. Probed 2026-08-11
// against the deployed address rather than assumed from the hostname pattern — an explorer that
// exists but indexes a different chain would render a "not found" page under a real address, on
// the one page whose job is to prove an address is ours.
//
// Derived from the chain registry rather than written out again. This list was two hand-written
// literals that repeated CHAINS.mainnet.name, CHAINS.mainnet.id and the explorer URL — three
// values already stated in chain.ts, restated here, in an array whose order also had to match. A
// third chain would have been a fourth place to remember. Order, and therefore the switcher order
// and the fallback for an unresolvable id, now comes from NETWORK_IDS alone.
export const NETWORKS: Network[] = NETWORK_IDS.map((id) => ({
  id,
  name: REGISTRY[id].chain.name,
  short: REGISTRY[id].short,
  chainId: REGISTRY[id].chain.id,
  explorer: REGISTRY[id].chain.blockExplorers?.default.url ?? '',
  testnet: REGISTRY[id].chain.testnet === true,
  live: REGISTRY[id].live,
}));

// DEFAULT_NETWORK moved to chain.ts, where a server component can read it, and is re-exported here
// so callers that think of it as a network concern still find it.
export { DEFAULT_NETWORK };

interface NetworkContextValue {
  network: Network;
  setNetwork: (id: NetworkId) => void;
  /**
   * A network that was asked for and refused, held until it is dismissed.
   *
   * It lives here rather than in the switcher because the switcher does not survive the click that
   * sets it. Below 720px the trigger is inside the nav's hamburger panel, and choosing an option
   * closes the panel — which unmounted the explanation along with it, so on a phone the refusal was
   * silent and the network simply appeared not to change. Held at the provider, the dialog outlives
   * whatever control asked the question.
   */
  pending: Network | undefined;
  dismissPending: () => void;
}

// Defaulting rather than throwing on a missing provider is deliberate: every route
// renders through the root layout, and a component that reads the network should never be the
// reason a page fails to render.
const NetworkContext = createContext<NetworkContextValue>({
  network: NETWORKS[0],
  setNetwork: () => {},
  pending: undefined,
  dismissPending: () => {},
});

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [id, setId] = useState<NetworkId>(DEFAULT_NETWORK);
  const [pending, setPending] = useState<Network>();
  // One place decides. Any caller — the switcher today, a deep link or a saved preference later —
  // asks for a network and either gets it or gets an explanation; nobody has to remember to check
  // `live` first. The refusal is recorded rather than swallowed, because a switch that quietly
  // does nothing looks like a broken control.
  const setNetwork = useCallback((next: NetworkId) => {
    const target = NETWORKS.find((n) => n.id === next);
    if (!target) return;
    if (!target.live) {
      setPending(target);
      return;
    }
    setId(next);
  }, []);
  const dismissPending = useCallback(() => setPending(undefined), []);
  const value = useMemo(
    () => ({ network: NETWORKS.find((n) => n.id === id) ?? NETWORKS[0], setNetwork, pending, dismissPending }),
    [id, setNetwork, pending, dismissPending]
  );
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork() {
  return useContext(NetworkContext);
}
