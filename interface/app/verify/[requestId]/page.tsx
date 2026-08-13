import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readRequest, readDelivery, readAdapter } from '@/lib/execution';
import { readAgent } from '@/lib/registry';
import { addressOf } from '@/lib/contracts';
import { explorerLink } from '@/lib/chain';
import { shortHash, formatNum } from '@/lib/format';
import type { NetworkId } from '@/lib/network';
import VerifyActions from './VerifyActions';

// Server component for the same reason as the execution receipt: this page is an argument about a
// specific proof, and an argument that only exists after JavaScript runs is one a link preview,
// a crawler and a reader on a bad connection never see.
//
// The instance vector below is the real one, recovered from the delivery transaction's calldata —
// `deliver` verifies the attestation and stores only the commitment, so the transaction is the one
// place the proof still exists. The three invented price feeds are gone with the fixtures. What
// replaces them is better than what they claimed to be: the openings on the left are what the
// agent actually revealed, and every check on this page is an eth_call the reader can repeat.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function networkOf(search: Record<string, string | string[] | undefined>): NetworkId {
  return search.network === 'mainnet' ? 'mainnet' : 'testnet';
}

export function generateMetadata({ params }: { params: { requestId: string } }): Metadata {
  return {
    title: `Proof ${shortHash(params.requestId)}`,
    description: 'Groth16 instance vector, commitment openings and the calls to re-verify it yourself.',
  };
}

