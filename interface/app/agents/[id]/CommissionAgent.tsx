'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { erc20Abi, isHex, parseUnits } from 'viem';
import { executionRouterAbi } from '@abi/ExecutionRouter';
import { commitmentFor, readRequestTerms, type RequestTerms } from '@/lib/execution';
import { readBondToken, type AgentView } from '@/lib/registry';
import { useNetwork } from '@/lib/network';
import { useWallet, shortAddress } from '@/lib/wallet';
import { useTx } from '@/lib/tx';
import { CHAINS } from '@/lib/chain';
import TxStatus from '@/components/TxStatus';

// The door into the protocol, which until now was not on the building.
//
// Every other verb in this interface acts on an execution that already exists — deliver, challenge,
// finalize, settle, and the keeper cleanups. `requestExecution` is the one that makes one, and it
// was the only lifecycle function with no UI at all. The consequence was not subtle: mainnet has
// been live since 2026-09-03 and has never carried a single execution, because the only way to
// start one was `contracts/scripts/execute-once.js` — a Node script that wants a private key in an
// env file. The directory listed agents that could be hired by nobody.
//
// This form is on the agent's own page rather than under /executions, and that is the protocol's
// shape rather than a layout preference. You do not post a job and wait for bids; you commission a
// named agent, whose bond is the collateral and whose score is what moves. `agentId` is therefore
// not a field — it is where you are standing.
//
// Six things make `requestExecution` revert, and all six are knowable before signing. Reverting
// costs gas and tells the user a Solidity error name, so every one of them is checked here and
// reported as the sentence it actually is. In the router's own order:
//
//   DeliveryWindowTooShort  deliverBy < block.timestamp + minDeliveryWindow
//   ZeroNotional            notional == 0
//   FeeBelowFloor           fee < notional * minFeeBps / 10_000
//   SelfDealing             caller is the agent's owner or its operator
//   AgentInactive           registry.reserve, on an agent that has been switched off
//   CreditExceeded          openNotional + notional > the agent's bond-derived limit
//
// And a seventh that is not a router revert but an ERC-20 one: the fee is pulled with
// `safeTransferFrom` at the end of the call, so a short balance or allowance reverts the whole
// request from inside the token.

/** How much slack to leave between the clock in this browser and the block that mines the call. */
const MINING_MARGIN = 120n;

/** Offered delivery windows, in seconds. Filtered against the router's floor before rendering. */
const WINDOWS: { label: string; secs: bigint }[] = [
  { label: '30 minutes', secs: 1_800n },
  { label: '1 hour', secs: 3_600n },
  { label: '6 hours', secs: 21_600n },
  { label: '24 hours', secs: 86_400n },
];

interface Feed {
  feedId: `0x${string}`;
  valueHash: `0x${string}`;
  timestamp: bigint;
  signatures: `0x${string}`[];
}

