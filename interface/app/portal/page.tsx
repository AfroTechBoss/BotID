'use client';
import { useState } from 'react';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

export default function Portal() {
  const [tier, setTier] = useState<'bronze' | 'silver' | 'gold'>('silver');
  const [bond, setBond] = useState(100000);
  const lev = { bronze: 2.5, silver: 4.2, gold: 6 }[tier];
  const credit = Math.round(bond * lev);
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M WBOT` : `${(n / 1e3).toFixed(0)}k WBOT`);

  return (
    <>
      <Nav current="/portal" />
      <main style={{ padding: 'var(--space-6)', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
        <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', fontSize: 13 }}>
          Connect a wallet to register an agent or manage a bond. Reads above are public &mdash; nothing here required a wallet until now.
        </div>

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
            <div style={{ borderTop: '2px solid var(--color-divider)', borderBottom: '2px solid var(--color-divider)', padding: 'var(--space-3)', display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 14 }}>
              <span className="text-muted">resulting credit line</span>
              <span style={{ fontWeight: 700 }}>{fmt(credit)} max open notional</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--score-critical)' }}>Unbonding takes 21 days once requested. Read this before you post capital, not after.</p>
            <button className="btn btn-primary btn-block">Register agent</button>
          </div>
        </section>

        <div className="hr" />

        <section>
          <h2 style={{ fontSize: 20 }}>Bond management</h2>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary">Deposit</button>
            <button className="btn btn-secondary">Request unbond</button>
            <button className="btn btn-secondary">Withdraw</button>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Unbonding queue</div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {['Requested', 'Day 7', 'Day 14', 'Day 21 \u2014 withdrawable'].map((label, i) => (
                <div key={label} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ height: 4, background: i === 0 ? 'var(--color-accent)' : 'var(--color-neutral-300)' }} />
                  <div style={{ fontSize: 11, marginTop: 4 }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="hr" />

        <section>
          <h2 style={{ fontSize: 20 }}>Alerts</h2>
          <p style={{ fontSize: 12 }} className="text-muted">Client-side subscription &mdash; fires only while this tab is open. No server watches on your behalf yet.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            <div className="field"><label>Webhook URL</label><input className="input" placeholder="https://&hellip;" /></div>
            <div className="field"><label>Score threshold</label><input className="input" type="number" defaultValue={5000} /></div>
            <button className="btn btn-secondary btn-block">Save alert</button>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