export default async function ProofInspector(
  { params, searchParams }: { params: { requestId: string }; searchParams: Record<string, string | string[] | undefined> }
) {
  const { requestId } = params;
  const network = networkOf(searchParams);

  if (!addressOf(network, 'ExecutionRouter')) {
    return <Bare>BotID is not deployed on this network, so there is no proof to inspect.</Bare>;
  }

  const request = await readRequest(network, requestId);
  if (!request) notFound();

  if (request.tier !== 3) {
    return (
      <Bare>
        <p style={{ marginBottom: 'var(--space-3)' }}>
          {request.tierName
            ? `This execution was delivered at ${request.tierName}, not Gold. There is no proof to inspect — a Bronze or Silver delivery is made honest by the challenge that can force one, not by one it already carries.`
            : 'This request has not been delivered yet, so nothing has been proved about it.'}
        </p>
        <Link href={`/executions/${requestId}`} className="btn btn-secondary">Back to the execution</Link>
      </Bare>
    );
  }

  const [delivery, agent, adapter] = await Promise.all([
    readDelivery(network, requestId),
    readAgent(network, request.agentId).catch(() => undefined),
    readAdapter(network, 3),
  ]);

  if (!delivery?.proof) {
    return (
      <Bare>
        <p style={{ marginBottom: 'var(--space-3)' }}>
          The router holds a Gold delivery for this request, but the proof could not be recovered
          from its delivery transaction — either it was delivered through a contract whose calldata
          this page cannot decode, or the attestation is not in this repo&apos;s encoding. The
          adapter accepted it, so it is valid; it just cannot be read out here.
        </p>
        <Link href={`/executions/${requestId}`} className="btn btn-secondary">Back to the execution</Link>
      </Bare>
    );
  }

  const { reveals, instances, bytes } = delivery.proof;
  // The split the adapter enforces: the input tensor first, one cell per reveal, then the output
  // tensor. Everything after n_in is what the model produced.
  const nIn = reveals.length;
  const outputs = instances.slice(nIn);
  const verifier = addressOf(network, 'Halo2Verifier');

  return (
    // Uncapped. The instance vector and the verify command are long mono strings that were
    // wrapping mid-hash at 860px, which is the one place wrapping actively costs the reader
    // something: a hash you have to mentally rejoin is a hash you cannot check by eye.
    <main style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Proof inspector</h1>
        <div className="text-muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          requestId <Link href={`/executions/${requestId}`}>{shortHash(requestId, 6)}</Link> &middot; agent #
          {request.agentId.toString()} &middot; {formatNum(bytes.length / 2 - 1)} proof bytes
        </div>
      </div>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
          Instance vector <span style={{ textTransform: 'none', letterSpacing: 0 }}>&mdash; split at n<sub>in</sub>={nIn}</span>
        </h6>
        {/* Scrolls sideways on a narrow screen instead of wrapping. Every row here is a fixed
            column of cells — [i], the field element, the value it opens to, the feed it came from —
            and the whole point is that they line up so a reader can check one against the next.
            Wrapping the columns would break the alignment that is the artifact. */}
        <div className="table-scroll" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)' }}>
          <Band>Input cells &middot; one per opened reading</Band>
          {reveals.map((r, i) => (
            <div key={`${r.feedId}:${i}`} style={ROW}>
              <span className="text-muted" style={{ width: 24 }}>[{i}]</span>
              <span className="tabular" style={{ width: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{instances[i]?.toString() ?? '—'}</span>
              <span className="text-muted">&larr;</span>
              <span style={{ width: 140 }}>{r.value.toString()}</span>
              <span className="text-muted">feed {shortHash(r.feedId, 4)}</span>
            </div>
          ))}
          <Band>Output cells</Band>
          {outputs.map((o, i) => (
            <div key={`out:${i}`} style={ROW}>
              <span className="text-muted" style={{ width: 24 }}>[{nIn + i}]</span>
              <span className="tabular" style={{ width: 200 }}>{o.toString()}</span>
            </div>
          ))}
          {outputs.length === 0 && <div style={{ ...ROW, color: 'var(--text-subtle)' }}>none — every instance cell is an input</div>}
        </div>
        <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>
          The left column is the field element the circuit was proved against; the right is the
          signed reading the agent opened, which the publishers had already signed as a hash. The
          adapter recomputes the left from the right, which is what stops a valid proof over inputs
          the agent chose for itself.
        </p>
      </section>

      <section style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-4)' }}>
        <h6 style={{ marginBottom: 'var(--space-2)' }}>Why the commitments are not in the circuit</h6>
        <p style={{ fontSize: 13, margin: 0 }}>halo2 cannot compute keccak without a gadget <code>ezkl</code> does not expose. Binding on chain costs 6 gas a word and checks against the router&apos;s own storage instead of against a number the prover chose.</p>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Verification actions</h6>
        {adapter && agent ? (
          <VerifyActions
            network={network}
            adapter={adapter}
            ctx={{
              requestId: request.requestId,
              agentId: request.agentId.toString(),
              modelCommitment: agent.modelCommitment,
              inputCommitment: request.inputCommitment,
              outputCommitment: request.outputCommitment,
              deliverBy: request.deliverBy.toString(),
              operator: agent.operator,
            }}
            reveals={reveals.map((r) => ({
              feedId: r.feedId,
              timestamp: r.timestamp.toString(),
              value: r.value.toString(),
              salt: r.salt,
            }))}
            outputs={outputs.map((o) => o.toString())}
            expected={{ input: request.inputCommitment, output: request.outputCommitment }}
            attestation={delivery.proof.attestation}
            bundle={{
              requestId,
              agentId: request.agentId.toString(),
              modelCommitment: agent.modelCommitment,
              proof: bytes,
              instances: instances.map((i) => i.toString()),
              reveals: reveals.map((r) => ({ feedId: r.feedId, timestamp: r.timestamp.toString(), value: r.value.toString(), salt: r.salt })),
            }}
          />
        ) : (
          <p className="text-muted" style={{ fontSize: 13 }}>
            The adapter or the agent record could not be read, so the re-verification call cannot be
            assembled. The proof is still downloadable from the execution&apos;s delivery
            transaction.
          </p>
        )}
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Circuit identity</h6>
        <div className="stat-strip" style={{ ['--cols' as string]: 3, fontFamily: 'var(--font-mono)', fontSize: 12 } as React.CSSProperties}>
          <Cell label="MODEL COMMITMENT" val={agent ? shortHash(agent.modelCommitment, 8) : '—'} />
          <Cell
            label="VERIFIER"
            val={verifier ? <a href={explorerLink(network, 'address', verifier)} target="_blank" rel="noopener noreferrer">{shortHash(verifier, 6)}</a> : '—'}
          />
          <Cell label="INSTANCE CELLS" val={`${instances.length} (${nIn} in)`} />
        </div>
        <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>A change to any spec field means a new circuit, a new verifying key and a new agent id.</p>
      </section>
    </main>
  );
}

const ROW: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '6px var(--space-3)',
  borderBottom: '1px solid var(--color-divider)',
  alignItems: 'baseline',
  whiteSpace: 'nowrap',
};

function Band({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-subtle)', borderBottom: '1px solid var(--color-divider)' }}>
      {children}
    </div>
  );
}

function Bare({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: 'var(--space-6)', maxWidth: '60ch', color: 'var(--text-muted)', fontSize: 14 }}>
      <h1 style={{ fontSize: 26, marginBottom: 'var(--space-3)', color: 'var(--text-body)' }}>Proof inspector</h1>
      {children}
    </main>
  );
}

// No `border` prop: .stat-strip owns the dividers, and on a phone it puts them between rows.
function Cell({ label, val }: { label: string; val: React.ReactNode }) {
  return (
    <div style={{ padding: 'var(--space-3)', overflowWrap: 'anywhere' }}>
      <div className="text-muted" style={{ fontSize: 10 }}>{label}</div>{val}
    </div>
  );
}
