'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { erc20Abi, parseUnits, isAddress, isHex, type Address, type Hash } from 'viem';
import { agentRegistryAbi } from '@abi/AgentRegistry';
import { executionRouterAbi } from '@abi/ExecutionRouter';
import { formatToken, applyBps } from '@/lib/token';
import { useNetwork } from '@/lib/network';
import { useWallet, shortAddress } from '@/lib/wallet';
import { useTx } from '@/lib/tx';
import { CHAINS, explorerLink } from '@/lib/chain';
import { addressOf } from '@/lib/contracts';
import {
  agentIdsOf,
  readAgent,
  readBondToken,
  readLimits,
  registryAddress,
  keccak256,
  toHex,
  TIER_VALUE,
  type AgentView,
  type TierName,
} from '@/lib/registry';
import TxStatus from '@/components/TxStatus';

// Mirrors AgentRegistry. This panel used to read `{ bronze: 2.5, silver: 4.2, gold: 6 }[tier]`,
// which made leverage look like a property of the tier — it is not, and the error flattered the
// form badly: it promised a new Silver agent 4.2x when the contract gives it 1.0x.
//
// Leverage is a step function of *score*; tier only multiplies it. A registering agent has no
// history, so it starts at NEUTRAL and gets the second band. Keeping the two functions separate
// here, with the contract's bps units intact, is deliberate: the next person to compare this
// against AgentRegistry.sol should be able to do it line by line.
const NEUTRAL_SCORE = 5_000;

function leverageBps(score: number): number {
  if (score < 5_000) return 5_000; // 0.5x — below neutral, undercollateralised is off
  if (score < 7_000) return 10_000; // 1.0x
  if (score < 8_500) return 20_000; // 2.0x
  if (score < 9_500) return 40_000; // 4.0x
  return 60_000; // 6.0x — the cap
}

const TIER_FACTOR_BPS: Record<TierName, number> = { bronze: 5_000, silver: 10_000, gold: 15_000 };
const TIER_NAME = ['None', 'Bronze', 'Silver', 'Gold'];

/**
 * bond × leverage(score) × tierFactor(tier), zero below minBond, clamped to the global cap.
 *
 * Base units in and base units out, with the two bps factors applied one at a time in integer
 * space. The previous version of this took whole tokens as a JS number and divided by 1e8, which
 * worked only because the numbers were fixtures — the moment the bond comes off the chain it is a
 * six-decimal bigint and that arithmetic is a rounding error waiting for a big enough bond.
 *
 * This is a *preview* for a bond that does not exist yet. For an agent that does exist the page
 * shows profile.maxOpenNotional instead: the contract's own answer beats our copy of its formula.
 */
function previewNotional(bond: bigint, score: number, tier: TierName, minBond: bigint, cap: bigint): bigint {
  if (bond < minBond) return 0n; // below the floor the answer is zero, not a small number
  const notional = applyBps(applyBps(bond, leverageBps(score)), TIER_FACTOR_BPS[tier]);
  // A zero cap means "not read yet", not "no credit for anyone". Clamping to it showed every
  // prospective bond a credit line of zero for the second before the limits arrived, which reads
  // as a refusal rather than as a loading state.
  return cap > 0n && notional > cap ? cap : notional;
}

const multiple = (score: number, tier: TierName) => (leverageBps(score) * TIER_FACTOR_BPS[tier]) / 1e8;

// Rendered twice — once as track segments, once as labels — so it lives here rather than inline.
const UNBONDING_STEPS = ['Requested', 'Day 7', 'Day 14', 'Day 21 — withdrawable'] as const;