export default function CommissionAgent({ agent, onDone }: { agent: AgentView; onDone?: () => void }) {
  const { network } = useNetwork();
  const { address, onSelectedChain, walletClient, connect, connecting, switchToSelected, hasProvider } = useWallet();
  const tx = useTx();

  const [open, setOpen] = useState(false);
  const [terms, setTerms] = useState<RequestTerms>();
  const [token, setToken] = useState<Awaited<ReturnType<typeof readBondToken>>>();

  // Same reason as ExecutionActions: undefined until mounted. A deadline computed during render
  // would be one number on the server and another after hydration.
  const [now, setNow] = useState<bigint>();
  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    readRequestTerms(network.id)
      .then((t) => live && setTerms(t))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [network.id]);

  const refreshToken = useCallback(async () => {
    if (!address || !terms) {
      setToken(undefined);
      return;
    }
    try {
      setToken(await readBondToken(network.id, address, terms.router));
    } catch {
      setToken(undefined);
    }
  }, [address, network.id, terms]);

  useEffect(() => {
    void refreshToken();
  }, [refreshToken]);

  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? 'USDT';
  // Not formatToken. That helper truncates to whole units, which is right for a leaderboard cell
  // and wrong here: at a 0.1% floor a 100 USDT notional needs 0.1 USDT of fee, and "the fee floor
  // for that notional is 0 USDT" tells a reader that zero clears a floor it does not clear. Every
  // number in this panel is a number someone is about to sign, so they are all shown exactly.
  const money = useCallback((v: bigint) => `${exact(v, decimals)} ${symbol}`, [decimals, symbol]);

  // ── the form ──────────────────────────────────────────────────────────────────────────────
  const [notionalInput, setNotional] = useState('');
  const [feeInput, setFee] = useState('');
  const [windowSecs, setWindowSecs] = useState<bigint>(3_600n);
  const [mode, setMode] = useState<'bundle' | 'commitment'>('bundle');
  const [bundleText, setBundleText] = useState('');
  const [commitmentInput, setCommitment] = useState('');
  const [inputURI, setInputURI] = useState('');

  const notional = useMemo(() => parseAmount(notionalInput, decimals), [notionalInput, decimals]);
  const fee = useMemo(() => parseAmount(feeInput, decimals), [feeInput, decimals]);

  // The floor tracks notional, so it moves as the reader types. Shown rather than silently
  // enforced: "the fee is at least 0.1% of what you are risking" is a rule someone can price
  // against, where a greyed-out button is a puzzle.
  const feeFloor = useMemo(
    () => (notional === undefined || !terms ? undefined : (notional * BigInt(terms.minFeeBps)) / 10_000n),
    [notional, terms]
  );

  const headroom = agent.maxOpenNotional > agent.openNotional ? agent.maxOpenNotional - agent.openNotional : 0n;

  // ── the input commitment ──────────────────────────────────────────────────────────────────
  //
  // This is the field with a trap in it, and the trap is not the format. A commitment is 32 bytes
  // and anything is 32 bytes if you hash it — the portal's model-commitment field does exactly
  // that, hashing a typed label so a testnet registration does not require finding a hashing tool.
  // That is safe there because nothing ever opens a model commitment. It is not safe here: an
  // input commitment has to be *opened*, by `verifyInputs`, against the bundle the operator
  // fetches. A hashed label produces a commitment no bundle in the world can satisfy, so the agent
  // can never deliver, the request runs to its deadline, and the agent takes a liveness fault for
  // work it was never given. So this field takes a real bundle, or a commitment someone else
  // derived from one — never a convenience hash.
  const [feeds, feedsError] = useMemo(() => parseBundle(bundleText), [bundleText]);

  const [derived, setDerived] = useState<`0x${string}`>();
  const [deriving, setDeriving] = useState(false);
  useEffect(() => {
    if (mode !== 'bundle' || !feeds) {
      setDerived(undefined);
      return;
    }
    let live = true;
    setDeriving(true);
    commitmentFor(network.id, feeds)
      .then((c) => live && setDerived(c))
      .catch(() => live && setDerived(undefined))
      .finally(() => live && setDeriving(false));
    return () => {
      live = false;
    };
  }, [mode, feeds, network.id]);

  const pasted = useMemo<`0x${string}` | undefined>(() => {
    const v = commitmentInput.trim();
    return isHex(v) && v.length === 66 ? (v as `0x${string}`) : undefined;
  }, [commitmentInput]);

  const inputCommitment = mode === 'bundle' ? derived : pasted;

  // Freshness, which is the part of this that a script gets right by accident and a form gets wrong
  // by being a form. `deliver` calls `verifyInputs(commitment, bundle, r.createdAt)`, and the
  // attestor rejects any reading older than maxAge measured against that createdAt — the timestamp
  // this request is about to acquire. Readings pasted in and then sat on while the rest of the form
  // is filled produce a request that cannot be delivered by anyone. The oldest reading decides it.
  const oldest = feeds && feeds.length > 0 ? feeds.reduce((m, f) => (f.timestamp < m ? f.timestamp : m), feeds[0].timestamp) : undefined;
  const newest = feeds && feeds.length > 0 ? feeds.reduce((m, f) => (f.timestamp > m ? f.timestamp : m), feeds[0].timestamp) : undefined;
  const staleIn = oldest !== undefined && now !== undefined && terms ? oldest + terms.maxAge - now : undefined;

  const deliverBy = now === undefined ? undefined : now + windowSecs;

  // ── can this be sent ──────────────────────────────────────────────────────────────────────
  const isOwner = Boolean(address && address.toLowerCase() === agent.owner.toLowerCase());
  const isOperator = Boolean(address && address.toLowerCase() === agent.operator.toLowerCase());
  const canWrite = Boolean(walletClient && address && onSelectedChain && terms);

  const problem = (() => {
    if (!terms) return 'Reading the router’s terms.';
    if (now === undefined) return 'Reading the clock.';
    if (isOwner || isOperator) {
      return `This wallet ${isOwner ? 'owns' : 'operates'} agent #${agent.agentId.toString()}. The router rejects a request from either key.`;
    }
    if (!agent.active) return 'This agent is switched off and cannot take new work.';
    if (notional === undefined) return 'Notional must be an amount greater than zero.';
    if (notional > headroom) {
      return headroom === 0n
        ? 'This agent has no credit headroom left. Its open exposure is already at its limit.'
        : `Notional is above this agent’s remaining headroom of ${money(headroom)}.`;
    }
    if (fee === undefined) return 'Fee must be an amount greater than zero.';
    if (feeFloor !== undefined && fee < feeFloor) return `The fee floor for that notional is ${money(feeFloor)}.`;
    if (windowSecs < terms.minDeliveryWindow + MINING_MARGIN) return 'The delivery window is shorter than the router allows.';
    if (mode === 'bundle') {
      if (feedsError) return feedsError;
      if (!feeds) return 'Paste the signed input bundle.';
      if (!terms.attestor) return `No InputAttestor is deployed on ${network.name}, so a bundle cannot be committed to here.`;
      if (deriving) return 'Deriving the commitment from the bundle.';
      if (!derived) return 'The attestor did not return a commitment for that bundle.';
      if (newest !== undefined && newest > now) return 'A reading is timestamped in the future. The attestor rejects those.';
      if (staleIn !== undefined && staleIn <= 0n) return 'These readings are already older than the attestor allows. Fetch a fresh bundle.';
    } else if (!pasted) {
      return 'A commitment is 32 bytes of hex.';
    }
    if (token && fee > token.balance) return `The fee is ${money(fee)} and you hold ${money(token.balance)}.`;
    return undefined;
  })();

  const submit = async () => {
    if (!walletClient || !address || !terms || !token) return;
    if (notional === undefined || fee === undefined || inputCommitment === undefined || deliverBy === undefined) return;

    const ok = await tx.run([
      {
        // Conditional, and for the exact fee. The same rule the rest of the app follows: an
        // unlimited approval to the router is a standing permission to pull the whole balance,
        // granted to save one signature.
        label: `Approve ${money(fee)}`,
        send: async () =>
          fee === 0n || token.allowance >= fee
            ? undefined
            : walletClient.writeContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'approve',
                args: [terms.router, fee],
                account: address,
                chain: CHAINS[network.id],
              }),
      },
      {
        label: 'Commission execution',
        send: () =>
          walletClient.writeContract({
            address: terms.router,
            abi: executionRouterAbi,
            functionName: 'requestExecution',
            args: [agent.agentId, inputCommitment, notional, fee, deliverBy, inputURI.trim()],
            account: address,
            chain: CHAINS[network.id],
          }),
      },
    ]);

    if (ok) {
      await refreshToken();
      // The request id is assigned on chain and comes back in the ExecutionRequested log, not from
      // the write. Rather than decode a receipt here, the page's own polling picks the new row up —
      // it appears in the executions table below within one interval.
      onDone?.();
      setBundleText('');
      setCommitment('');
    }
  };

  const windows = terms ? WINDOWS.filter((w) => w.secs >= terms.minDeliveryWindow + MINING_MARGIN) : [];
  const busy = tx.busy;

  if (!open) {
    return (
      <section style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-4)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center', justifyContent: 'space-between' }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            Commission this agent. You put up the notional as the capital at risk, pay the fee up
            front, and grade the result yourself when it settles.
          </p>
          <button className="btn btn-primary" onClick={() => setOpen(true)}>Commission an execution</button>
        </div>
      </section>
    );
  }

  return (
    <section style={{ marginBottom: 'var(--space-8)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
        <h6 style={{ color: 'var(--text-muted)', margin: 0 }}>Commission an execution</h6>
        <button className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>Close</button>
      </div>

      <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <p style={{ margin: 0, fontSize: 13 }}>
          You are hiring agent #{agent.agentId.toString()} directly. The fee is transferred when you
          sign; the notional is not — it is the size of the position this execution is deemed to
          control, and what the agent&apos;s bond is on the hook for. Nothing else about the trade
          happens on chain.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
          <div className="field" style={{ minWidth: 180, flex: 1 }}>
            <label htmlFor="notional">Notional ({symbol})</label>
            <input id="notional" className="input" value={notionalInput} onChange={(e) => setNotional(e.target.value)} disabled={busy} inputMode="decimal" placeholder="10000" style={{ fontFamily: 'var(--font-mono)' }} />
            <p className="text-muted" style={{ fontSize: 11, marginTop: 5, marginBottom: 0 }}>
              Headroom {money(headroom)} of {money(agent.maxOpenNotional)}
            </p>
          </div>

          <div className="field" style={{ minWidth: 180, flex: 1 }}>
            <label htmlFor="fee">Fee ({symbol})</label>
            <input id="fee" className="input" value={feeInput} onChange={(e) => setFee(e.target.value)} disabled={busy} inputMode="decimal" placeholder="25" style={{ fontFamily: 'var(--font-mono)' }} />
            <p className="text-muted" style={{ fontSize: 11, marginTop: 5, marginBottom: 0 }}>
              {terms ? <>Floor {terms.minFeeBps / 100}% — {feeFloor === undefined ? 'set a notional' : money(feeFloor)}</> : '…'}
            </p>
          </div>

          <div className="field" style={{ minWidth: 180, flex: 1 }}>
            <label htmlFor="window">Deliver within</label>
            <select id="window" className="input" value={windowSecs.toString()} onChange={(e) => setWindowSecs(BigInt(e.target.value))} disabled={busy}>
              {windows.map((w) => (
                <option key={w.label} value={w.secs.toString()}>{w.label}</option>
              ))}
            </select>
            <p className="text-muted" style={{ fontSize: 11, marginTop: 5, marginBottom: 0 }}>
              {deliverBy === undefined ? '…' : `deliverBy ${new Date(Number(deliverBy) * 1000).toLocaleString()}`}
            </p>
          </div>
        </div>

        {/* The fee is not the whole cost of being wrong, and the form should say so before the
            signature rather than after the settlement. */}
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          The fee is paid whatever happens — it is split at settlement between the agent and the
          protocol, and it does not come back if the result disappoints you. What the notional buys
          is the grading: it is the weight your report carries against this agent&apos;s score, and
          the size the agent&apos;s bond is exposed to if it defaults. If the agent never delivers,{' '}
          <Mono>markExpired</Mono> refunds the fee and records the fault.
        </p>

        {/* ── the input ─────────────────────────────────────────────────────────────────── */}
        <div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'color-mix(in srgb, var(--color-text) 70%, transparent)' }}>Input commitment</span>
            <button className="btn btn-ghost" onClick={() => setMode('bundle')} disabled={busy} aria-pressed={mode === 'bundle'} style={{ opacity: mode === 'bundle' ? 1 : 0.55 }}>From a bundle</button>
            <button className="btn btn-ghost" onClick={() => setMode('commitment')} disabled={busy} aria-pressed={mode === 'commitment'} style={{ opacity: mode === 'commitment' ? 1 : 0.55 }}>Paste a commitment</button>
          </div>

          {mode === 'bundle' ? (
            <>
              <textarea
                className="input"
                value={bundleText}
                onChange={(e) => setBundleText(e.target.value)}
                disabled={busy}
                rows={6}
                spellCheck={false}
                placeholder={'[{"feedId":"0x…","valueHash":"0x…","timestamp":1757000000,"signatures":["0x…"]}]'}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11, width: '100%', resize: 'vertical' }}
              />
              <p className="text-muted" style={{ fontSize: 12, marginTop: 'var(--space-2)', marginBottom: 0 }}>
                The publisher-signed readings the agent is to run on, in order — order is part of the
                commitment. The commitment is computed by the attestor itself rather than rebuilt
                here, because its EIP-712 domain includes the attestor&apos;s own address and a second
                implementation of that hash would only ever be discovered by a delivery that should
                have verified and did not.
              </p>
              {feedsError && bundleText.trim() && (
                <p style={{ fontSize: 12, marginTop: 6, marginBottom: 0, color: 'var(--score-critical)' }}>{feedsError}</p>
              )}
              {derived && (
                <p className="text-muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0, fontFamily: 'var(--font-mono)' }}>
                  {feeds?.length} reading{feeds?.length === 1 ? '' : 's'} · {derived}
                </p>
              )}
              {/* The freshness clock. This is the one number that turns a valid-looking request
                  into an undeliverable one, and it runs down while the form is open. */}
              {staleIn !== undefined && terms && (
                <p style={{ fontSize: 12, marginTop: 6, marginBottom: 0, color: staleIn <= 60n ? 'var(--score-critical)' : staleIn <= 120n ? 'var(--state-pending)' : 'var(--text-subtle)' }}>
                  {staleIn <= 0n ? (
                    <>These readings are past the attestor&apos;s {Number(terms.maxAge)}s freshness limit. A request built on them cannot be delivered by anyone — fetch a fresh bundle rather than signing this.</>
                  ) : (
                    <>Usable for another {Number(staleIn)}s. Freshness is measured against the timestamp this request acquires when it is mined, not against now, so sign well before that reaches zero.</>
                  )}
                </p>
              )}
              {terms && feeds && feeds.some((f) => f.signatures.length < Number(terms.quorum)) && (
                <p style={{ fontSize: 12, marginTop: 6, marginBottom: 0, color: 'var(--state-pending)' }}>
                  This attestor requires {terms.quorum.toString()} signature{terms.quorum === 1n ? '' : 's'} per
                  reading and at least one reading here has fewer. The request will go through — the
                  router does not check signatures — but the delivery against it will not verify.
                </p>
              )}
            </>
          ) : (
            <>
              <input className="input" value={commitmentInput} onChange={(e) => setCommitment(e.target.value)} disabled={busy} spellCheck={false} placeholder="0x…" style={{ fontFamily: 'var(--font-mono)', width: '100%' }} />
              <p className="text-muted" style={{ fontSize: 12, marginTop: 'var(--space-2)', marginBottom: 0 }}>
                For a commitment your own pipeline already derived. Nothing here can check that it
                opens to a real bundle — if it does not, no delivery will ever verify against it and
                the agent takes a liveness fault for a job it could not do. Unlike a model
                commitment, this one is not opaque: it gets opened.
              </p>
            </>
          )}
        </div>

        <div className="field">
          <label htmlFor="input-uri">Where the agent fetches it (optional)</label>
          <input id="input-uri" className="input" value={inputURI} onChange={(e) => setInputURI(e.target.value)} disabled={busy} spellCheck={false} placeholder="https://… or ipfs://…" style={{ fontFamily: 'var(--font-mono)', width: '100%' }} />
          <p className="text-muted" style={{ fontSize: 12, marginTop: 5, marginBottom: 0 }}>
            Emitted in the log and never stored or trusted. A commitment is not a locator, so without
            this the agent has to already know where the bundle lives. It cannot change what the
            agent is judged on — the agent checks what it fetches against the commitment — so the
            worst a wrong URI does is waste its time.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!canWrite || busy || Boolean(problem)}>
            {busy ? 'Working…' : fee !== undefined ? `Commission · ${money(fee)}` : 'Commission'}
          </button>
        </div>
        <TxStatus state={tx} idleHint={canWrite ? problem : undefined} />

        <Banner />
      </div>
    </section>
  );

  // Same shape and same order as the receipt page's banner, for the same reason: below the
  // controls, where it answers "why is that button grey" rather than standing in front of them.
  function Banner() {
    const style = { borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)', fontSize: 12 };
    if (!hasProvider) {
      return <div style={style} className="text-muted">No browser wallet found. This agent&apos;s record is readable without one; hiring it is not.</div>;
    }
    if (!address) {
      return (
        <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="text-muted">Connect a wallet to commission this agent.</span>
          <button className="btn btn-secondary" onClick={() => connect()} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        </div>
      );
    }
    if (!onSelectedChain) {
      return (
        <div style={{ ...style, display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', color: 'var(--score-critical)' }}>
          <span>Your wallet is on a different chain than {network.name}.</span>
          <button className="btn btn-secondary" onClick={switchToSelected}>Switch to {network.name}</button>
        </div>
      );
    }
    if (isOwner || isOperator) {
      return (
        <div style={{ ...style, color: 'var(--score-critical)' }}>
          {shortAddress(address)} is this agent&apos;s {isOwner ? 'owner' : 'operator'}. The router
          rejects <Mono>requestExecution</Mono> from either key — not because self-dealing is
          preventable on chain, but because the one-key version of it should fail loudly rather than
          settle quietly. Commission from a different wallet.
        </div>
      );
    }
    return (
      <div style={style} className="text-muted">
        Signing as {shortAddress(address)}. That address becomes the consumer of record: it is the
        only one that can settle this execution, and the only one whose report moves the score.
      </div>
    );
  }
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92em' }}>{children}</span>;
}

/** Decimal string to base units. Rejects zero, which the router rejects too — see ZeroNotional. */
/**
 * A token amount written out in full, with trailing zeros dropped — 0.1, not 0.100000, and 50
 * rather than 50.000000. The inverse of parseAmount, and deliberately not compact: there is no
 * amount in this form large enough to want a "k" suffix, and every one of them is exact.
 */
function exact(v: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = (v / unit).toLocaleString('en-US');
  const frac = (v % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

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

/**
 * A pasted bundle, or the reason it is not one.
 *
 * Strict about the two 32-byte fields and about signatures being hex, because everything it lets
 * through gets hashed into a commitment that has to match, byte for byte, a bundle an operator
 * fetches later. A field that is quietly coerced here is a commitment that quietly cannot be
 * opened — and the cost of that lands on the agent, as a liveness fault, an hour later.
 *
 * Accepts a bare object as well as an array, because a one-reading bundle is the common case and
 * pasting it without the brackets is the obvious mistake to forgive rather than punish.
 */
function parseBundle(text: string): [Feed[] | undefined, string | undefined] {
  const v = text.trim();
  if (!v) return [undefined, undefined];

  let raw: unknown;
  try {
    raw = JSON.parse(v);
  } catch {
    return [undefined, 'The bundle is not valid JSON.'];
  }

  const rows = Array.isArray(raw) ? raw : [raw];
  if (rows.length === 0) return [undefined, 'The bundle has no readings in it.'];

  const feeds: Feed[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    const where = rows.length === 1 ? 'The reading' : `Reading ${i + 1}`;
    if (!r || typeof r !== 'object') return [undefined, `${where} is not an object.`];

    const feedId = r.feedId;
    const valueHash = r.valueHash;
    if (typeof feedId !== 'string' || !isHex(feedId) || feedId.length !== 66) return [undefined, `${where} has no 32-byte feedId.`];
    if (typeof valueHash !== 'string' || !isHex(valueHash) || valueHash.length !== 66) return [undefined, `${where} has no 32-byte valueHash.`];

    // Accepted as a number or a string: JSON.parse turns a big timestamp into a float, and a
    // publisher that quotes it to stay exact should not be the case that fails.
    const ts = r.timestamp;
    let timestamp: bigint;
    if (typeof ts === 'number' && Number.isInteger(ts) && ts > 0) timestamp = BigInt(ts);
    else if (typeof ts === 'string' && /^\d+$/.test(ts.trim())) timestamp = BigInt(ts.trim());
    else return [undefined, `${where} has no whole-second timestamp.`];

    // Missing rather than empty is allowed, and the two mean different things downstream: an
    // unsigned reading still commits, it just will not verify. The quorum warning says so.
    const sigs = r.signatures ?? [];
    if (!Array.isArray(sigs)) return [undefined, `${where} has a signatures field that is not a list.`];
    for (const s of sigs) {
      if (typeof s !== 'string' || !isHex(s)) return [undefined, `${where} has a signature that is not hex.`];
    }

    feeds.push({ feedId, valueHash, timestamp, signatures: sigs as `0x${string}`[] });
  }

  return [feeds, undefined];
}
