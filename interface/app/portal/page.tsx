'use client';
import { useState } from 'react';

type Tier = 'bronze' | 'silver' | 'gold';

// Mirrors AgentRegistry. This panel used to read `{ bronze: 2.5, silver: 4.2, gold: 6 }[tier]`,
// which made leverage look like a property of the tier — it is not, and the error flattered the
// form badly: it promised a new Silver agent 4.2x when the contract gives it 1.0x.
//
// Leverage is a step function of *score*; tier only multiplies it. A registering agent has no
// history, so it starts at NEUTRAL and gets the second band. Keeping the two functions separate
// here, with the contract's bps units intact, is deliberate: the next person to compare this
// against AgentRegistry.sol should be able to do it line by line.
const NEUTRAL_SCORE = 5_000;
const MIN_BOND = 500;
const GLOBAL_NOTIONAL_CAP = 5_000_000;

function leverageBps(score: number): number {
  if (score < 5_000) return 5_000; // 0.5x — below neutral, undercollateralised is off
  if (score < 7_000) return 10_000; // 1.0x
  if (score < 8_500) return 20_000; // 2.0x
  if (score < 9_500) return 40_000; // 4.0x
  return 60_000; // 6.0x — the cap
}

const TIER_FACTOR_BPS: Record<Tier, number> = { bronze: 5_000, silver: 10_000, gold: 15_000 };

/** bond × leverage(score) × tierFactor(tier), zero below minBond, clamped to the global cap. */
function maxOpenNotional(bond: number, score: number, tier: Tier): number {
  if (bond < MIN_BOND) return 0; // below the floor the answer is zero, not a small number
  const notional = (bond * leverageBps(score) * TIER_FACTOR_BPS[tier]) / 1e8;
  return Math.min(Math.round(notional), GLOBAL_NOTIONAL_CAP);
}

// Rendered twice — once as track segments, once as labels — so it lives here rather than inline.
const UNBONDING_STEPS = ['Requested', 'Day 7', 'Day 14', 'Day 21 — withdrawable'] as const;

const multiple = (score: number, tier: Tier) =>
  (leverageBps(score) * TIER_FACTOR_BPS[tier]) / 1e8;

export default function Portal() {
  const [tier, setTier] = useState<Tier>('silver');
  const [bond, setBond] = useState(100000);
  const credit = maxOpenNotional(bond, NEUTRAL_SCORE, tier);
  const capped = credit === GLOBAL_NOTIONAL_CAP;
  const best = maxOpenNotional(bond, 10_000, tier);
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M WBOT` : `${(n / 1e3).toFixed(0)}k WBOT`);

  return (
    <>
      {/* Full width, and the three panels run across it rather than down a single 720px column.
          The cap was defensible while this was one stacked form — a 1490px text input is as wrong
          as a 1490px paragraph — but that argument only ever justified narrow *inputs*, not a
          narrow page. As columns the fields stay the width a field should be and the screen is
          used: registration, bond management and alerts are three independent tasks, and putting
          them side by side means the unbonding queue is visible while you size a bond rather than
          two scrolls below it. */}
      <main style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', fontSize: 13 }}>
          Connect a wallet to register an agent or manage a bond. Reads above are public &mdash; nothing here required a wallet until now.
        </div>

        {/* 340px floor: the register panel's segmented tier control and its credit-line readout are
            the widest things here, and they start wrapping below that. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 'var(--space-8)', alignItems: 'start' }}>
        <section>
          <h2 style={{ fontSize: 20 }}>Register an agent</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            <div className="field"><label>Operator address</label><input className="input" placeholder="0x&hellip;" /></div>
            <div className="field"><label>Model commitment</label><input className="input" placeholder="0x&hellip;" /></div>
            <div className="field">
              <label>Tier</label>
              <span className="seg">
                {(['bronze', 'silver', 'gold'] as const).map((t) => (
                  <label key={t} className="seg-opt"><input type="radio" checked={tier === t} onChange={() => setTier(t)} />{t[0].toUpperCase() + t.slice(1)}</label>
                ))}
              </span>
            </div>
            <div className="field"><label>Loss tolerance (bps)</label><input className="input" type="number" defaultValue={500} /></div>
            <div className="field">
              <label>Bond ({fmt(bond)})</label>
              <input type="range" min={5000} max={500000} step={5000} value={bond} onChange={(e) => setBond(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            {/* Labelled with the score it is computed at. An unlabelled credit line is how the old
                tier-keyed number passed unnoticed — it looked like a fact about the tier. */}
            <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <span className="text-muted">credit line at registration</span>
                <span style={{ fontWeight: 700 }}>{fmt(credit)} max open notional</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', fontSize: 12 }}>
                <span className="text-muted">score 5,000 (neutral) &times; {tier}</span>
                <span className="text-muted">{multiple(NEUTRAL_SCORE, tier)}&times; bond</span>
              </div>
            </div>
            <p style={{ fontSize: 12, margin: 0 }} className="text-muted">
              Leverage is a step function of score; the tier only multiplies it. A new agent starts at
              5,000 with no history either way, so this is the floor rather than the number you keep.
              Earn a score of 9,500 or above and this tier reaches {multiple(10_000, tier)}&times; &mdash;{' '}
              {fmt(best)}{capped ? ', at the global cap' : ''}. See <a href="/docs#credit">the credit table</a>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--score-critical)' }}>Unbonding takes 21 days once requested. Read this before you post capital, not after.</p>
            <button className="btn btn-primary btn-block">Register agent</button>
          </div>
        </section>

        {/* The .hr rules that used to sit between these sections are gone: a horizontal rule
            separates things stacked vertically, and these are now side by side. The grid gap
            does that job. */}
        <section>
          <h2 style={{ fontSize: 20 }}>Bond management</h2>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary">Deposit</button>
            <button className="btn btn-secondary">Request unbond</button>
            <button className="btn btn-secondary">Withdraw</button>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Unbonding queue</div>
            {/* Two grid rows, not four flex columns. This was a row of column stacks with
                align-items:center, so each stack held its own bar segment \u2014 and the moment
                "Day 21 \u2014 withdrawable" wrapped to two lines, that column grew, centring pushed
                the three shorter columns down, and the track came apart into four baselines.
                Aligning to flex-start would straighten it today and break again on the next
                label that wraps, or at the next breakpoint where one does. Putting the segments
                on their own grid row makes it structural: the track cannot bend, because no
                label shares a row with it. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', rowGap: 4 }}>
              {UNBONDING_STEPS.map((label, i) => (
                <div key={label} style={{ height: 4, background: i === 0 ? 'var(--color-accent)' : 'var(--color-neutral-300)' }} />
              ))}
              {UNBONDING_STEPS.map((label) => (
                <div key={label} style={{ fontSize: 11, textAlign: 'center', paddingInline: 2 }}>{label}</div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 20 }}>Alerts</h2>
          <p style={{ fontSize: 12 }} className="text-muted">Client-side subscription &mdash; fires only while this tab is open. No server watches on your behalf yet.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            <div className="field"><label>Webhook URL</label><input className="input" placeholder="https://&hellip;" /></div>
            <div className="field"><label>Score threshold</label><input className="input" type="number" defaultValue={5000} /></div>
            <button className="btn btn-secondary btn-block">Save alert</button>
          </div>
        </section>
        </div>
      </main>
    </>
  );
}
