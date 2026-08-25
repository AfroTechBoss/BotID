'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { erc20Abi } from 'viem';
import { executionRouterAbi } from '@abi/ExecutionRouter';
import { readRouterTerms, type RequestStatus, type RouterTerms } from '@/lib/execution';
import { readBondToken } from '@/lib/registry';
import { formatToken } from '@/lib/token';
import { useNetwork, NETWORKS, type NetworkId } from '@/lib/network';
import { useWallet, shortAddress } from '@/lib/wallet';
import { useTx } from '@/lib/tx';
import { CHAINS } from '@/lib/chain';
import TxStatus from '@/components/TxStatus';

// The write half of the receipt, and until now the page had none of it.
//
// Everything above this component on the page is a record of what happened. This is the part where
// a reader who disagrees with the record can do something about it — and the argument the whole
// interface makes, that you do not have to take our word for anything, was quietly false while the
// only way to act on a disagreement was to go and write Node. The page already printed "Anyone may
// post a bond, challenge it, and force an answer at Gold" next to no button at all.
//
// Three verbs, one component. That is deliberate: which verb is available is a single function of
// the router's status plus the clock, and splitting them into three panels would mean three copies
// of that state machine, drifting apart the first time someone edits one of them. A request is
// never in two of these states at once, so the component renders exactly one live control.
//
//   challenge  — Delivered, and the challenge window is still open. Permissionless, costs a bond.
//   finalize   — Delivered, and the window has closed. Permissionless, costs only gas.
//   settle     — Finalized, within the settlement window, consumer only.
//
// `finalize` is here for a reason that is not obvious: it is not an interesting action, it is a
// *prerequisite*. Only a Finalized request can be settled, and nothing moves a Bronze or Silver
// delivery from Delivered to Finalized on its own. Ship settle without finalize and every non-Gold
// execution sits one unreachable step away from the only function that moves reputation — a door
// with a handle on the far side.
//
// The verbs deliberately left out are `settleDefault` and `slashUnresolvedChallenge`. Both are
// permissionless cleanup that a watchtower runs on a timer; a button for them here would invite a
// reader to spend gas doing a keeper's job. Where they are what happens next, this component says
// so in prose rather than offering the click.

type Phase =
  | { kind: 'pending' }
  | { kind: 'challenge'; closesAt: bigint }
  | { kind: 'finalize' }
  | { kind: 'challenged' }
  | { kind: 'settle'; closesAt: bigint }
  | { kind: 'lapsed' }
  | { kind: 'waiting' }
  | { kind: 'done' };

/**
 * Which verb, if any, is live — from the router's status and the clock.
 *
 * `now` is optional because only half the statuses need it, and pretending otherwise costs the
 * reader something. A Pending or Challenged request has one thing to say and it does not depend on
 * the time; a Settled one has nothing to say at all. Make every branch wait for the clock and all
 * of them flash "Reading the clock…" first, including the ones that were never going to say
 * anything — a shop that pulls the shutters down while it checks whether it is open.
 */
function phaseOf(status: RequestStatus, now: bigint | undefined, finalizeAt: bigint, settleBy: bigint): Phase {
  switch (status) {
    case 'Pending':
      return { kind: 'pending' };
    case 'Challenged':
      return { kind: 'challenged' };
    // Gold never appears here. `deliver` finalizes a Gold delivery in the same transaction, so its
    // status skips Delivered entirely — which is also why it sets finalizeAt to the delivery
    // timestamp, making the comparison below false even if one somehow arrived in this state.
    case 'Delivered':
      if (now === undefined) return { kind: 'waiting' };
      return now < finalizeAt ? { kind: 'challenge', closesAt: finalizeAt } : { kind: 'finalize' };
    case 'Finalized':
      if (now === undefined) return { kind: 'waiting' };
      return now <= settleBy ? { kind: 'settle', closesAt: settleBy } : { kind: 'lapsed' };
    default:
      return { kind: 'done' };
  }
}

