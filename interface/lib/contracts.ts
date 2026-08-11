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
  /**
   * True for addresses BotID depends on but did not deploy. Only the bond token, today.
   *
   * It exists because the alternative is worse than untidy. Before any BotID deployment both
   * networks still listed USDT, so the table was never empty, so the "nothing is deployed here"
   * notice below it was unreachable code — and mainnet rendered one row under the heading
   * "Deployed on BOT Chain". A reader checking whether BotID is live on mainnet would have been
   * shown a table saying yes. The flag lets the table count what BotID actually deployed.
   */
  dependency?: boolean;
}

/**
 * An empty list means "nothing deployed on this network", which is a real answer and not a
 * missing one — the page renders it as such rather than falling back to another network's
 * addresses. That fallback is the failure mode worth designing against here: this table is the
 * page's answer to "is this the real BotID", so showing a testnet address under a mainnet heading
 * would be the single most damaging thing it could get wrong.
 *
 * Testnet is now populated. Every address below is transcribed from
 * contracts/deployments/bohr-968.json — the manifest the deploy script wrote — and each was then
 * read back off-chain before being listed: registry.router points at the router, each tier's
 * adapter is bound, and the Gold verifier is the one the manifest names. A manifest records what
 * the deploy *sent*; these are what stuck.
 *
 * Mainnet remains empty, and that is the current truth rather than an oversight. Nothing of ours
 * is deployed to BOT Chain.
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
  // Ordered as a reader checks them, not as the deploy script emits them: the two contracts that
  // hold or move money first, then what they depend on, then the adapters. Halo2Verifier is
  // included even though nobody calls it directly — it is the thing a Gold proof is checked
  // against, so "which verifier" is exactly the question this table should be able to answer.
  testnet: [
    { name: 'AgentRegistry', address: '0x7E1A468Fc20E1d3EE11953eE46EF0572d3B26914' },
    { name: 'ExecutionRouter', address: '0x0D56ca1b8D5FDE1F8b116f051cFaEa199E367416' },
    { name: 'ReputationEngine', address: '0x5BACDa942BD8523a41E1815cE97484be68252597' },
    { name: 'InputAttestor', address: '0xA7c37d4E197A12A2de6753b3D53FE698C39fAc8B' },
    { name: 'SignatureAdapter (Bronze)', address: '0x91188177F461E63d668d74fa80b4be77ecea0FB0' },
    { name: 'TeeAdapter (Silver)', address: '0x18493523A37831a9bFacBC99F3C3932368592fa5' },
    { name: 'ZkAdapter (Gold)', address: '0x43bbB50D02567005B7dD6F147E0D96b80a8409B9' },
    { name: 'Halo2Verifier', address: '0x4A29F6F49Ef8c7ff6CbC8879659b5C79ADa154b7' },
    { name: 'USDT (bond token)', address: '0x75edC9335175Fc0552D51D48439F229c10420fe3', dependency: true },
  ],
  mainnet: [{ name: 'USDT (bond token)', address: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C', dependency: true }],
};
