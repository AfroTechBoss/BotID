// CSV and PDF exports of the Transactions table.
//
// Both export exactly the rows the reader has filtered to, across every page rather than only the
// one on screen. Built in the browser from data the page already holds: nothing is sent anywhere,
// and the file is what the chain said at the moment the button was pressed.
//
// The PDF library is imported on demand. It is a few hundred kilobytes that nobody who does not
// press the button should download.

import type { ProtocolTx, TxDetails } from './transactions';
import { explorerLink } from './chain';
import type { NetworkId } from './network';

export interface ExportRow {
  time: string;
  block: string;
  tx: string;
  type: string;
  summary: string;
  events: string;
  agent: string;
  request: string;
  from: string;
  sender: string;
  explorer: string;
}

export interface ExportMeta {
  network: NetworkId;
  networkName: string;
  /** What the reader had selected, so a file says which slice of history it is. */
  filterLabel: string;
  query: string;
}

const KIND_LABEL: Record<ProtocolTx['kind'], string> = {
  execution: 'Execution',
  fault: 'Fault',
  agent: 'Agent',
  bond: 'Bond',
  reputation: 'Reputation',
  admin: 'Protocol setup',
};

/** UTC, ISO-like, minute precision. A file outlives the reader's timezone. */
const stamp = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '');

export function toExportRows(
  txs: ProtocolTx[],
  details: Map<string, TxDetails>,
  owner: string | undefined,
  network: NetworkId
): ExportRow[] {
  return txs.map((t) => {
    const d = details.get(t.hash);
    const from = d?.from ?? '';
    return {
      time: stamp(d?.time),
      block: t.block.toString(),
      tx: t.hash,
      type: KIND_LABEL[t.kind],
      summary: t.headline.detail,
      events: t.events.map((e) => `${e.contract}.${e.name}: ${e.detail}`).join(' | '),
      agent: t.events.find((e) => e.agentId !== undefined)?.agentId?.toString() ?? '',
      request: t.events.find((e) => e.requestId)?.requestId ?? '',
      from,
      sender: !from ? '' : owner && from.toLowerCase() === owner ? 'Protocol owner' : 'User wallet',
      explorer: explorerLink(network, 'tx', t.hash),
    };
  });
}

const COLUMNS: [keyof ExportRow, string][] = [
  ['time', 'Time (UTC)'],
  ['block', 'Block'],
  ['tx', 'Transaction'],
  ['type', 'Type'],
  ['summary', 'What happened'],
  ['agent', 'Agent'],
  ['request', 'Request'],
  ['from', 'From'],
  ['sender', 'Sender'],
  ['events', 'All events'],
  ['explorer', 'Explorer'],
];

function fileBase(meta: ExportMeta) {
  const day = new Date().toISOString().slice(0, 10);
  return `botid-transactions-${meta.network}-${day}`;
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * RFC 4180 quoting. A leading =, +, - or @ is prefixed with an apostrophe so a spreadsheet opens a
 * summary like "-120 bps" as text rather than evaluating it as a formula.
 */
function cell(v: string) {
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function exportCsv(rows: ExportRow[], meta: ExportMeta) {
  const lines = [
    COLUMNS.map(([, h]) => cell(h)).join(','),
    ...rows.map((r) => COLUMNS.map(([k]) => cell(r[k])).join(',')),
  ];
  // BOM so Excel reads the file as UTF-8 and the arrows and ellipses survive.
  download(`${fileBase(meta)}.csv`, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
}

export async function exportPdf(rows: ExportRow[], meta: ExportMeta) {
  const [{ jsPDF }, plugin] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  // The ESM build exports the function as default; a CommonJS interop layer can nest it one level
  // deeper. Resolving both keeps the button working whichever build the bundler picked.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoTable = ((plugin as any).default?.default ?? (plugin as any).default ?? plugin) as typeof plugin.default;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(16);
  doc.text('BotID Protocol: transactions', 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(110);
  const scope = [meta.filterLabel, meta.query && `search "${meta.query}"`].filter(Boolean).join(', ');
  doc.text(
    `${meta.networkName} · ${rows.length} ${rows.length === 1 ? 'transaction' : 'transactions'} · ${scope} · generated ${stamp(Date.now())}`,
    40,
    56
  );

  // The PDF is for reading, so it drops the columns that only make sense in a spreadsheet (the
  // full event list and the explorer URL) and shortens hashes to what a person can compare by eye.
  const short = (h: string, n = 6) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
  autoTable(doc, {
    startY: 70,
    head: [['Time (UTC)', 'Type', 'What happened', 'Agent', 'From', 'Sender', 'Transaction']],
    body: rows.map((r) => [r.time || `block ${r.block}`, r.type, r.summary, r.agent ? `#${r.agent}` : '', short(r.from, 4), r.sender, short(r.tx)]),
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [32, 30, 29], textColor: 255 },
    columnStyles: { 2: { cellWidth: 300 } },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      const page = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(`Page ${page}`, doc.internal.pageSize.getWidth() - 80, doc.internal.pageSize.getHeight() - 20);
    },
  });

  doc.save(`${fileBase(meta)}.pdf`);
}
