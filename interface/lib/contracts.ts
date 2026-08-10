// Deployment addresses, keyed by network.
//
// No 'use client' directive here, and there must not be one: this is imported by a client
// component today and is the kind of table a server component will want to read the moment any of
// it comes from a real registry. Anything exported from a 'use client' module becomes a client
// reference when the server imports it — the theme cookie name was defined that way once, and
// cookies().get() silently received an undefined key for it. A plain data module cannot fail that
// way. The NetworkId import is type-only, so it is erased at compile time and drags nothing in.
import type { NetworkId } from './network';

export interface Contract {
  name: string;
  /** Truncated for display. The full value belongs in the explorer link, not on screen. */
  address: string;
}

/**
 * An empty list means "nothing deployed on this network", which is a real answer and not a
 * missing one — the page renders it as such rather than falling back to another network's
 * addresses. That fallback is the failure mode worth designing against here: this table is the
 * page's answer to "is this the real BotID", so showing a testnet address under a mainnet heading
 * would be the single most damaging thing it could get wrong.
 *
 * BotID is unaudited and has no mainnet deployment, so mainnet is empty and stays empty until
 * one exists.
 */
export const CONTRACTS: Record<NetworkId, Contract[]> = {
  testnet: [
    { name: 'RequestManager', address: '0x4a91…e02c' },
    { name: 'ScoreRegistry', address: '0x7bd3…119a' },
    { name: 'ZkAdapter', address: '0x9c1e…04f2' },
    { name: 'BondVault', address: '0x2d6f…a877' },
  ],
  mainnet: [],
};
