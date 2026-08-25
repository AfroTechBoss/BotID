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
 * These are the SECOND set. The 2026-08-11 deployment was replaced on 2026-08-25 because the
 * security remediation changed the bytecode of six of the eight contracts, and none of them is
 * upgradeable — `registry`, `engine` and `bondToken` are immutable, so there was no way to swap
 * one contract and keep the rest. The old addresses are not deprecated so much as incompatible:
 * the signing domain changed with the EIP-712 envelope, so nothing signed for the old adapters
 * verifies against the new ones. Anything still pointing at the 0x7E1A…6914 set is talking to a
 * different protocol that happens to share a name.
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
/**
 * The addresses themselves, keyed for calling rather than for reading. This is the source; the
 * display table below is derived from it.
 *
 * Two consumers, one list, deliberately. The security table answers "is this the real BotID" and
 * the contract calls answer "where do I send this transaction" — and if those two ever disagreed,
 * the table would be vouching for an address the app does not use, which is worse than either
 * being wrong alone. Deriving one from the other makes that disagreement unrepresentable.
 *
 * `undefined` is a meaningful value here and is why the type is Partial: it means "not deployed on
 * this network", which every caller must handle. A zero-address placeholder would type-check and
 * then send transactions into the void.
 */
export const ADDRESSES = {
  testnet: {
    AgentRegistry: '0x0bC0F2dd3337004d7Adef8364Fd9Ff33B3959142',
    ExecutionRouter: '0xd5AdD347ac5498199A3cdAaeb31d0fFD9Fc2b717',
    ReputationEngine: '0xDF0E2D20E1Da72AcfaE834595631Fc0AF92C7bD4',
    InputAttestor: '0x1F3EEbA18DD9D0FD84a5456E1D6F7394E4d07dc0',
    SignatureAdapter: '0xf4dFcFb1cAE608b40F5a1F88CdEA0DAAdfF615AA',
    TeeAdapter: '0xde2F8d5002c6d9f5249C393a10e27A3d8a8bFfD5',
    ZkAdapter: '0x83Aa1c78bAdDdCF9Deb960fC3Cf7c1c3b946d1E3',
    Halo2Verifier: '0x4A29F6F49Ef8c7ff6CbC8879659b5C79ADa154b7',
    bondToken: '0x75edC9335175Fc0552D51D48439F229c10420fe3',
  },
  mainnet: {
    bondToken: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C',
  },
} as const satisfies Record<NetworkId, Partial<Record<ContractName, `0x${string}`>>>;

/**
 * Block the protocol was deployed at, per network. Log queries start here.
 *
 * Not an optimisation. A public RPC will refuse an unbounded `eth_getLogs`, and "from genesis" on a
 * chain producing a block every 0.75s is 19 million blocks of nothing — the protocol cannot have
 * emitted an event before it existed. Undefined where nothing is deployed, so a caller cannot
 * accidentally scan a chain we are not on.
 */
export const DEPLOY_BLOCK: Partial<Record<NetworkId, bigint>> = {
  // First block in which AgentRegistry has code, found by bisecting eth_getCode rather than
  // copied from a receipt — the manifest does not record creation transactions.
  testnet: 21_141_227n,
};

export type ContractName =
  | 'AgentRegistry'
  | 'ExecutionRouter'
  | 'ReputationEngine'
  | 'InputAttestor'
  | 'SignatureAdapter'
  | 'TeeAdapter'
  | 'ZkAdapter'
  | 'Halo2Verifier'
  | 'bondToken';

/** Address of `name` on `network`, or undefined where it is not deployed. */
export function addressOf(network: NetworkId, name: ContractName): `0x${string}` | undefined {
  return (ADDRESSES[network] as Partial<Record<ContractName, `0x${string}`>>)[name];
}

// How each address is labelled in the security table. Ordered as a reader checks them, not as the
// deploy script emits them: the two contracts that hold or move money first, then what they depend
// on, then the adapters. Halo2Verifier is listed even though nobody calls it directly — it is what
// a Gold proof is checked against, so "which verifier" is exactly a question that table should
// answer. Anything absent from this list is absent from the table, which is why it is exhaustive
// over ContractName rather than a lookup with a fallback.
const DISPLAY: { name: ContractName; label: string; dependency?: boolean }[] = [
  { name: 'AgentRegistry', label: 'AgentRegistry' },
  { name: 'ExecutionRouter', label: 'ExecutionRouter' },
  { name: 'ReputationEngine', label: 'ReputationEngine' },
  { name: 'InputAttestor', label: 'InputAttestor' },
  { name: 'SignatureAdapter', label: 'SignatureAdapter (Bronze)' },
  { name: 'TeeAdapter', label: 'TeeAdapter (Silver)' },
  { name: 'ZkAdapter', label: 'ZkAdapter (Gold)' },
  { name: 'Halo2Verifier', label: 'Halo2Verifier' },
  { name: 'bondToken', label: 'USDT (bond token)', dependency: true },
];

export const CONTRACTS: Record<NetworkId, Contract[]> = {
  testnet: rows('testnet'),
  mainnet: rows('mainnet'),
};

function rows(network: NetworkId): Contract[] {
  return DISPLAY.flatMap(({ name, label, dependency }) => {
    const address = addressOf(network, name);
    return address ? [{ name: label, address, dependency }] : [];
  });
}
