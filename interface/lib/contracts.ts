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
 * Every BotID contract is still absent, and that is the current truth rather than an oversight.
 * The only deployment artifact in the repository is contracts/deployments/localhost-31337.json —
 * a local devnet whose addresses belong to a Hardhat node that no longer exists. Nothing of ours
 * is deployed to Bohr or to BOT Chain.
 *
 * The bond token is the exception, and it is a principled one: it is a pre-existing dependency
 * rather than something BotID deploys, so its address is knowable before any deployment happens.
 * Both entries were verified by calling symbol() and decimals() against each chain's own RPC.
 *
 * They are listed per network because the two addresses are a trap, not a convenience. Bohr's
 * USDT lives at 0x75edC933…20fe3; BOT Chain's lives at 0xaBabc7Dd…87a3C. Cross them and the
 * mainnet address does not simply fail on Bohr — it resolves to WES, a live and unrelated
 * 18-decimal token. A deploy pointed there reads decimals() as 18 and scales every capital
 * parameter by a trillion, with nothing reverting. Hence: no shared default, anywhere.
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
  testnet: [{ name: 'USDT (bond token)', address: '0x75edC9335175Fc0552D51D48439F229c10420fe3' }],
  mainnet: [{ name: 'USDT (bond token)', address: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C' }],
};
