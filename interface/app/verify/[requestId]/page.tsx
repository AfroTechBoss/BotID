import type { Metadata } from 'next';
import Link from 'next/link';
import { getExecution, shortHash } from '@/lib/mock-data';
import VerifyActions from './VerifyActions';
import SampleData from '@/components/SampleData';

// Server component for the same reason as the execution receipt: this page is an argument about a
// specific proof, and an argument that only exists after JavaScript runs is one a link preview,
// a crawler and a reader on a bad connection never see.

export function generateMetadata({ params }: { params: { requestId: string } }): Metadata {
  return {
    title: `Proof ${shortHash(params.requestId)}`,
    description: 'Groth16 instance vector, commitment openings and the command to re-verify it yourself.',
  };
}

export default function ProofInspector({ params }: { params: { requestId: string } }) {
  const { requestId } = params;
  const e = getExecution(requestId);

  const inputCells = [
    { i: 0, raw: '3,200,000', decoded: '12,500 BOT/USD', hash: '0x8f2a…' },
    { i: 1, raw: '8,704,000', decoded: '34,000 ETH/USD', hash: '0x1c4b…' },
    { i: 2, raw: '1,075,200', decoded: '4,200 BTC/USD', hash: '0x77de…' },
  ];
  const outputCells = [
    { i: 3, raw: '0', decoded: '0 bps' },
    { i: 4, raw: '2,560,000', decoded: '10,000 bps' },
    { i: 5, raw: '0', decoded: '0 bps' },
  ];
  const command = 'ezkl verify --proof proof.json --settings settings.json --vk vk.key';

  return (
    // Uncapped. The instance vector and the verify command are long mono strings that were
    // wrapping mid-hash at 860px, which is the one place wrapping actively costs the reader
    // something: a hash you have to mentally rejoin is a hash you cannot check by eye.
    <main style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <SampleData what="This proof and the record around it" />
      <div>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Proof inspector</h1>
        <div className="text-muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          requestId <Link href={`/executions/${requestId}`}>{shortHash(requestId)}</Link> &middot; agent #{e.agent.id} &middot; circuit botid.reference-allocator.v1
        </div>
      </div>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
          Instance vector <span style={{ textTransform: 'none', letterSpacing: 0 }}>&mdash; split at n<sub>in</sub>=3</span>
        </h6>
        {/* Scrolls sideways on a narrow screen instead of wrapping. Every row here is a fixed
            column of cells — [i], the raw felt, the decoded value, the opening — and the whole
            point is that they line up so a reader can check one against the next. Wrapping the
            columns would break the alignment that is the artifact. */}
        <div className="table-scroll" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)' }}>
          <div style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-subtle)', borderBottom: '1px solid var(--color-divider)' }}>Input cells &middot; value &laquo; 8</div>
          {inputCells.map((c) => (
            <div key={c.i} style={{ display: 'flex', gap: 10, padding: '6px var(--space-3)', borderBottom: '1px solid var(--color-divider)', alignItems: 'baseline', whiteSpace: 'nowrap' }}>
              <span className="text-muted" style={{ width: 24 }}>[{c.i}]</span>
              <span className="tabular" style={{ width: 110 }}>{c.raw}</span>
              <span className="text-muted">&larr;</span>
              <span style={{ width: 140 }}>{c.decoded}</span>
              <span style={{ color: 'var(--score-good)' }}>&#10003; opens {c.hash}</span>
            </div>
          ))}
          <div style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-subtle)', borderBottom: '1px solid var(--color-divider)' }}>Output cells</div>
          {outputCells.map((c) => (
            <div key={c.i} style={{ display: 'flex', gap: 10, padding: '6px var(--space-3)', borderBottom: '1px solid var(--color-divider)', alignItems: 'baseline', whiteSpace: 'nowrap' }}>
              <span className="text-muted" style={{ width: 24 }}>[{c.i}]</span>
              <span className="tabular" style={{ width: 110 }}>{c.raw}</span>
              <span className="text-muted">&rarr;</span>
              <span>{c.decoded}</span>
            </div>
          ))}
          <div style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 11 }}>keccak256(abi.encode(outputs)) = 0x3f8c&hellip; <span style={{ color: 'var(--score-good)' }}>&#10003; matches outputCommitment</span></div>
        </div>
      </section>

      <section style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-4)' }}>
        <h6 style={{ marginBottom: 'var(--space-2)' }}>Why the commitments are not in the circuit</h6>
        <p style={{ fontSize: 13, margin: 0 }}>halo2 cannot compute keccak without a gadget <code>ezkl</code> does not expose. Binding on chain costs 6 gas a word and checks against the router&apos;s own storage instead of against a number the prover chose.</p>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Verification actions</h6>
        <VerifyActions command={command} verifiedAtBlock={e.blocks.settle + 12} />
        <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--color-surface)', padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-divider)' }}>{command}</div>
      </section>

      <section>
        <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Circuit identity</h6>
        <div className="stat-strip" style={{ ['--cols' as string]: 3, fontFamily: 'var(--font-mono)', fontSize: 12 } as React.CSSProperties}>
          <Cell label="MODEL COMMITMENT" val={shortHash(e.agent.modelCommitment, 8)} />
          <Cell label="VERIFIER" val={`0x9c1e${'0'.repeat(36)}`} />
          <Cell label="INPUT SCALE" val="8 bits" />
        </div>
        <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>A change to any spec field means a new circuit, a new verifying key and a new agent id.</p>
      </section>
    </main>
  );
}

// No `border` prop: .stat-strip owns the dividers, and on a phone it puts them between rows.
function Cell({ label, val }: { label: string; val: string }) {
  return (
    <div style={{ padding: 'var(--space-3)', overflowWrap: 'anywhere' }}>
      <div className="text-muted" style={{ fontSize: 10 }}>{label}</div>{val}
    </div>
  );
}
