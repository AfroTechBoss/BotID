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
}

export const NETWORKS: Network[] = [
  { id: 'testnet', name: 'Bohr Testnet', short: 'testnet', chainId: 71_101 },
  { id: 'mainnet', name: 'BOT Chain', short: 'mainnet', chainId: 71_100 },
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
