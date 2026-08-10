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
 * Both lists are empty, and that is the current truth rather than an oversight. The only
 * deployment artifact in the repository is contracts/deployments/localhost-31337.json — a local
 * devnet. Nothing is deployed to Bohr or to BOT Chain.
 *
 * This file previously listed four testnet addresses under the names RequestManager,
 * ScoreRegistry, ZkAdapter and BondVault. Three of those contracts do not exist in this protocol
 * (the real set is AgentRegistry, ExecutionRouter, InputAttestor, ReputationEngine, the three
 * adapters and the bond token), and the addresses were placeholders for a deployment that had not
 * happened. That is precisely the failure mode the comment above says this table exists to
 * prevent, so the entries are gone rather than corrected: an invented address under a real
 * contract name is worse than no address at all.
 *
 * When a deployment exists, populate this from contracts/deployments/<network>-<chainId>.json and
 * nowhere else.
 */
export const CONTRACTS: Record<NetworkId, Contract[]> = {
  testnet: [],
  mainnet: [],
};
