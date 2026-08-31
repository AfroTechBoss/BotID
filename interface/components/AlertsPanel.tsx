'use client';
// Subscribe to an alert about an agent.
//
// The panel this replaces was a disabled sketch with a note saying nobody watches a score you are
// not looking at. That is now only half true, and the half that changed is worth stating plainly on
// screen rather than in a commit message: alerts fire from a daemon the operator of this deployment
// runs, not from the chain. Nothing here is trustless. If the daemon is down you get silence, and
// silence is indistinguishable from nothing having happened — which is why the panel says so.
//
// Signing rather than logging in. There is no account to make: the subscription is filed under the
// address that signed for it, the wallet renders the fields before signing them, and the same
// signature scheme takes it away again. See lib/alerts.ts for the typed data, and
// app/api/alerts/route.ts for what the server checks before it stores anything.

import { useCallback, useEffect, useState } from 'react';
import type { Address, WalletClient } from 'viem';
import {
  ALERT_KINDS,
  ALERT_KIND_LABEL,
  ALERT_SIGNATURE_TTL_SECONDS,
  ALERT_TYPES,
  SCORE_KINDS,
  UNSUBSCRIBE_TYPES,
  alertDomain,
  alertNonce,
  type AlertKind,
} from '@/lib/alerts';
import type { NetworkId } from '@/lib/network';

interface Subscription {
  id: number;
  agentId: string;
  kind: AlertKind;
  threshold: number | null;
  webhookOrigin: string | null;
  disabledAt: string | null;
  failureCount: number;
  lastError: string | null;
}

interface Props {
  network: NetworkId;
  chainId: number;
  registry: Address | undefined;
  address: Address | undefined;
  walletClient: WalletClient | undefined;
  onSelectedChain: boolean;
  /** The agent the portal has selected, prefilled so the common case is two fields and a button. */
  defaultAgentId?: bigint;
}

