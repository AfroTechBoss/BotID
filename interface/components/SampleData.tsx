/**
 * The marker every fixture-backed page carries.
 *
 * The disclaimer, the terms and /docs all already say this interface runs on generated data. That
 * is not the same as saying it *here*: nobody arrives at a leaderboard by way of the terms page,
 * and a table of agents with scores and settlement counts is read as chain state unless something
 * on the same screen says otherwise. A footnote elsewhere is a defence in a dispute, not an
 * honest label — this is the label.
 *
 * It is deliberately not dismissible and not styled as a warning. It is a caption on the data,
 * true for as long as the data is generated, and it comes off a page the day that page reads the
 * chain instead. That is also why each page mounts it individually rather than the layout mounting
 * it for everyone: /portal and /security show real chain state and must not carry it, and a
 * layout-level banner with a route allowlist would be one edit away from labelling the wrong page.
 */
export default function SampleData({ what }: { what: string }) {
  return (
    <div
      style={{
        border: '1px dashed var(--color-divider)',
        padding: 'var(--space-3)',
        // Its own bottom margin because it mounts into both kinds of <main> here: the ones that are
        // flex columns with a gap, and the ones that are plain blocks. Without it the plain ones put
        // a page heading flush against the banner.
        marginBottom: 'var(--space-4)',
        fontSize: 13,
        display: 'flex',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
        alignItems: 'baseline',
      }}
    >
      <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Sample data
      </strong>
      <span className="text-muted">
        {what} shown here is generated, not read from the chain. Historical views need an indexer and
        there is not one yet. Real chain state lives on <a href="/portal">the portal</a> and{' '}
        <a href="/security">the contract table</a>.
      </span>
    </div>
  );
}
