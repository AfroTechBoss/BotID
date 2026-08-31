// The shape of an alert subscription, shared by the form that signs one and the route that
// verifies it. No node imports and no database imports here — the portal is a client component and
// must be able to import this to build the typed data it asks the wallet to sign.
//
// Authentication is a signature rather than an account. There is no password to reset, no session
// to steal and no user table to breach, and the thing being proved is the only thing that matters:
// that whoever asked for this alert controls the address the row is filed under. That is also why
// the write path is EIP-712 rather than a bare `personal_sign` of a sentence — the wallet renders
// the fields, so a signer sees the agent id and the URL they are authorising rather than a hash.
//
// Note what is NOT checked: ownership of the agent. A score is public and watching it is nobody's
// business but the watcher's — a consumer deciding whether to keep hiring an agent has exactly as
// much right to be told its score fell as the agent's owner does. The signature identifies who the
// row belongs to, so a subscriber can only ever list or delete their own.

import type { TypedDataDomain } from 'viem';

export const ALERT_KINDS = ['fault', 'challenge', 'score_below', 'score_above', 'unbonding'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Kinds that carry a threshold. The database CHECK enforces the same split; this mirrors it. */
export const SCORE_KINDS: readonly AlertKind[] = ['score_below', 'score_above'];

export function isAlertKind(value: unknown): value is AlertKind {
  return typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value);
}

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  fault: 'Fault or slash recorded',
  challenge: 'Delivery challenged',
  score_below: 'Score falls below',
  score_above: 'Score rises above',
  unbonding: 'Unbonding started',
};

/**
 * How long a signed request stays good.
 *
 * Long enough that a signer who walks away mid-flow comes back to a working form, short enough
 * that a signature captured off a screen share is stale by the time it is useful. The nonce is
 * what actually prevents replay; the expiry is what bounds how long a stolen one is worth having.
 */
export const ALERT_SIGNATURE_TTL_SECONDS = 15 * 60;

// No verifyingContract. This is not a protocol contract and there is no address that could
// legitimately go here — inventing one would imply an on-chain counterparty that does not exist.
// The chainId still binds the signature to a deployment, which is what stops a testnet signature
// being replayed against mainnet rows.
export function alertDomain(chainId: number): TypedDataDomain {
  return { name: 'BotID Alerts', version: '1', chainId };
}

export const ALERT_TYPES = {
  AlertSubscription: [
    { name: 'registry', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'threshold', type: 'uint32' },
    { name: 'webhookUrl', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export const UNSUBSCRIBE_TYPES = {
  AlertUnsubscribe: [
    { name: 'registry', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'threshold', type: 'uint32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export interface AlertMessage {
  registry: `0x${string}`;
  agentId: bigint;
  kind: AlertKind;
  /** Zero for kinds that do not use one. The database stores null; the signature cannot. */
  threshold: number;
  webhookUrl: string;
  nonce: `0x${string}`;
  expiry: bigint;
}

/**
 * The threshold as the database wants it.
 *
 * A signature has to cover a concrete number — there is no null in the ABI encoding — so a
 * non-score kind signs zero. Storing that zero would make `score_below 0` and `fault` look alike
 * to the unique index and would violate the CHECK besides, so it becomes null on the way in.
 */
export function thresholdForStorage(kind: AlertKind, threshold: number): number | null {
  return SCORE_KINDS.includes(kind) ? threshold : null;
}

/** A 32-byte random nonce, from whichever crypto the caller happens to have. */
export function alertNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
}