export default function Portal() {
  const { network } = useNetwork();
  const { address, onSelectedChain, walletClient, connect, connecting, switchToSelected, hasProvider } = useWallet();
  const tx = useTx();

  const registry = registryAddress(network.id);
  const bondTokenAddress = addressOf(network.id, 'bondToken');
  const router = addressOf(network.id, 'ExecutionRouter');

  // ── chain state ───────────────────────────────────────────────────────────────────────────
  const [limits, setLimits] = useState<Awaited<ReturnType<typeof readLimits>>>();
  const [token, setToken] = useState<Awaited<ReturnType<typeof readBondToken>>>();
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selectedId, setSelectedId] = useState<bigint>();
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string>();

  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? 'USDT';
  const money = useCallback((v: bigint) => formatToken(v, { decimals, symbol, compact: false }), [decimals, symbol]);

  // Limits are public and do not need a wallet, so they load on their own. Splitting the two
  // effects is what lets the credit preview be correct before anyone connects — a visitor sizing a
  // bond is asking a question about the protocol, not about their account.
  useEffect(() => {
    let live = true;
    setLimits(undefined);
    readLimits(network.id)
      .then((l) => live && setLimits(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network.id]);

  const refresh = useCallback(async () => {
    if (!address || !registry) {
      setAgents([]);
      setToken(undefined);
      return;
    }
    setLoading(true);
    setReadError(undefined);
    try {
      const t = await readBondToken(network.id, address);
      setToken(t);
      const ids = await agentIdsOf(network.id, address);
      const views = (await Promise.all(ids.map((id) => readAgent(network.id, id)))).filter(
        (a): a is AgentView => a !== undefined
      );
      setAgents(views);
      // Keep the current selection if it survived the refresh; otherwise take the first. Resetting
      // unconditionally would jump the panel back to agent #1 after every deposit.
      setSelectedId((prev) => (prev !== undefined && views.some((v) => v.agentId === prev) ? prev : views[0]?.agentId));
    } catch (e) {
      setReadError(e instanceof Error ? e.message.split('\n')[0] : 'Could not read the chain.');
    } finally {
      setLoading(false);
    }
  }, [address, network.id, registry]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = agents.find((a) => a.agentId === selectedId);

  // ── register form ─────────────────────────────────────────────────────────────────────────
  const [operator, setOperator] = useState('');
  const [commitment, setCommitment] = useState('');
  const [tier, setTier] = useState<TierName>('silver');
  const [lossTolerance, setLossTolerance] = useState('500');
  const [bondInput, setBondInput] = useState('100');

  const bondAmount = useMemo(() => parseAmount(bondInput, decimals), [bondInput, decimals]);
  const minBond = limits?.minBond ?? 0n;
  const cap = limits?.globalNotionalCap ?? 0n;
  const credit = bondAmount === undefined ? 0n : previewNotional(bondAmount, NEUTRAL_SCORE, tier, minBond, cap);
  const best = bondAmount === undefined ? 0n : previewNotional(bondAmount, 10_000, tier, minBond, cap);

  // A commitment is 32 bytes. Anything else typed in the field is treated as a label and hashed,
  // which is the only way a testnet registration does not require going and finding a hashing tool.
  const commitmentHex = useMemo<`0x${string}` | undefined>(() => {
    const v = commitment.trim();
    if (!v) return undefined;
    if (isHex(v) && v.length === 66) return v;
    return keccak256(toHex(v));
  }, [commitment]);

  const registerProblem = (() => {
    if (!registry) return `BotID is not deployed on ${network.name}.`;
    if (!isAddress(operator.trim())) return 'Operator must be an address.';
    if (!commitmentHex) return 'Model commitment is required.';
    const bps = Number(lossTolerance);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) return 'Loss tolerance is 0–10,000 bps.';
    if (bondAmount === undefined) return 'Bond amount is not a number.';
    if (bondAmount < minBond) return `Bond is below the ${money(minBond)} minimum.`;
    if (token && bondAmount > token.balance) return `You hold ${money(token.balance)}.`;
    return undefined;
  })();

  /**
   * approve → registerAgent, as two steps of one flow.
   *
   * The approve is conditional on the allowance, not unconditional, and it approves exactly the
   * bond rather than the usual infinite amount. An unlimited approval to a contract that can pull
   * on `increaseBond` is a standing permission over the whole balance for the sake of saving one
   * signature later; the registry only ever pulls what it was just told to.
   */
  const register = async () => {
    if (!walletClient || !address || !registry || !token || bondAmount === undefined || !commitmentHex) return;
    const ok = await tx.run([
      {
        label: `Approve ${money(bondAmount)}`,
        send: async () =>
          token.allowance >= bondAmount
            ? undefined
            : walletClient.writeContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'approve',
                args: [registry, bondAmount],
                account: address,
                chain: CHAINS[network.id],
              }),
      },
      {
        label: 'Register agent',
        send: () =>
          walletClient.writeContract({
            address: registry,
            abi: agentRegistryAbi,
            functionName: 'registerAgent',
            args: [operator.trim() as Address, commitmentHex, TIER_VALUE[tier], Number(lossTolerance), bondAmount],
            account: address,
            chain: CHAINS[network.id],
          }) as Promise<Hash>,
      },
    ]);
    if (ok) await refresh();
  };

  // ── bond management ───────────────────────────────────────────────────────────────────────
  const [depositInput, setDepositInput] = useState('');
  const [unbondInput, setUnbondInput] = useState('');
  const [requestId, setRequestId] = useState('');

  const depositAmount = parseAmount(depositInput, decimals);
  const unbondAmount = parseAmount(unbondInput, decimals);

  const deposit = async () => {
    if (!walletClient || !address || !registry || !token || !selected || !depositAmount) return;
    const ok = await tx.run([
      {
        label: `Approve ${money(depositAmount)}`,
        send: async () =>
          token.allowance >= depositAmount
            ? undefined
            : walletClient.writeContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'approve',
                args: [registry, depositAmount],
                account: address,
                chain: CHAINS[network.id],
              }),
      },
      {
        label: 'Increase bond',
        send: () =>
          walletClient.writeContract({
            address: registry,
            abi: agentRegistryAbi,
            functionName: 'increaseBond',
            args: [selected.agentId, depositAmount],
            account: address,
            chain: CHAINS[network.id],
          }) as Promise<Hash>,
      },
    ]);
    if (ok) {
      setDepositInput('');
      await refresh();
    }
  };

  /** One registry write with no approval in front of it — everything except the two deposits. */
  const registryWrite = async (label: string, send: () => Promise<Hash>) => {
    const ok = await tx.run([{ label, send }]);
    if (ok) await refresh();
    return ok;
  };

  const now = BigInt(Math.floor(Date.now() / 1000));
  const withdrawable = selected !== undefined && selected.unbondingAmount > 0n && selected.unbondingAt <= now;

  const busy = tx.busy || loading;
  const canWrite = Boolean(walletClient && onSelectedChain && registry);

  return (
    <main style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <ChainBanner />

      {/* 340px floor: the register panel's segmented tier control and its credit-line readout are
          the widest things here, and they start wrapping below that. min(340px, 100%) because a
          bare 340px is a floor the track holds even when the container is narrower than it — on a
          320px phone that made every column 340px wide and the page scrolled sideways. Below the
          floor there is no second column to protect anyway, so yielding costs nothing. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: 'var(--space-8)', alignItems: 'start' }}>
        <section>
          <h2 style={{ fontSize: 20 }}>Register an agent</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            <div className="field">
              <label>Operator address</label>
              <input className="input" placeholder="0x…" value={operator} onChange={(e) => setOperator(e.target.value)} spellCheck={false} />
              <span className="text-muted" style={{ fontSize: 11 }}>
                The key that signs deliveries. It can be this wallet, but it does not have to be — and on a
                machine that runs unattended it should not be.
              </span>
            </div>
            <div className="field">
              <label>Model commitment</label>
              <input className="input" placeholder="0x… or a label to hash" value={commitment} onChange={(e) => setCommitment(e.target.value)} spellCheck={false} />
              <span className="text-muted" style={{ fontSize: 11 }}>
                {commitmentHex && commitmentHex !== commitment.trim()
                  ? `Hashed to ${shortAddress(commitmentHex, 10, 8)}.`
                  : 'A real commitment is weightsHash ‖ vkHash ‖ declared limits, produced where the model is built. Type a label here and it is hashed for you — fine on testnet, not a substitute.'}
              </span>
            </div>
            <div className="field">
              <label>Tier</label>
              <span className="seg">
                {(['bronze', 'silver', 'gold'] as const).map((t) => (
                  <label key={t} className="seg-opt">
                    <input type="radio" checked={tier === t} onChange={() => setTier(t)} />
                    {t[0].toUpperCase() + t.slice(1)}
                  </label>
                ))}
              </span>
            </div>
            <div className="field">
              <label>Loss tolerance (bps)</label>
              <input className="input" type="number" value={lossTolerance} onChange={(e) => setLossTolerance(e.target.value)} />
            </div>
            <div className="field">
              <label>Bond ({symbol})</label>
              <input className="input" value={bondInput} onChange={(e) => setBondInput(e.target.value)} inputMode="decimal" />
              <span className="text-muted" style={{ fontSize: 11 }}>
                Minimum {limits ? money(limits.minBond) : '…'}
                {token ? ` · you hold ${money(token.balance)}` : ''}
              </span>
            </div>
            {/* Labelled with the score it is computed at. An unlabelled credit line is how the old
                tier-keyed number passed unnoticed — it looked like a fact about the tier. */}
            <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <span className="text-muted">credit line at registration</span>
                <span style={{ fontWeight: 700 }}>{money(credit)} max open notional</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', fontSize: 12 }}>
                <span className="text-muted">score 5,000 (neutral) × {tier}</span>
                <span className="text-muted">{multiple(NEUTRAL_SCORE, tier)}× bond</span>
              </div>
            </div>
            <p style={{ fontSize: 12, margin: 0 }} className="text-muted">
              Leverage is a step function of score; the tier only multiplies it. A new agent starts at
              5,000 with no history either way, so this is the floor rather than the number you keep.
              Earn a score of 9,500 or above and this tier reaches {multiple(10_000, tier)}× —{' '}
              {money(best)}
              {best === cap && cap > 0n ? ', at the global cap' : ''}. See <a href="/docs#credit">the credit table</a>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--score-critical)' }}>
              Unbonding takes 21 days once requested — or {limits ? (limits.earlyExitPenaltyBps / 100).toFixed(0) : '10'}% of the
              amount to leave sooner, once nothing is outstanding. Read this before you post capital, not after.
            </p>
            <button className="btn btn-primary btn-block" disabled={!canWrite || busy || Boolean(registerProblem)} onClick={register}>
              {tx.busy ? 'Working…' : 'Register agent'}
            </button>
            <TxStatus state={tx} idleHint={canWrite ? registerProblem : undefined} />
          </div>
        </section>

        {/* The .hr rules that used to sit between these sections are gone: a horizontal rule
            separates things stacked vertically, and these are now side by side. The grid gap
            does that job. */}
        <section>
          <h2 style={{ fontSize: 20 }}>Bond management</h2>

          {!address ? (
            <p style={{ fontSize: 13 }} className="text-muted">Connect a wallet to see the agents it owns.</p>
          ) : loading && agents.length === 0 ? (
            <p style={{ fontSize: 13 }} className="text-muted">Reading the chain…</p>
          ) : readError ? (
            <p style={{ fontSize: 13, color: 'var(--score-critical)' }}>{readError}</p>
          ) : agents.length === 0 ? (
            <p style={{ fontSize: 13 }} className="text-muted">
              This wallet owns no agents on {network.name}. Register one on the left and it appears here.
            </p>
          ) : (
            <>
              {agents.length > 1 && (
                <div className="field" style={{ marginTop: 'var(--space-3)' }}>
                  <label>Agent</label>
                  <select className="input" value={String(selectedId)} onChange={(e) => setSelectedId(BigInt(e.target.value))}>
                    {agents.map((a) => (
                      <option key={String(a.agentId)} value={String(a.agentId)}>
                        #{String(a.agentId)} — {TIER_NAME[a.tier]} — {money(a.bond)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {selected && <AgentFacts agent={selected} money={money} network={network.id} />}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
                <div className="field">
                  <label>Deposit ({symbol})</label>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <input className="input" value={depositInput} onChange={(e) => setDepositInput(e.target.value)} inputMode="decimal" placeholder="0.00" style={{ flex: 1 }} />
                    <button className="btn btn-secondary" disabled={!canWrite || busy || !depositAmount} onClick={deposit}>
                      Deposit
                    </button>
                  </div>
                </div>

                <div className="field">
                  <label>Request unbond ({symbol})</label>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <input className="input" value={unbondInput} onChange={(e) => setUnbondInput(e.target.value)} inputMode="decimal" placeholder="0.00" style={{ flex: 1 }} />
                    <button
                      className="btn btn-secondary"
                      disabled={!canWrite || busy || !unbondAmount || !selected}
                      onClick={async () => {
                        if (!walletClient || !address || !registry || !selected || !unbondAmount) return;
                        const ok = await registryWrite('Request unbond', () =>
                          walletClient.writeContract({
                            address: registry,
                            abi: agentRegistryAbi,
                            functionName: 'startUnbonding',
                            args: [selected.agentId, unbondAmount],
                            account: address,
                            chain: CHAINS[network.id],
                          }) as Promise<Hash>
                        );
                        if (ok) setUnbondInput('');
                      }}
                    >
                      Request
                    </button>
                  </div>
                  <span className="text-muted" style={{ fontSize: 11 }}>
                    Reverts if the remaining bond would no longer cover open exposure — the contract checks the
                    credit line, not the balance.
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-secondary"
                    disabled={!canWrite || busy || !withdrawable}
                    onClick={() => {
                      if (!walletClient || !address || !registry || !selected) return;
                      void registryWrite('Withdraw', () =>
                        walletClient.writeContract({
                          address: registry,
                          abi: agentRegistryAbi,
                          functionName: 'withdraw',
                          args: [selected.agentId],
                          account: address,
                          chain: CHAINS[network.id],
                        }) as Promise<Hash>
                      );
                    }}
                  >
                    Withdraw
                  </button>
                  {/* Priced separately from Withdraw rather than folded into it as a confirm step. The
                      two buttons return different amounts of money, and a control that silently takes a
                      tenth of the bond depending on the block timestamp is the kind of thing an operator
                      should have had to aim at. The disabled state is previewWithdrawEarly().allowed
                      rather than a gate recomputed here — the contract already answers it. */}
                  <button
                    className="btn btn-secondary"
                    disabled={!canWrite || busy || !selected?.earlyExit.allowed}
                    onClick={() => {
                      if (!walletClient || !address || !registry || !selected) return;
                      void registryWrite('Withdraw early', () =>
                        walletClient.writeContract({
                          address: registry,
                          abi: agentRegistryAbi,
                          functionName: 'withdrawEarly',
                          args: [selected.agentId],
                          account: address,
                          chain: CHAINS[network.id],
                        }) as Promise<Hash>
                      );
                    }}
                  >
                    {selected && selected.earlyExit.penalty > 0n
                      ? `Withdraw early — keep ${money(selected.earlyExit.paid)}`
                      : 'Withdraw early — 10% penalty'}
                  </button>
                </div>
                <TxStatus state={tx} />
              </div>

              <div style={{ marginTop: 'var(--space-4)' }}>
                <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                  Unbonding queue
                </div>
                {/* Two grid rows, not four flex columns. This was a row of column stacks with
                    align-items:center, so each stack held its own bar segment — and the moment
                    "Day 21 — withdrawable" wrapped to two lines, that column grew, centring pushed
                    the three shorter columns down, and the track came apart into four baselines.
                    Aligning to flex-start would straighten it today and break again on the next
                    label that wraps. Putting the segments on their own grid row makes it
                    structural: the track cannot bend, because no label shares a row with it. */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', rowGap: 4 }}>
                  {UNBONDING_STEPS.map((label, i) => (
                    <div key={label} style={{ height: 4, background: i <= unbondingStep(selected, now) ? 'var(--color-accent)' : 'var(--color-neutral-300)' }} />
                  ))}
                  {UNBONDING_STEPS.map((label) => (
                    <div key={label} style={{ fontSize: 11, textAlign: 'center', paddingInline: 2 }}>
                      {label}
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: 12, marginTop: 'var(--space-2)' }} className="text-muted">
                  {!selected || selected.unbondingAmount === 0n
                    ? 'Nothing queued.'
                    : withdrawable
                      ? `${money(selected.unbondingAmount)} is withdrawable now.`
                      : `${money(selected.unbondingAmount)} unlocks in ${untilText(selected.unbondingAt - now)}.`}
                </p>
              </div>
            </>
          )}

          {/* The early exit is gated on openNotional being zero, and the one way an operator gets
              stuck behind that gate is a request it accepted and never delivered: exposure is not
              released until settlement, a lost challenge, or expiry, and nobody is paid to expire
              anything. Without this panel the operator clicks "Withdraw early", gets
              OutstandingLiability, and has no way to find out that the remedy is a function on a
              different contract. The gate is correct; being unable to see the exit from it is not. */}
          <div style={{ marginTop: 'var(--space-4)', border: '1px solid var(--color-divider)', padding: 'var(--space-3)' }}>
            <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
              Blocked from the early exit
            </div>
            <p style={{ fontSize: 12, margin: 0 }}>
              Early withdrawal needs <code>openNotional</code> at zero
              {selected && selected.openNotional > 0n ? `, and yours is ${money(selected.openNotional)}` : ''}. A request you
              accepted and never delivered holds exposure open indefinitely, because exposure is only released when an
              execution settles, loses a challenge, or expires — and expiry is not automatic. If that is what is holding
              you, you can clear it yourself: <code>markExpired</code> is permissionless, so the agent may call it on its
              own stale request.
            </p>
            <p style={{ fontSize: 12, marginTop: 'var(--space-2)', marginBottom: 0 }}>
              It is not free, and it should not be. Expiring records a liveness fault and slashes 2% of bond; half of that
              is paid to whoever made the call, so calling it on yourself costs about 1% of bond and leaves a permanent
              fault on the record. You are paying for the missed delivery, not for the unblocking — the alternative is
              that someone else calls it, takes the bounty, and you still have the fault.
            </p>
            {/* A request id, not a button that finds them. markExpired takes one requestId and there is
                no view that lists an agent's open requests — finding them means scanning
                ExecutionRequested logs, which is the indexer this repo does not have yet. Asking for
                the id is honest about that; a button that silently did nothing would not be. */}
            <div className="field" style={{ marginTop: 'var(--space-3)' }}>
              <label>Request id</label>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <input className="input" placeholder="0x…" value={requestId} onChange={(e) => setRequestId(e.target.value)} spellCheck={false} style={{ flex: 1 }} />
                <button
                  className="btn btn-secondary"
                  disabled={!canWrite || busy || !router || !isHex(requestId.trim()) || requestId.trim().length !== 66}
                  onClick={() => {
                    if (!walletClient || !address || !router) return;
                    void registryWrite('Expire request', () =>
                      walletClient.writeContract({
                        address: router,
                        abi: executionRouterAbi,
                        functionName: 'markExpired',
                        args: [requestId.trim() as `0x${string}`],
                        account: address,
                        chain: CHAINS[network.id],
                      }) as Promise<Hash>
                    );
                  }}
                >
                  Expire
                </button>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 20 }}>Alerts</h2>
          <p style={{ fontSize: 12 }} className="text-muted">
            Not built. The form below is a sketch of the shape — nothing is stored and no alert fires. It is left
            visible because the design question it answers (who watches a score you are not looking at?) is still open,
            and the honest answer today is nobody.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)', opacity: 0.55 }}>
            <div className="field">
              <label>Webhook URL</label>
              <input className="input" placeholder="https://…" disabled />
            </div>
            <div className="field">
              <label>Score threshold</label>
              <input className="input" type="number" defaultValue={5000} disabled />
            </div>
            <button className="btn btn-secondary btn-block" disabled>
              Save alert
            </button>
          </div>
        </section>
      </div>
    </main>
  );

  /** The one line above the columns that says why nothing is clickable, when nothing is. */
  function ChainBanner() {
    const style = { border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', fontSize: 13 };
    if (!registry) {
      return <div style={style}>BotID is not deployed on {network.name}. Switch to a network where it is.</div>;
    }
    if (!hasProvider) {
      return (
        <div style={style}>
          No browser wallet found. Reads on this page are public; registering an agent or moving a bond needs one.
        </div>
      );
    }
    if (!address) {
      return (
        <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Connect a wallet to register an agent or manage a bond.</span>
          <button className="btn btn-secondary" onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        </div>
      );
    }
    if (!onSelectedChain) {
      return (
        <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', color: 'var(--score-critical)' }}>
          <span>Your wallet is on a different chain than the one this page is showing.</span>
          <button className="btn btn-secondary" onClick={switchToSelected}>
            Switch to {network.name}
          </button>
        </div>
      );
    }
    return (
      <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span>
          {shortAddress(address)} on {network.name}
          {token ? ` · ${money(token.balance)}` : ''}
        </span>
        <button className="btn btn-secondary" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    );
  }
}

/** The chain's own numbers for the selected agent. Nothing here is recomputed from a formula. */
function AgentFacts({ agent, money, network }: { agent: AgentView; money: (v: bigint) => string; network: 'testnet' | 'mainnet' }) {
  const rows: [string, React.ReactNode][] = [
    ['agent', `#${String(agent.agentId)} · ${TIER_NAME[agent.tier]} · ${agent.active ? 'active' : 'paused'}`],
    ['bond', money(agent.bond)],
    ['open notional', money(agent.openNotional)],
    // From getProfile, not from previewNotional above. The preview exists for a bond that does not
    // exist yet; once it does, the contract's answer is the one that gates reservations.
    ['credit line', money(agent.maxOpenNotional)],
    ['score', agent.score.toLocaleString('en-US')],
    ['faults / settled', `${agent.faults} / ${agent.settledExecutions}`],
    [
      'operator',
      <a key="op" href={explorerLink(network, 'address', agent.operator)} target="_blank" rel="noopener noreferrer">
        {shortAddress(agent.operator)}
      </a>,
    ],
  ];
  return (
    <div style={{ marginTop: 'var(--space-3)', borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
          <span className="text-muted">{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Whole tokens to base units, or undefined when the text is not a number yet.
 *
 * undefined rather than 0n for empty and malformed input, because the two need different
 * treatment: a zero amount is a valid thing to type on the way to typing "0.5", and a button that
 * stays disabled is a better answer than one that sends a transaction for nothing.
 */
function parseAmount(text: string, decimals: number): bigint | undefined {
  const v = text.trim();
  if (!v || !/^\d*\.?\d*$/.test(v)) return undefined;
  try {
    const amount = parseUnits(v, decimals);
    return amount > 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

/** Which of the four track segments is lit. -1 when nothing is queued, so none of them are. */
function unbondingStep(agent: AgentView | undefined, now: bigint): number {
  if (!agent || agent.unbondingAmount === 0n) return -1;
  const remaining = agent.unbondingAt - now;
  if (remaining <= 0n) return 3;
  const days = Number(remaining) / 86_400;
  if (days <= 7) return 2;
  if (days <= 14) return 1;
  return 0;
}

/** "6d 4h" — coarse on purpose. A 21-day timer counted to the second reads as more precision
 *  than the block timestamp it is derived from actually carries. */
function untilText(seconds: bigint): string {
  const s = Number(seconds);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((s % 3_600) / 60);
  return `${h}h ${m}m`;
}
