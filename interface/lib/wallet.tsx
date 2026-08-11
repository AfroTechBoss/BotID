'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createWalletClient, custom, type Address, type WalletClient, type EIP1193Provider } from 'viem';
import { CHAINS } from './chain';
import { useNetwork, type NetworkId } from './network';

/**
 * Injected wallets, discovered rather than assumed.
 *
 * This used to read `window.ethereum` and nothing else, which works right up until the browser has
 * two wallets in it. `window.ethereum` is a single slot on a shared shelf: whichever extension
 * loads last puts its own object there, and some of them wrap the slot in a chooser that throws
 * from inside its own selection prompt. That is the `evmAsk.js … selectExtension` failure — not our
 * code erroring, but two extensions arguing over one property while our code watched the property.
 *
 * EIP-6963 replaces the shelf with a roll call. The page shouts `eip6963:requestProvider`, every
 * installed wallet answers with `eip6963:announceProvider` carrying its own handle, and each one is
 * addressed directly from then on. Nothing is overwritten because nothing is shared.
 *
 * Still no WalletConnect and no connector registry — the surface is a provider, three RPC methods
 * and two events. What changed is that there can now be more than one of them, and the user says
 * which. Everything downstream reads the context rather than the provider, so it is unaffected.
 */
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

/** EIP-6963's announcement payload, narrowed to the fields we use. */
interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

export interface DiscoveredWallet {
  /** Reverse-DNS id, e.g. `io.metamask`. Stable across sessions, which is why it is what we store. */
  rdns: string;
  name: string;
  /** A data URI from the wallet itself, or '' for the legacy fallback entry. */
  icon: string;
  provider: EIP1193Provider;
}

/** The synthetic entry for a wallet too old to announce itself. */
const LEGACY_RDNS = 'legacy.injected';
const STORAGE_KEY = 'botid.wallet.rdns';

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
  /** Every wallet that answered the roll call. Empty until the first client tick. */
  wallets: DiscoveredWallet[];
  /** The one being used, once there is one. Undefined while several are installed and none chosen. */
  activeWallet: DiscoveredWallet | undefined;
  /** Pass an rdns to pick a specific wallet; omit it when there is only one to pick. */
  connect: (rdns?: string) => Promise<void>;
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
  wallets: [],
  activeWallet: undefined,
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
  // no wallets — and the truth arrives one tick later.
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [chosenRdns, setChosenRdns] = useState<string>();

  // --- discovery ---------------------------------------------------------------------------
  useEffect(() => {
    setChosenRdns(localStorage.getItem(STORAGE_KEY) ?? undefined);

    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.info?.rdns || !detail.provider) return;
      setWallets((prev) => {
        // A wallet may announce more than once — on its own initiative and again in reply to our
        // request. Keyed by rdns so the list stays one entry per wallet either way. And a real
        // announcement retires the legacy guess: it is the same extension, better identified.
        const kept = prev.filter((w) => w.rdns !== detail.info.rdns && w.rdns !== LEGACY_RDNS);
        return [...kept, { rdns: detail.info.rdns, name: detail.info.name, icon: detail.info.icon, provider: detail.provider }];
      });
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // Wallets answer the roll call synchronously in practice, so anything still silent after a
    // beat predates the standard. Falling back to `window.ethereum` then keeps older wallets
    // working; doing it immediately instead would list the same wallet twice for a beat.
    const timer = setTimeout(() => {
      setWallets((prev) => {
        if (prev.length > 0 || !window.ethereum) return prev;
        return [{ rdns: LEGACY_RDNS, name: 'Browser wallet', icon: '', provider: window.ethereum }];
      });
    }, 300);

    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      clearTimeout(timer);
    };
  }, []);

  // The stored choice wins. Failing that, one installed wallet needs no choosing — it is only when
  // several are present and none has been picked that this stays undefined and the button asks.
  const activeWallet = useMemo(() => {
    const stored = chosenRdns ? wallets.find((w) => w.rdns === chosenRdns) : undefined;
    return stored ?? (wallets.length === 1 ? wallets[0] : undefined);
  }, [wallets, chosenRdns]);

  // --- the active wallet's account and chain -----------------------------------------------
  useEffect(() => {
    const eth = activeWallet?.provider;
    if (!eth) return;

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
  }, [activeWallet]);

  const connect = useCallback(
    async (rdns?: string) => {
      const target = rdns ? wallets.find((w) => w.rdns === rdns) : activeWallet;
      if (!target) {
        setError(
          wallets.length === 0
            ? 'No wallet found. Install a browser wallet, then reload.'
            : 'Choose which wallet to connect.'
        );
        return;
      }
      setConnecting(true);
      setError(undefined);
      try {
        const accts = (await target.provider.request({ method: 'eth_requestAccounts' })) as Address[];
        setAddress(accts[0]);
        setWalletChainId(Number(await target.provider.request({ method: 'eth_chainId' })));
        // Remembered only once a wallet has actually authorised us. Storing the choice on click
        // would pin the tab to a wallet the user then cancelled out of.
        setChosenRdns(target.rdns);
        localStorage.setItem(STORAGE_KEY, target.rdns);
      } catch (e) {
        setError(walletMessage(e));
      } finally {
        setConnecting(false);
      }
    },
    [wallets, activeWallet]
  );

  // Local only, and labelled as such wherever it is offered. EIP-1193 has no "log out": the site
  // keeps its permission until revoked in the wallet, so this forgets the account for the tab and
  // nothing more. Calling it a disconnect without saying that would overstate what happened.
  // The remembered wallet goes too, so the next connect can land on a different one.
  const disconnect = useCallback(() => {
    setAddress(undefined);
    setError(undefined);
    setWalletChainId(undefined);
    setChosenRdns(undefined);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const switchToSelected = useCallback(async () => {
    const eth = activeWallet?.provider;
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
  }, [network.id, activeWallet]);

  const walletClient = useMemo(() => {
    if (!address || !activeWallet) return undefined;
    return createWalletClient({
      account: address,
      chain: CHAINS[network.id],
      // The chosen wallet's own handle, not window.ethereum. With two wallets installed those are
      // different objects, and signing through the wrong one is how a transaction gets sent from
      // an account the page is not showing.
      transport: custom(activeWallet.provider),
    });
  }, [address, network.id, activeWallet]);

  const value = useMemo<WalletState>(
    () => ({
      address,
      walletChainId,
      onSelectedChain: walletChainId === network.chainId,
      connecting,
      error,
      hasProvider: wallets.length > 0,
      wallets,
      activeWallet,
      connect,
      disconnect,
      switchToSelected,
      walletClient,
    }),
    [address, walletChainId, network.chainId, connecting, error, wallets, activeWallet, connect, disconnect, switchToSelected, walletClient]
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
