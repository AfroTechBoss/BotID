'use client';
import { createContext, useContext, useMemo, useState } from 'react';

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
}

// Chain ids come from docs/architecture.md, which records them alongside the bn254 precompile
// probe run against each RPC on 2026-08-09. They were 71101/71100 here, which matched nothing:
// Bohr is 968 at https://rpc.bohr.life and BOT Chain is 677 at https://rpc.botchain.ai. A wrong
// chain id on an interface whose security page exists to answer "is this the real BotID" is not a
// cosmetic error, so it is worth stating where the right ones came from.
// Bohr's explorer is recorded as "not published" in interface/README.md, which was true when that
// table was written and is not any more: scan.bohr.life answers, runs Blockscout, and its
// /api/v2/addresses endpoint returns our AgentRegistry with the right creator. Probed 2026-08-11
// against the deployed address rather than assumed from the hostname pattern — an explorer that
// exists but indexes a different chain would render a "not found" page under a real address, on
// the one page whose job is to prove an address is ours.
export const NETWORKS: Network[] = [
  { id: 'testnet', name: 'Bohr Testnet', short: 'testnet', chainId: 968, explorer: 'https://scan.bohr.life' },
  { id: 'mainnet', name: 'BOT Chain', short: 'mainnet', chainId: 677, explorer: 'https://scan.botchain.ai' },
];

interface NetworkContextValue {
  network: Network;
  setNetwork: (id: NetworkId) => void;
}

// Defaulting to testnet rather than throwing on a missing provider is deliberate: every route
// renders through the root layout, and a component that reads the network should never be the
// reason a page fails to render.
const NetworkContext = createContext<NetworkContextValue>({
  network: NETWORKS[0],
  setNetwork: () => {},
});

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [id, setId] = useState<NetworkId>('testnet');
  const value = useMemo(
    () => ({ network: NETWORKS.find((n) => n.id === id) ?? NETWORKS[0], setNetwork: setId }),
    [id]
  );
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork() {
  return useContext(NetworkContext);
}
