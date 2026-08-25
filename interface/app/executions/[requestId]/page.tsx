import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readRequest, readRequestSteps, readDelivery, readAdapter } from '@/lib/execution';
import { readAgent } from '@/lib/registry';
import { addressOf } from '@/lib/contracts';
import { explorerLink } from '@/lib/chain';
import { TIER_META, shortHash, formatNum } from '@/lib/format';
import { formatToken } from '@/lib/token';
import type { NetworkId } from '@/lib/network';
import RecomputeCommitment from './RecomputeCommitment';
import ExecutionActions from './ExecutionActions';

// A server component, and the reason the interface is Next rather than a SPA. The receipt is the
// artifact people paste into a Discord thread when an agent is accused of something; it has to
// unfurl with the claim in it and it has to be readable without JavaScript. Both of those need the
// HTML to already contain the answer.
//
// Every field below now comes off the chain. What changed with the fixtures is not only where the
// numbers come from but what the page is able to claim: the input *values* are gone, because an
// attested bundle commits to a hash and does not carry the number. The old page showed three price
// feeds with their values in a table, which is precisely the thing the design goes out of its way
// not to reveal. What is here instead is what a reader can actually check.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// The network is client state everywhere else in the interface, and a server component cannot read
// it. Testnet is the default for the same reason the read API defaults to it — a read against the
// wrong chain is a wrong answer rather than a misdirected transaction — and `?network=` is honoured
// so a link to a specific chain's receipt stays a link to that chain's receipt.
function networkOf(search: Record<string, string | string[] | undefined>): NetworkId {
  return search.network === 'mainnet' ? 'mainnet' : 'testnet';
}

export async function generateMetadata(
  { params, searchParams }: { params: { requestId: string }; searchParams: Record<string, string | string[] | undefined> }
): Promise<Metadata> {
  const network = networkOf(searchParams);
  const title = `Execution ${shortHash(params.requestId)}`;
  try {
    const r = await readRequest(network, params.requestId);
    if (!r) return { title, description: 'No request with this id on BOT Chain.' };
    const tier = r.tierName ? TIER_META[r.tierName].label : 'Undelivered';
    return {
      title,
      description: `${tier} execution by agent #${r.agentId} · ${formatToken(r.notional)} notional · ${r.status.toLowerCase()}.`,
    };
  } catch {
    // A node that will not answer must not take the page's title with it. The description is
    // omitted rather than invented — an unfurl that states a notional we could not read would be
    // the one lie this page cannot afford.
    return { title };
  }
}

