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
 * These are the FOURTH set, deployed 2026-08-28 16:39Z, first block 21,465,564. They replace the
 * earlier set from the same day (`0x39FF…aA83` registry), which replaced the 2026-08-25 set, which
 * had itself replaced the 2026-08-11 one — and the reason to spell that out here rather than just swap the
 * strings is that each replacement is total. None of these contracts is upgradeable: `registry`,
 * `engine` and `bondToken` are immutable, so a redeploy is always the whole set and every address
 * on this page changes together. Nothing was carried over this time, not even `Halo2Verifier`,
 * which the previous redeploy had reused.
 *
 * Superseded addresses are not deprecated so much as incompatible. The EIP-712 domain includes the
 * verifying contract, so an attestation signed for a previous adapter does not verify at the
 * current one, and there is no window in which two sets both work. Anything still pointing at the
 * 0x39FF…aA83 set — or the 0x0bC0…9142 and 0x7E1A…6914 ones before it — is talking to a different
 * protocol that happens to share a name. That is not hypothetical: this file named the 0x39FF…aA83
 * set for a day after it had been replaced, which is the failure the redeploy checklist in
 * `docs/contract.md` §8 exists to stop.
 *
 * The practical consequence, and the reason this comment keeps growing rather than being trimmed:
 * agents registered against the old registry do not exist here. Their bonds, scores and execution
 * history are still on chain at the old addresses, and this interface will never show them again.
 * Testnet, so nobody is out of pocket — but the leaderboard starting empty is correct, not broken.
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
    AgentRegistry: '0x673D39B8b0Ce8e61EA5fFbf9b3f8E373aE0B5c87',
    ExecutionRouter: '0xE26843C9AD79D67f48f71F865B397f437171ED9A',
    ReputationEngine: '0x9D602eE0ddA3Eff93e11aE56BC3c6273D9edecB6',
    InputAttestor: '0xd14CFe710B9d70d7cb191586CbdeB49347c41CF4',
    SignatureAdapter: '0xF222a82b9C1d59999C3e48B30F6c797c1dab15BF',
    TeeAdapter: '0xEC10Fb66Fb1736C45f2c704497ef0fE0f0754150',
    ZkAdapter: '0x5B63e01298Cfb28ac96C67718daA5788cF934CDf',
    Halo2Verifier: '0x0825Ea3EdfE5961094E63F802D11CCD53098D651',
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
  //
  // It must not be later than the first block of any contract whose logs are read here, and today
  // that is ExecutionRouter alone (activity.ts). The router landed at 21,458,941, nineteen blocks
  // after the registry, so the registry's block covers it. Moving this forward past a queried
  // contract would silently truncate its history rather than fail — the feed would just look
  // emptier than the chain is.
  testnet: 21_458_928n,
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
