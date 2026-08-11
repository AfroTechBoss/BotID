'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createWalletClient, custom, type Address, type WalletClient, type EIP1193Provider } from 'viem';
import { CHAINS } from './chain';
import { useNetwork, type NetworkId } from './network';

/**
 * The injected provider, and only the injected provider.
 *
 * No WalletConnect, no connector registry, no modal. One connector means the entire surface is
 * `window.ethereum`, three RPC methods and two events — which is a file this size. Adding a second
 * connector later is a change to this module and nothing else, because everything downstream reads
 * the context rather than the provider.
 */
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

interface WalletState {
  address: Address | undefined;
  /** The chain the *wallet* is on, which is not necessarily the one the nav is showing. */
  walletChainId: number | undefined;
  /** True when the wallet's chain matches the selected network. Every write must check this. */
  onSelectedChain: boolean;
  connecting: boolean;
  /** Set when a connect or switch attempt failed, for display. Cleared on the next attempt. */
  error: string | undefined;
  hasProvider: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchToSelected: () => Promise<void>;
  /** A client bound to the connected account, or undefined when not connected. */
  walletClient: WalletClient | undefined;
}

const WalletContext = createContext<WalletState>({
  address: undefined,
  walletChainId: undefined,
  onSelectedChain: false,
  connecting: false,
  error: undefined,
  hasProvider: false,
  connect: async () => {},
  disconnect: () => {},
  switchToSelected: async () => {},
  walletClient: undefined,
});

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { network } = useNetwork();
  const [address, setAddress] = useState<Address>();
  const [walletChainId, setWalletChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  // Resolved in an effect rather than read during render: `window` does not exist on the server,
  // and a value that differs between the server render and the first client render is exactly what
  // makes React throw away the server HTML. So the first client render agrees with the server —
  // no provider — and the truth arrives one tick later.
  const [hasProvider, setHasProvider] = useState(false);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    setHasProvider(true);

    // Reconnect silently if the wallet already has this site authorised. eth_accounts, not
    // eth_requestAccounts: the former reports existing permission, the latter *asks*, and a page
    // that pops a wallet prompt on load is a page people close.
    eth.request({ method: 'eth_accounts' })
      .then((accts) => setAddress((accts as Address[])[0]))
      .catch(() => {});
    eth.request({ method: 'eth_chainId' })
      .then((id) => setWalletChainId(Number(id)))
      .catch(() => {});

    const onAccounts = (accts: unknown) => setAddress((accts as Address[])[0]);
    // The wallet reports the chain it switched to; trusting our own request instead would leave
    // the UI wrong whenever the user switches network in the wallet rather than in our nav.
    const onChain = (id: unknown) => setWalletChainId(Number(id));
    eth.on('accountsChanged', onAccounts);
    eth.on('chainChanged', onChain);
    return () => {
      eth.removeListener('accountsChanged', onAccounts);
      eth.removeListener('chainChanged', onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) {
      setError('No wallet found. Install a browser wallet, then reload.');
      return;
    }
    setConnecting(true);
    setError(undefined);
    try {
      const accts = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
      setAddress(accts[0]);
      setWalletChainId(Number(await eth.request({ method: 'eth_chainId' })));
    } catch (e) {
      setError(walletMessage(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  // Local only, and labelled as such wherever it is offered. EIP-1193 has no "log out": the site
  // keeps its permission until revoked in the wallet, so this forgets the account for the tab and
  // nothing more. Calling it a disconnect without saying that would overstate what happened.
  const disconnect = useCallback(() => {
    setAddress(undefined);
    setError(undefined);
  }, []);

  const switchToSelected = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    const chain = CHAINS[network.id];
    setError(undefined);
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chain.id.toString(16)}` }],
      });
    } catch (e) {
      // 4902 is "wallet does not know this chain". Bohr is not in any wallet's default list, so
      // this is the normal path rather than an error, and the fix is to offer to add it.
      if (isUnknownChain(e)) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: `0x${chain.id.toString(16)}`,
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: [chain.rpcUrls.default.http[0]],
                blockExplorerUrls: [chain.blockExplorers.default.url],
              },
            ],
          });
        } catch (addErr) {
          setError(walletMessage(addErr));
        }
      } else {
        setError(walletMessage(e));
      }
    }
  }, [network.id]);

  const walletClient = useMemo(() => {
    if (!address || typeof window === 'undefined' || !window.ethereum) return undefined;
    return createWalletClient({
      account: address,
      chain: CHAINS[network.id],
      transport: custom(window.ethereum),
    });
  }, [address, network.id]);

  const value = useMemo<WalletState>(
    () => ({
      address,
      walletChainId,
      onSelectedChain: walletChainId === network.chainId,
      connecting,
      error,
      hasProvider,
      connect,
      disconnect,
      switchToSelected,
      walletClient,
    }),
    [address, walletChainId, network.chainId, connecting, error, hasProvider, connect, disconnect, switchToSelected, walletClient]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  return useContext(WalletContext);
}

/** Truncated for display. Wide enough that two addresses do not collide by accident. */
export function shortAddress(a: Address | string, lead = 6, tail = 4) {
  return `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

function isUnknownChain(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  // MetaMask returns 4902 at the top level; some wallets nest the original under `data`.
  return code === 4902 || (e as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code === 4902;
}

/**
 * Wallet errors are long, and the useful sentence is rarely the first one. 4001 in particular is
 * not a failure at all — the user declined — and showing a red stack trace for it teaches people
 * to distrust the ones that matter.
 */
export function walletMessage(e: unknown): string {
  const code = (e as { code?: number })?.code;
  if (code === 4001) return 'Rejected in the wallet.';
  const short = (e as { shortMessage?: string })?.shortMessage;
  if (short) return short;
  const msg = (e as { message?: string })?.message;
  return msg ? msg.split('\n')[0] : 'Something went wrong in the wallet.';
}

/** Which network a chain id belongs to, or undefined if it is neither of ours. */
export function networkOf(chainId: number | undefined): NetworkId | undefined {
  if (chainId === CHAINS.testnet.id) return 'testnet';
  if (chainId === CHAINS.mainnet.id) return 'mainnet';
  return undefined;
}
