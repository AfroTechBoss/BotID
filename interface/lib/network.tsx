'use client';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { CHAINS } from './chain';

// The selected network is app-wide state, not the nav's private business. It was local to
// NetworkSelect, so switching to mainnet changed the nav and nothing else — the footer and the
// overview's status bar went on saying "testnet" underneath a nav that said BOT Chain. On a
// protocol interface that is not a cosmetic bug: the whole page is claiming to describe a chain,
// and two parts of it were describing different ones.
export type NetworkId = 'testnet' | 'mainnet';

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
   * Whether BotID is actually on this chain yet.
   *
   * Not a synonym for "the chain exists" — BOT Chain is live and producing blocks, it simply has
   * none of our contracts on it. Selecting it would leave every read returning nothing and every
   * write pointed at an address holding no code, which fails as an unhelpful revert rather than as
   * an explanation. So the switcher offers it and then declines, saying why.
   *
   * The flag rather than a hardcoded `id !== 'mainnet'` check: on the day mainnet is deployed this
   * is the one line that changes, and nothing else in the interface has to be found and edited.
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
// Mainnet is first because it is the default. Order here is the order in the nav switcher, and the
// first entry is also the fallback for a network id that does not resolve — so the array order,
// the switcher order and the default were three things that could drift apart, and are now one.
export const NETWORKS: Network[] = [
  { id: 'mainnet', name: CHAINS.mainnet.name, short: 'mainnet', chainId: CHAINS.mainnet.id, explorer: CHAINS.mainnet.blockExplorers.default.url, live: true },
  { id: 'testnet', name: CHAINS.testnet.name, short: 'testnet', chainId: CHAINS.testnet.id, explorer: CHAINS.testnet.blockExplorers.default.url, live: true },
];

/**
 * The network a visitor gets before touching the switcher.
 *
 * Mainnet since 2026-09-03. It was testnet for as long as testnet was the only deployment, and the
 * flip is not cosmetic: the default decides which chain an unmodified wallet prompt is asking about
 * and which addresses every table on the site is showing. Mainnet is the chain where a bond is real
 * money, so it is the one a first-time reader should be looking at — landing on testnet and
 * assuming otherwise is the more expensive mistake of the two.
 *
 * The consequence to expect is empty tables. Nothing has executed on mainnet, so the overview,
 * agents and executions pages open with nothing in them. That is the true state of chain 677 and
 * not a failure to load; the pages say so rather than showing testnet's numbers under a mainnet
 * heading.
 */
export const DEFAULT_NETWORK: NetworkId = 'mainnet';

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