export default function ExecutionActions({
  network,
  requestId,
  status,
  consumer,
  agentId,
  // Seconds, as strings: a bigint cannot cross the server/client boundary as a prop. Same
  // constraint RecomputeCommitment works under, and the same fix.
  finalizeAt,
  settleBy,
  escalationDeadline,
}: {
  network: NetworkId;
  requestId: `0x${string}`;
  status: RequestStatus;
  consumer: `0x${string}`;
  agentId: string;
  finalizeAt: string;
  settleBy: string;
  escalationDeadline: string;
}) {
  const nav = useRouter();
  const { network: selected } = useNetwork();
  const { address, onSelectedChain, walletClient, connect, connecting, switchToSelected, hasProvider } = useWallet();
  const tx = useTx();

  const [terms, setTerms] = useState<RouterTerms>();
  const [token, setToken] = useState<Awaited<ReturnType<typeof readBondToken>>>();
  const [loading, setLoading] = useState(false);

  // The clock starts in an effect and not during render. Portal computes `Date.now()` inline and
  // gets away with it; here the surrounding page is server-rendered, so a render-time clock would
  // put one timestamp in the HTML and a different one in the hydrated tree — React would either
  // scream or, worse, quietly keep the server's. Undefined until mounted means the panel shows its
  // prose immediately and its buttons a tick later, which is the honest order anyway: a control
  // whose availability depends on the time should not appear before we know the time.
  const [now, setNow] = useState<bigint>();
  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    readRouterTerms(network)
      .then((t) => live && setTerms(t))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network]);

  // Balance and allowance, the latter against the *router* — the registry's allowance, which is
  // what every other panel in the app reads, is a different permission on the same token and would
  // be the wrong answer here.
  const refreshToken = useCallback(async () => {
    if (!address || !terms) {
      setToken(undefined);
      return;
    }
    setLoading(true);
    try {
      setToken(await readBondToken(network, address, terms.router));
    } catch {
      setToken(undefined);
    } finally {
      setLoading(false);
    }
  }, [address, network, terms]);

  useEffect(() => {
    void refreshToken();
  }, [refreshToken]);

  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? 'USDT';
  const money = useCallback(
    (v: bigint) => formatToken(v, { decimals, symbol, compact: false }),
    [decimals, symbol]
  );

  const phase = phaseOf(status, now, BigInt(finalizeAt), BigInt(settleBy));

  // Two networks can disagree here and the disagreement is invisible. This page takes its network
  // from `?network=` in the URL, because a shared receipt has to keep pointing at the chain it was
  // written on; the wallet client takes its chain from the nav switcher. Sign against the wrong one
  // and the transaction goes to a router at the same address on a different chain, which either
  // reverts on an unknown request or — the bad case — hits a real request that happens to share an
  // id. So: no buttons unless the two agree, and say which one to move.
  const receiptNetwork = NETWORKS.find((n) => n.id === network);
  const networksAgree = selected.id === network;
  const canWrite = Boolean(walletClient && address && onSelectedChain && networksAgree && terms);

  const refreshAll = async () => {
    await refreshToken();
    // The server component above holds the status this panel switched on. Without this the reader
    // sees a green tick over a panel still offering the action they just completed.
    nav.refresh();
  };

  // ── challenge ─────────────────────────────────────────────────────────────────────────────
  const bond = terms?.challengeBondAmount ?? 0n;
  const challengeProblem = (() => {
    if (!terms) return 'Reading the router’s terms.';
    if (!token) return undefined;
    if (bond > token.balance) return `The bond is ${money(bond)} and you hold ${money(token.balance)}.`;
    return undefined;
  })();

  const challenge = async () => {
    if (!walletClient || !address || !terms || !token) return;
    const ok = await tx.run([
      {
        label: `Approve ${money(bond)}`,
        // Conditional, and for the exact bond rather than the customary infinite amount — the same
        // rule the portal follows. An unlimited approval to the router is a standing permission to
        // pull the whole balance, granted to save one signature.
        send: async () =>
          bond === 0n || token.allowance >= bond
            ? undefined
            : walletClient.writeContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'approve',
                args: [terms.router, bond],
                account: address,
                chain: CHAINS[network],
              }),
      },
      {
        label: 'Post challenge',
        send: () =>
          walletClient.writeContract({
            address: terms.router,
            abi: executionRouterAbi,
            functionName: 'challenge',
            args: [requestId],
            account: address,
            chain: CHAINS[network],
          }),
      },
    ]);
    if (ok) await refreshAll();
  };

  // ── finalize ──────────────────────────────────────────────────────────────────────────────
  const finalize = async () => {
    if (!walletClient || !address || !terms) return;
    const ok = await tx.run([
      {
        label: 'Finalize',
        send: () =>
          walletClient.writeContract({
            address: terms.router,
            abi: executionRouterAbi,
            functionName: 'finalize',
            args: [requestId],
            account: address,
            chain: CHAINS[network],
          }),
      },
    ]);
    if (ok) await refreshAll();
  };

  // ── settle ────────────────────────────────────────────────────────────────────────────────
  const [pnl, setPnl] = useState('0');
  const [slaBreached, setSla] = useState(false);
  const [limitBreached, setLimit] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Signed, and integral. int256 in the ABI, so the range is not the constraint — the constraint is
  // that "-2.5" is a plausible thing to type into a field labelled basis points and would parse to
  // nothing useful. Rejected rather than rounded: rounding someone's number for them is how a
  // settlement ends up reporting something nobody chose.
  const pnlBps = useMemo(() => {
    const v = pnl.trim();
    return /^-?\d+$/.test(v) ? BigInt(v) : undefined;
  }, [pnl]);

  const isConsumer = Boolean(address && address.toLowerCase() === consumer.toLowerCase());
  const settleProblem = (() => {
    if (!isConsumer) return `Only the consumer (${shortAddress(consumer)}) can settle this request.`;
    if (pnlBps === undefined) return 'Realised P&L must be a whole number of basis points.';
    if (!confirmed) return 'Confirm the report below first.';
    return undefined;
  })();

  const settle = async () => {
    if (!walletClient || !address || !terms || pnlBps === undefined) return;
    const ok = await tx.run([
      {
        label: 'Settle',
        send: () =>
          walletClient.writeContract({
            address: terms.router,
            abi: executionRouterAbi,
            functionName: 'settle',
            args: [requestId, { realizedPnlBps: pnlBps, slaBreached, limitBreached }],
            account: address,
            chain: CHAINS[network],
          }),
      },
    ]);
    if (ok) await refreshAll();
  };

  // ── render ────────────────────────────────────────────────────────────────────────────────
  if (phase.kind === 'done') {
    // Settled, Expired, Faulted. Nothing to offer and nothing to explain that the timeline above
    // does not already say better. Returned before the clock is consulted, because the status
    // alone decides it — otherwise a settled receipt renders an empty "What you can do about it"
    // heading for a frame, which is an invitation to do something and then a shrug.
    return null;
  }

  const busy = tx.busy || loading;
  const slashPct = terms ? terms.faultSlashBps / 100 : 0;
  const bountyPct = terms ? (terms.faultSlashBps * terms.challengerBountyBps) / 1_000_000 : 0;

  return (
    <section>
      <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>What you can do about it</h6>

      <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {phase.kind === 'waiting' && <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>Reading the clock…</p>}

        {phase.kind === 'pending' && (
          <p style={{ margin: 0, fontSize: 13 }}>
            Nothing has been delivered, so there is nothing to dispute and nothing to grade. If the
            agent misses its delivery deadline anyone may call <Mono>markExpired</Mono>, which
            refunds the fee and records a liveness fault — a keeper does this on a timer.
          </p>
        )}

        {phase.kind === 'challenged' && (
          <p style={{ margin: 0, fontSize: 13 }}>
            A challenge is already open on this request. The operator has until{' '}
            <Mono>{stamp(escalationDeadline)}</Mono>
            {now !== undefined && BigInt(escalationDeadline) > now && <> — {untilText(BigInt(escalationDeadline) - now)} from now</>} to
            answer it with a Groth16 proof. Miss that and anyone may call{' '}
            <Mono>slashUnresolvedChallenge</Mono>, which returns the challenger&apos;s bond and takes{' '}
            {slashPct}% of the agent&apos;s remaining bond.
          </p>
        )}

        {phase.kind === 'challenge' && (
          <>
            <p style={{ margin: 0, fontSize: 13 }}>
              This delivery was verified by an attestation, not by a proof. Until{' '}
              <Mono>{stamp(finalizeAt)}</Mono>
              {now !== undefined && <> — {untilText(phase.closesAt - now)} from now — </>} anyone may
              post a bond and force the operator to produce one.
            </p>
            {/* The odds, both directions, before the button. A challenge panel that showed only the
                upside would be a casino advertising its jackpot and not its rake. */}
            <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
              Challenging is a bet, not a complaint — you are calling a bluff, and the stake is real
              whichever way it goes. You post <strong>{terms ? money(bond) : '…'}</strong> and start a{' '}
              {terms ? windowText(terms.escalationWindow) : '…'} clock. If the operator answers with a
              valid Gold proof, your bond is paid to the agent&apos;s owner and you get nothing back.
              If the clock runs out unanswered, you get the bond back <em>and</em> {bountyPct}% of the
              agent&apos;s remaining bond — half of the {slashPct}% slashed from it.
            </p>
            {terms && bond > 0n && (
              <p className="text-muted" style={{ margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                challengeBondAmount {bond.toString()} base units · {decimals} decimals · {money(bond)}
              </p>
            )}
            {/* The decimals trap, surfaced rather than hit. The router's default bond is 100e18,
                which against a six-decimal bond token is a hundred trillion tokens — nobody's
                balance. Offering a button that can only revert would be worse than saying so. */}
            {terms && token && bond > token.balance && bond > 0n && (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--score-critical)' }}>
                The router is asking for {money(bond)} and you hold {money(token.balance)}. If that
                figure looks absurd it probably is: a <Mono>challengeBondAmount</Mono> set in
                18-decimal units against a {decimals}-decimal bond token makes the challenge
                mechanism unusable, and is a deployment fault rather than yours.
              </p>
            )}
            <Controls>
              <button className="btn btn-primary" onClick={() => void challenge()} disabled={!canWrite || busy || Boolean(challengeProblem)}>
                {busy ? 'Working…' : `Challenge · ${terms ? money(bond) : '…'}`}
              </button>
            </Controls>
            <TxStatus state={tx} idleHint={canWrite ? challengeProblem : undefined} />
          </>
        )}

        {phase.kind === 'finalize' && (
          <>
            <p style={{ margin: 0, fontSize: 13 }}>
              The challenge window closed at <Mono>{stamp(finalizeAt)}</Mono> with no challenge, so
              the delivery stands. It is not yet <em>final</em>, though: someone has to say so. Until
              this request is finalized the consumer cannot settle it, and the agent&apos;s score does
              not move — the work is done and the paperwork is not.
            </p>
            <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
              Permissionless and free apart from gas. Anyone can do this, including you; a watchtower
              normally gets there first.
            </p>
            <Controls>
              <button className="btn btn-secondary" onClick={() => void finalize()} disabled={!canWrite || busy}>
                {busy ? 'Working…' : 'Finalize'}
              </button>
            </Controls>
            <TxStatus state={tx} />
          </>
        )}

        {phase.kind === 'settle' && (
          <>
            <p style={{ margin: 0, fontSize: 13 }}>
              Final and unsettled. The consumer reports what the allocation actually returned, and
              until it does, agent #{agentId}&apos;s score has not moved for this execution. The window
              closes at <Mono>{stamp(settleBy)}</Mono>
              {now !== undefined && <> — {untilText(phase.closesAt - now)} from now</>}.
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'flex-end' }}>
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="pnl-bps">Realised P&amp;L (bps of notional)</label>
                <input
                  id="pnl-bps"
                  className="input"
                  value={pnl}
                  onChange={(e) => setPnl(e.target.value)}
                  disabled={!isConsumer || busy}
                  inputMode="numeric"
                  placeholder="-250"
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={slaBreached} onChange={(e) => setSla(e.target.checked)} disabled={!isConsumer || busy} />
                  <span>
                    <Mono>slaBreached</Mono> <span className="text-muted">— late or out of spec</span>
                  </span>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={limitBreached} onChange={(e) => setLimit(e.target.checked)} disabled={!isConsumer || busy} />
                  <span>
                    <Mono>limitBreached</Mono> <span className="text-muted">— exceeded declared risk limits</span>
                  </span>
                </label>
              </div>
            </div>

            {/* Transcribed from ScoreMath.quality, because the two boxes above do not read like
                penalties and are the heaviest thing on the form. The multipliers are the library's,
                in the order it applies them. */}
            <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
              Those two boxes are not notes, they are the sentence. <Mono>slaBreached</Mono> halves
              this execution&apos;s quality; <Mono>limitBreached</Mono> cuts it to a fifth; ticking
              both leaves a tenth. A loss is treated far more gently — it costs the agent nothing
              until it exceeds the loss tolerance it declared at registration, and only reaches full
              penalty at twice that. The protocol scores adherence, not profit, so a bad quarter
              inside the declared band is not a bad agent.
            </p>
            <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
              Realised P&amp;L is the one number on this page nobody proved. The chain takes your word
              for it — which is exactly why it will only take it from the consumer that paid, and why
              it takes it once. There is no amended return.
            </p>
            {pnlBps !== undefined && (pnlBps > 10_000n || pnlBps < -10_000n) && (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--state-pending)' }}>
                {pnlBps.toString()} bps is {pnlBps > 0n ? 'a gain' : 'a loss'} of more than the whole
                notional. Legal, and occasionally true, but worth a second look before you sign.
              </p>
            )}

            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={!isConsumer || busy} style={{ marginTop: 3 }} />
              <span>
                I am reporting {pnlBps === undefined ? '—' : `${pnlBps > 0n ? '+' : ''}${pnlBps.toString()} bps`}
                {slaBreached && ', SLA breached'}
                {limitBreached && ', limits breached'} for agent #{agentId}, permanently.
              </span>
            </label>

            <Controls>
              <button className="btn btn-primary" onClick={() => void settle()} disabled={!canWrite || busy || Boolean(settleProblem)}>
                {busy ? 'Working…' : 'Settle'}
              </button>
            </Controls>
            <TxStatus state={tx} idleHint={canWrite ? settleProblem : undefined} />
          </>
        )}

        {phase.kind === 'lapsed' && (
          <p style={{ margin: 0, fontSize: 13 }}>
            The settlement window closed at <Mono>{stamp(settleBy)}</Mono> without a report. The
            consumer&apos;s right to grade this execution has expired and does not come back. What
            happens now is <Mono>settleDefault</Mono>: permissionless, and it closes the request at
            par — no P&amp;L, no breaches, no fault. A consumer that says nothing is treated as
            having no complaint, not as having one. A keeper will call it.
          </p>
        )}

        {/* The banner sits below the controls rather than above them. Above, it reads as a wall in
            front of the panel; below, the reader has already seen what the action is and the banner
            answers "why is that button grey". */}
        {(phase.kind === 'challenge' || phase.kind === 'finalize' || phase.kind === 'settle') && <Banner />}
      </div>
    </section>
  );

  function Banner() {
    const style = { borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)', fontSize: 12 };
    if (!hasProvider) {
      return <div style={style} className="text-muted">No browser wallet found. Everything above is readable without one; acting on it is not.</div>;
    }
    if (!address) {
      return (
        <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="text-muted">Connect a wallet to act on this request.</span>
          <button className="btn btn-secondary" onClick={() => connect()} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        </div>
      );
    }
    if (!networksAgree) {
      return (
        <div style={{ ...style, color: 'var(--score-critical)' }}>
          This receipt is for {receiptNetwork?.name ?? network}, and the header is set to{' '}
          {selected.name}. Switch the network in the header before signing anything — the same
          request id on another chain is a different request, or nothing at all.
        </div>
      );
    }
    if (!onSelectedChain) {
      return (
        <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', color: 'var(--score-critical)' }}>
          <span>Your wallet is on a different chain than this receipt.</span>
          <button className="btn btn-secondary" onClick={switchToSelected}>Switch to {selected.name}</button>
        </div>
      );
    }
    return (
      <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', justifyContent: 'space-between', flexWrap: 'wrap' }} className="text-muted">
        <span>
          {shortAddress(address)} on {selected.name}
          {token ? ` · ${money(token.balance)}` : ''}
        </span>
        <button className="btn btn-ghost" onClick={() => void refreshAll()} disabled={busy}>Refresh</button>
      </div>
    );
  }
}

function Controls({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>{children}</div>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: 'var(--font-mono)' }}>{children}</span>;
}

/** A chain timestamp, in the same UTC form the timeline above uses. */
function stamp(seconds: string): string {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** A remaining duration, at whatever precision is worth acting on. */
function untilText(seconds: bigint): string {
  const s = Number(seconds);
  if (s <= 0) return 'any moment now';
  if (s < 90) return `${s}s`;
  if (s < 5_400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3_600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

/** A configured window length, phrased as a duration rather than a deadline. */
function windowText(seconds: bigint): string {
  const s = Number(seconds);
  if (s < 3_600) return `${Math.round(s / 60)}-minute`;
  if (s < 172_800) return `${Math.round(s / 3_600)}-hour`;
  return `${Math.round(s / 86_400)}-day`;
}