export default function AlertsPanel({
  network,
  chainId,
  registry,
  address,
  walletClient,
  onSelectedChain,
  defaultAgentId,
}: Props) {
  const [agentId, setAgentId] = useState('');
  const [kind, setKind] = useState<AlertKind>('challenge');
  const [threshold, setThreshold] = useState('5000');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [subs, setSubs] = useState<Subscription[]>([]);
  // undefined until we have asked. The interface cannot read DATABASE_URL — it is a server
  // variable — so "is this deployment wired for alerts" is a question only the route can answer,
  // and it answers it with a 503 rather than by exposing configuration to the browser.
  const [configured, setConfigured] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [secret, setSecret] = useState<string | undefined>();

  useEffect(() => {
    if (defaultAgentId !== undefined) setAgentId(String(defaultAgentId));
  }, [defaultAgentId]);

  const refresh = useCallback(async () => {
    if (!address) {
      setSubs([]);
      return;
    }
    try {
      const res = await fetch(`/api/alerts?network=${network}&subscriber=${address}`, { cache: 'no-store' });
      if (res.status === 503) {
        setConfigured(false);
        return;
      }
      setConfigured(true);
      const body = await res.json();
      setSubs(res.ok ? (body.subscriptions ?? []) : []);
    } catch {
      // A failed probe is not a configuration answer. Leaving it undefined keeps the form enabled
      // rather than telling someone their deployment lacks a database because their wifi blinked.
      setSubs([]);
    }
  }, [address, network]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const needsThreshold = SCORE_KINDS.includes(kind);
  const idValid = /^\d+$/.test(agentId.trim()) && BigInt(agentId.trim() || '0') > 0n;
  const ready = Boolean(walletClient && address && registry && onSelectedChain && configured !== false);

  async function signed<T extends Record<string, unknown>>(
    types: typeof ALERT_TYPES | typeof UNSUBSCRIBE_TYPES,
    primaryType: 'AlertSubscription' | 'AlertUnsubscribe',
    message: T,
  ) {
    if (!walletClient || !address) throw new Error('no wallet');
    // Cast, in the same spirit as the writeContract calls in the portal. A bare WalletClient
    // carries no account or chain in its type, so viem narrows signTypedData's parameter to
    // `never` and every call is an error. The runtime call is ordinary; only the inference is not.
    const sign = walletClient.signTypedData as (args: {
      account: Address;
      domain: ReturnType<typeof alertDomain>;
      types: unknown;
      primaryType: string;
      message: unknown;
    }) => Promise<`0x${string}`>;
    return sign({ account: address, domain: alertDomain(chainId), types, primaryType, message });
  }

  async function subscribe() {
    if (!registry || !address) return;
    setBusy(true);
    setError(undefined);
    setSecret(undefined);
    try {
      const message = {
        registry,
        agentId: BigInt(agentId.trim()),
        kind,
        threshold: needsThreshold ? Number(threshold) : 0,
        webhookUrl: webhookUrl.trim(),
        nonce: alertNonce(),
        expiry: BigInt(Math.floor(Date.now() / 1000) + ALERT_SIGNATURE_TTL_SECONDS),
      };
      const signature = await signed(ALERT_TYPES, 'AlertSubscription', message);
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          network,
          subscriber: address,
          ...message,
          agentId: message.agentId.toString(),
          expiry: message.expiry.toString(),
          signature,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setSecret(body.deliverySecret);
      setWebhookUrl('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe(sub: Subscription) {
    if (!registry || !address) return;
    setBusy(true);
    setError(undefined);
    try {
      const message = {
        registry,
        agentId: BigInt(sub.agentId),
        kind: sub.kind,
        threshold: sub.threshold ?? 0,
        nonce: alertNonce(),
        expiry: BigInt(Math.floor(Date.now() / 1000) + ALERT_SIGNATURE_TTL_SECONDS),
      };
      const signature = await signed(UNSUBSCRIBE_TYPES, 'AlertUnsubscribe', message);
      const res = await fetch('/api/alerts', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          network,
          subscriber: address,
          ...message,
          agentId: message.agentId.toString(),
          expiry: message.expiry.toString(),
          signature,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 style={{ fontSize: 20 }}>Alerts</h2>
      <p style={{ fontSize: 12 }} className="text-muted">
        A webhook when something happens to an agent you care about. The one that pays for itself is{' '}
        <strong>Delivery challenged</strong>: the escalation window is six hours, and an agent that does not answer
        inside it is slashed whether or not it was watching.
      </p>
      <p style={{ fontSize: 12 }} className="text-muted">
        These fire from a daemon, not from the chain. If it is down you get silence, and silence looks exactly like
        nothing having happened — so treat an alert as a convenience, never as the thing you rely on.
      </p>

      {configured === false ? (
        <div style={{ border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', fontSize: 12, marginTop: 'var(--space-3)' }}>
          This deployment has no alerts database configured, so nothing can be stored. The rest of the portal is
          unaffected.
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <div className="field">
          <label>Agent id</label>
          <input
            className="input"
            placeholder="1"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={!ready || busy}
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label>Tell me when</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as AlertKind)} disabled={!ready || busy}>
            {ALERT_KINDS.map((k) => (
              <option key={k} value={k}>
                {ALERT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {needsThreshold ? (
          <div className="field">
            <label>Score threshold</label>
            <input
              className="input"
              type="number"
              min={0}
              max={10000}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              disabled={!ready || busy}
            />
            {/* Crossings, not conditions. A score already below the threshold does not fire on every
                sweep — it fires when it crosses, which is the difference between an alert and a
                stuck alarm. Decay alone can cause a crossing with no transaction anywhere. */}
            <p style={{ fontSize: 11, marginTop: 'var(--space-1)' }} className="text-muted">
              Fires on the crossing, once, in basis points of 10,000. Score decays over time, so this can fire with no
              transaction on chain at all.
            </p>
          </div>
        ) : null}
        <div className="field">
          <label>Webhook URL</label>
          <input
            className="input"
            placeholder="https://…"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            disabled={!ready || busy}
            spellCheck={false}
          />
          <p style={{ fontSize: 11, marginTop: 'var(--space-1)' }} className="text-muted">
            https only, and it must resolve to a public address. Each delivery carries an HMAC of the body under a
            secret shown to you once, below — check it, or anyone who learns the URL can forge an alert.
          </p>
        </div>
        <button
          className="btn btn-secondary btn-block"
          disabled={!ready || busy || !idValid || !webhookUrl.trim()}
          onClick={() => void subscribe()}
        >
          {busy ? 'Signing…' : 'Sign and save alert'}
        </button>
        {!address ? (
          <p style={{ fontSize: 12, margin: 0 }} className="text-muted">
            Connect a wallet — the subscription is filed under the address that signs it.
          </p>
        ) : null}
        {error ? (
          <p style={{ fontSize: 12, margin: 0, color: 'var(--color-negative)' }}>{error}</p>
        ) : null}
        {secret ? (
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', fontSize: 12 }}>
            <strong>Delivery secret — shown once.</strong>
            <div style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono, monospace)', marginTop: 'var(--space-2)' }}>
              {secret}
            </div>
            <p style={{ marginTop: 'var(--space-2)', marginBottom: 0 }} className="text-muted">
              Deliveries arrive with <code>x-botid-signature</code>, the hex HMAC-SHA256 of the raw body under this
              secret. Saving the alert again issues a new secret and replaces this one.
            </p>
          </div>
        ) : null}
      </div>

      {subs.length > 0 ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <h3 style={{ fontSize: 14 }}>Your alerts on {network}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            {subs.map((sub) => (
              <div
                key={sub.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  border: '1px solid var(--color-divider)',
                  padding: 'var(--space-2)',
                  fontSize: 12,
                }}
              >
                <div>
                  <div>
                    Agent {sub.agentId} — {ALERT_KIND_LABEL[sub.kind]}
                    {sub.threshold === null ? '' : ` ${sub.threshold}`}
                  </div>
                  <div className="text-muted">
                    {sub.webhookOrigin ?? 'unknown endpoint'}
                    {sub.disabledAt
                      ? ` — disabled after ${sub.failureCount} failures${sub.lastError ? `: ${sub.lastError}` : ''}. Save it again to re-enable.`
                      : sub.failureCount > 0
                        ? ` — ${sub.failureCount} recent failures`
                        : ''}
                  </div>
                </div>
                <button className="btn btn-secondary" disabled={busy || !ready} onClick={() => void unsubscribe(sub)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
