// Loading placeholders shaped like the thing that replaces them.
//
// No 'use client': these are static markup with no state and no handlers, so they render on the
// server and cost nothing in the bundle. The pages that use them are client components for other
// reasons, which is fine — a server component can be imported into one.
//
// Everything here is aria-hidden and sits inside a container the caller marks aria-busy. A screen
// reader should hear "loading", once, from the region — not eleven grey rectangles described one at
// a time. The visual and the announcement are different channels carrying the same fact.

/** One bar. `w` is any CSS length; a percentage is measured against the cell it sits in. */
export function Bar({ w = '100%', h = '1em' }: { w?: string | number; h?: string | number }) {
  return <span className="skel" style={{ width: w, height: h }} aria-hidden="true" />;
}

/**
 * A table body of placeholder rows.
 *
 * `widths` is one entry per column, and the reason it is a parameter rather than a uniform fill is
 * that a leaderboard's columns are wildly different shapes — a rank is two characters and an agent
 * cell is a badge over two lines. Bars of the right width make the skeleton recognisable as *this*
 * table rather than as a generic loading state, and mean the real rows land at the same height.
 */
export function TableSkeleton({ rows = 3, widths }: { rows?: number; widths: (string | number)[] }) {
  return (
    <tbody aria-busy="true">
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {widths.map((w, c) => (
            <td key={c}><Bar w={w} /></td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * A block of stacked bars, for prose and figure groups.
 *
 * The last line is short, because a paragraph's last line is. It is a small thing and it is the
 * difference between a block that reads as text and one that reads as a grey rectangle.
 */
export function LinesSkeleton({ lines = 3, w = '100%' }: { lines?: number; w?: string }) {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: w }}>
      {Array.from({ length: lines }, (_, i) => (
        <Bar key={i} w={i === lines - 1 ? '55%' : '100%'} />
      ))}
    </div>
  );
}