export default async function ExecutionDetail(
  { params, searchParams }: { params: { requestId: string }; searchParams: Record<string, string | string[] | undefined> }
) {
  const { requestId } = params;
  const network = networkOf(searchParams);

  if (!addressOf(network, 'ExecutionRouter')) {
    return (
      <main style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text-subtle)' }}>
        <p>BotID is not deployed on this network, so there is no router holding this request.</p>
      </main>
    );
  }

  const request = await readRequest(network, requestId);
  // A requestId the router has never issued is a 404, not an empty receipt. `getRequest` returns a
  // zero-filled struct rather than reverting, so rendering it would produce a plausible-looking
  // record of an execution that never happened.
  if (!request) notFound();

  // Issued together: the timeline and the delivery both walk the same log range, and the agent read
  // is independent of either. Sequentially this is three round trips a reader waits through.
  const [steps, delivery, agent, adapter] = await Promise.all([
    readRequestSteps(network, requestId),
    readDelivery(network, requestId),
    readAgent(network, request.agentId).catch(() => undefined),
    readAdapter(network, request.tier),
  ]);

  const tm = request.tierName ? TIER_META[request.tierName] : undefined;
  const final = request.tierName === 'gold' || request.status === 'Settled' || request.status === 'Finalized';
  const challengeable = request.status === 'Delivered' && request.tierName !== 'gold';
  const attestor = addressOf(network, 'InputAttestor');
  const settled = steps.find((s) => s.verb === 'SETTLE');
  const bps = settled?.detail ? Number(settled.detail.replace(/[^-\d]/g, '')) : undefined;

  return (
    // Uncapped, like the agent profile: this is a record of hashes and a 4-column claim grid, and
    // mono type at 13px is the thing least helped by being squeezed into 860px.
    <main style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ border: `2px solid ${tm?.color ?? 'var(--color-divider)'}`, padding: 'var(--space-4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
          <span className="tag" style={{ background: `color-mix(in srgb, ${tm?.color ?? 'var(--text-muted)'} 18%, transparent)`, color: tm?.color ?? 'var(--text-muted)' }}>
            {(tm?.label ?? 'Undelivered').toUpperCase()} &middot; {request.status.toUpperCase()}
          </span>
          <span className="text-muted" style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>requestId {shortHash(requestId, 8)}</span>
        </div>
        <p style={{ margin: 0, fontSize: 15 }}>
          {!request.tierName
            ? 'Requested and not yet delivered. Nothing has been verified, because nothing has been claimed.'
            : request.tierName === 'gold'
              ? 'Verified by a Groth16 proof at delivery. Final — this cannot be challenged.'
              : challengeable
                ? `Verified by ${request.tierName === 'silver' ? 'a TEE attestation' : 'the operator’s signature'}. Anyone may post a bond, challenge it, and force an answer at Gold.`
                : `Verified by ${request.tierName === 'silver' ? 'a TEE attestation' : 'the operator’s signature'}. The challenge window is closed.`}
        </p>
      </div>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>The claim</h6>
        <div className="stat-strip" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          <Cell label="AGENT" val={<Link href={`/agents/${request.agentId}`}>#{request.agentId.toString()}</Link>} />
          <Cell label="NOTIONAL" val={formatToken(request.notional)} />
          <Cell
            label="FEE"
            // Basis points of notional, recomputed rather than read: the router stores an absolute
            // fee and floors it against minFeeBps, so bps is a derived view of it. Zero-notional
            // requests are exempt from the floor and would divide by zero here.
            val={request.notional > 0n ? `${formatToken(request.fee)} · ${Number((request.fee * 10_000n) / request.notional)} bps` : formatToken(request.fee)}
          />
          <Cell
            label="CONSUMER"
            val={
              <a href={explorerLink(network, 'address', request.consumer)} target="_blank" rel="noopener noreferrer">
                {shortHash(request.consumer, 4)}
              </a>
            }
          />
        </div>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Inputs</h6>
        {delivery?.feeds && delivery.feeds.length > 0 ? (
          <>
            <div className="table-scroll">
              <table className="table table-dense">
                <thead><tr><th>Feed</th><th>Publishers</th><th>Reading taken</th><th>valueHash</th></tr></thead>
                <tbody>
                  {delivery.feeds.map((f) => (
                    <tr key={f.feedId}>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{shortHash(f.feedId, 6)}</td>
                      <td className="tabular">{f.signatures} signed</td>
                      <td className="text-muted" style={{ fontSize: 12 }}>{new Date(Number(f.timestamp) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{shortHash(f.valueHash, 6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* There is no Value column, and its absence is the design rather than a gap in the
                read. A bundle commits to keccak(value, salt) and carries the hash; the number is
                revealed only when a Gold proof opens it. The fixture version of this page printed
                three prices, which is exactly the thing an attested bundle exists not to leak. */}
            <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>
              A bundle commits to <span style={{ fontFamily: 'var(--font-mono)' }}>keccak256(value, salt)</span>, not to the
              value. The readings themselves are opened only by a Gold proof
              {request.tierName === 'gold' && <> — <Link href={`/verify/${requestId}`}>see the proof inspector</Link></>}.
            </p>
            {attestor && (
              <RecomputeCommitment
                network={network}
                attestor={attestor}
                feeds={delivery.feeds.map((f) => ({ feedId: f.feedId, valueHash: f.valueHash, timestamp: f.timestamp.toString() }))}
                expected={request.inputCommitment}
              />
            )}
          </>
        ) : (
          <p className="text-muted" style={{ fontSize: 13 }}>
            {request.status === 'Pending'
              ? 'Not delivered yet, so no bundle has been presented. The consumer committed to the inputs below; the agent has to fetch data that hashes to it.'
              : 'The delivery transaction did not decode as a direct `deliver` call — an operator delivering through a batcher or a multisig produces calldata this page cannot read. The commitment below is what the router checked.'}
          </p>
        )}
        <div className="table-scroll" style={{ fontSize: 11, marginTop: 8, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
          <span className="text-muted">inputCommitment</span> {request.inputCommitment}
        </div>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Output</h6>
        {request.outputCommitment === ZERO ? (
          <p className="text-muted" style={{ fontSize: 13 }}>Nothing committed yet. The router writes the output commitment at delivery.</p>
        ) : (
          <>
            {/* Scrolls rather than wraps: a 64-character commitment broken across two lines is one
                the reader has to mentally rejoin before they can compare it to anything. */}
            <div className="table-scroll" style={{ fontSize: 11, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
              <span className="text-muted">outputCommitment</span> {request.outputCommitment}
            </div>
            <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>
              Committed at delivery, before anyone asked for a proof. An agent that computed this
              with a different implementation of its model has already committed to a number it may
              not be able to prove.
            </p>
          </>
        )}
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Attestation</h6>
        <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', fontFamily: 'var(--font-mono)', fontSize: 13, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span>
            {!request.tierName
              ? 'none yet'
              : `${request.tierName === 'gold' ? 'Groth16 proof' : request.tierName === 'silver' ? 'TEE quote' : 'ECDSA signature'}${delivery?.attestationBytes ? ` · ${formatNum(delivery.attestationBytes)} bytes` : ''}`}
            {adapter && (
              <>
                {' · verifier '}
                <a href={explorerLink(network, 'address', adapter)} target="_blank" rel="noopener noreferrer">{shortHash(adapter, 4)}</a>
              </>
            )}
          </span>
          {request.tierName === 'gold' && <Link href={`/verify/${requestId}`} className="btn btn-secondary">Open proof inspector</Link>}
        </div>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
          Outcome &middot; <span style={{ textTransform: 'none', letterSpacing: 0, fontStyle: 'italic' }}>consumer-reported</span>
        </h6>
        {bps === undefined ? (
          <p className="text-muted" style={{ fontSize: 13 }}>
            Not settled. The consumer reports the realised result, and until it does there is no
            outcome — which is why the score has not moved for this execution.
          </p>
        ) : (
          <>
            <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              <div>
                <div className="text-muted" style={{ fontSize: 10 }}>REALIZED PNL</div>
                <span style={{ color: bps >= 0 ? 'var(--score-good)' : 'var(--score-critical)' }}>{bps >= 0 ? '+' : ''}{bps} bps</span>
              </div>
              <div>
                <div className="text-muted" style={{ fontSize: 10 }}>AGENT SCORE NOW</div>
                {agent ? formatNum(agent.score) : '—'}
              </div>
            </div>
            {/* The score delta is not shown, and used to be. It is not recoverable: the engine
                emits the new score, not the step, and reconstructing the difference would mean
                replaying every settlement for this agent through ScoreMath. A number nobody can
                check is the one thing this page should not print. */}
            <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>
              Reported by the consuming protocol. This is the one number on the page nobody proved.
            </p>
          </>
        )}
      </section>

      {/* The one client island besides RecomputeCommitment, and it sits here on purpose: after the
          reader has seen the claim, the evidence and the outcome, and before the timeline that is
          only a record. Everything above is what happened; this is what can still be done about it.
          bigints go across as strings — a server component cannot hand one to a client one. */}
      <ExecutionActions
        network={network}
        requestId={request.requestId}
        status={request.status}
        consumer={request.consumer}
        agentId={request.agentId.toString()}
        finalizeAt={request.finalizeAt.toString()}
        settleBy={request.settleBy.toString()}
        escalationDeadline={request.escalationDeadline.toString()}
      />

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Timeline</h6>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Event</th><th>Block</th><th>When</th><th>Transaction</th></tr></thead>
            <tbody>
              {steps.map((s) => (
                <tr key={`${s.txHash}:${s.verb}`}>
                  <td style={{ fontWeight: 700, fontSize: 12 }}>{s.verb}</td>
                  <td className="tabular" style={{ fontFamily: 'var(--font-mono)' }}>{formatNum(Number(s.block))}</td>
                  <td className="text-muted" style={{ fontSize: 12 }}>
                    {s.time > 0 ? `${new Date(s.time).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—'}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    <a href={explorerLink(network, 'tx', s.txHash)} target="_blank" rel="noopener noreferrer">{shortHash(s.txHash, 5)}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Storage said the status; the logs say when. They can disagree in exactly one direction —
            a request older than DEPLOY_BLOCK's scan window has state but no events — and saying so
            is better than an empty table that reads as "nothing happened". */}
        {steps.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13 }}>
            The router holds this request at {request.status.toLowerCase()}, but none of its events
            are in the scanned block range.
          </p>
        )}
      </section>
    </main>
  );
}

const ZERO = `0x${'0'.repeat(64)}`;

// The `border` prop is gone: .stat-strip draws the dividers now, and it draws them on the axis the
// cells are actually laid out on rather than always to the right.
function Cell({ label, val }: { label: string; val: React.ReactNode }) {
  return (
    <div style={{ padding: 'var(--space-3)' }}>
      <div className="text-muted" style={{ fontSize: 10 }}>{label}</div>{val}
    </div>
  );
}
