// Alert subscriptions: the one write in an otherwise read-only API.
//
// Everything else under app/api answers a question about chain state. This stores something, which
// changes what the route has to be careful about — three things, each of which is a way this
// endpoint could be turned against someone:
//
//   who is asking     A signature, not a session. The subscriber address is recovered from an
//                     EIP-712 signature over the exact fields being stored, so a row can only be
//                     filed under an address whose key signed for it. A nonce row makes each
//                     signature single-use; without it, anyone who saw one could replay it.
//   where it points   The webhook URL is dialled later by a server, so it is checked against the
//                     private ranges before it is stored (lib/net.ts). The cloud metadata endpoint
//                     is the target that matters.
//   what it names     The registry must be the one this deployment actually uses and the agent
//                     must exist on chain. Otherwise the table accumulates rows about nothing, and
//                     the daemon spends its sweep reading agents that were never registered.
//
// The route degrades rather than fails when DATABASE_URL is unset: 503 with a plain explanation,
// and the portal renders the form disabled so nobody fills it in first. See lib/db.ts.

import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyTypedData, type Address } from 'viem';
import { CHAINS } from '@/lib/chain';
import { db } from '@/lib/db';
import { registryAddress, readAgent } from '@/lib/registry';
import { checkWebhookUrl } from '@/lib/net';
import type { NetworkId } from '@/lib/network';
import {
  ALERT_TYPES,
  UNSUBSCRIBE_TYPES,
  ALERT_SIGNATURE_TTL_SECONDS,
  SCORE_KINDS,
  alertDomain,
  isAlertKind,
  thresholdForStorage,
  type AlertKind,
} from '@/lib/alerts';
import { fail, json, parseNetwork, preflight } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const METHODS = 'GET, POST, DELETE, OPTIONS';

export function OPTIONS() {
  return preflight(METHODS);
}

/**
 * Response options for this route.
 *
 * Never cached, and never shared: a subscription list is about one address, not about the chain.
 * Only for `json` — `fail` takes its third argument as extra *body* fields and sets no-store
 * itself, so handing it these once put `cache` and `methods` inside every error payload.
 */
const PRIVATE = { cache: 'no-store', methods: METHODS } as const;

interface Common {
  network: NetworkId;
  chainId: number;
  registry: Address;
  subscriber: Address;
  agentId: bigint;
  kind: AlertKind;
  threshold: number;
  nonce: `0x${string}`;
  expiry: bigint;
  signature: `0x${string}`;
}

/**
 * Everything both the subscribe and unsubscribe paths need, validated.
 *
 * Returns a Response on failure rather than throwing, so each check can say precisely which field
 * was wrong. A form that says "invalid request" teaches the person filling it in nothing.
 */
function parseCommon(body: Record<string, unknown>): Common | { error: Response } {
  const url = new URL('http://x/?network=' + encodeURIComponent(String(body.network ?? 'testnet')));
  const net = parseNetwork(url);
  if ('error' in net) return { error: net.error };

  const registry = registryAddress(net.network);
  if (!registry) {
    return { error: fail(404, 'the protocol is not deployed on this network', { network: net.network }) };
  }
  // The signed registry must be the live one. It is in the signature precisely so a subscription
  // cannot outlive the deployment it was made against — every redeploy is a new address set
  // (docs/contract.md §8), and a row pointing at a dead registry would be watched forever.
  const claimed = body.registry;
  if (typeof claimed !== 'string' || !isAddress(claimed) || getAddress(claimed) !== getAddress(registry)) {
    return {
      error: fail(400, 'registry is not the one deployed on this network', { expected: registry, given: claimed }),
    };
  }

  const subscriber = body.subscriber;
  if (typeof subscriber !== 'string' || !isAddress(subscriber)) {
    return { error: fail(400, 'subscriber is not an address', { given: subscriber }) };
  }

  const rawId = String(body.agentId ?? '');
  if (!/^\d+$/.test(rawId) || BigInt(rawId) === 0n) {
    return { error: fail(400, 'agentId must be a positive integer', { given: body.agentId }) };
  }
  const agentId = BigInt(rawId);

  const kind = body.kind;
  if (!isAlertKind(kind)) {
    return { error: fail(400, 'unknown alert kind', { given: kind }) };
  }

  const threshold = Number(body.threshold ?? 0);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10_000) {
    return {
      error: fail(400, 'threshold must be a whole number of basis points, 0 to 10000', { given: body.threshold }),
    };
  }
  // Mirrors the CHECK on alert_subscription: a non-score kind carrying a threshold means the caller
  // has misunderstood what they are subscribing to, and silently dropping it would hide that.
  if (!SCORE_KINDS.includes(kind) && threshold !== 0) {
    return { error: fail(400, `the ${kind} alert does not take a threshold`, { given: threshold }) };
  }

  const nonce = body.nonce;
  if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    return { error: fail(400, 'nonce must be 32 bytes of hex', { given: nonce }) };
  }

  let expiry: bigint;
  try {
    expiry = BigInt(String(body.expiry ?? 0));
  } catch {
    return { error: fail(400, 'expiry must be a unix timestamp', { given: body.expiry }) };
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (expiry <= now) {
    return {
      error: fail(400, 'signature has expired — sign again', { expiry: expiry.toString(), now: now.toString() }),
    };
  }
  // An expiry further out than the window means someone hand-rolled a signature good for a year.
  // The nonce already prevents replay; this bounds how long a captured one is worth keeping.
  if (expiry > now + BigInt(ALERT_SIGNATURE_TTL_SECONDS) + 300n) {
    return { error: fail(400, 'signature expiry is too far in the future', { maxSeconds: ALERT_SIGNATURE_TTL_SECONDS }) };
  }

  const signature = body.signature;
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { error: fail(400, 'signature is missing or malformed') };
  }

  return {
    network: net.network,
    chainId: CHAINS[net.network].id,
    registry: getAddress(registry),
    subscriber: getAddress(subscriber),
    agentId,
    kind,
    threshold,
    nonce: nonce.toLowerCase() as `0x${string}`,
    expiry,
    signature: signature as `0x${string}`,
  };
}

type Sql = NonNullable<ReturnType<typeof db>>;

/**
 * Burn the nonce.
 *
 * The insert is the check: the primary key on (subscriber, nonce) makes a second use of the same
 * signature a constraint violation rather than a race we have to reason about. Done before any
 * effect, so a replayed request cannot rewrite a webhook URL even for the instant before it fails.
 */
async function burnNonce(sql: Sql, subscriber: string, nonce: string) {
  const rows = await sql`
    insert into alert_auth_nonce (subscriber, nonce)
    values (${subscriber.toLowerCase()}, ${nonce})
    on conflict do nothing
    returning nonce
  `;
  return rows.length > 0;
}

export async function POST(request: Request) {
  const sql = db();
  if (!sql) return fail(503, 'alerts are not configured on this deployment (no DATABASE_URL)');

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, 'body is not JSON');
  }

  const parsed = parseCommon(body);
  if ('error' in parsed) return parsed.error;
  const { network, chainId, registry, subscriber, agentId, kind, threshold, nonce, expiry, signature } = parsed;

  const webhookUrl = String(body.webhookUrl ?? '');
  const check = await checkWebhookUrl(webhookUrl);
  if (!check.ok) return fail(400, `webhook URL ${check.reason}`);

  // Verified against the fields as parsed, not as sent. If any normalisation above changed a value,
  // recovery fails and the request is rejected — which is the correct outcome: what gets stored is
  // then always exactly what was signed.
  const valid = await verifyTypedData({
    address: subscriber,
    domain: alertDomain(chainId),
    types: ALERT_TYPES,
    primaryType: 'AlertSubscription',
    message: { registry, agentId, kind, threshold, webhookUrl, nonce, expiry },
    signature,
  });
  if (!valid) return fail(401, 'signature does not recover to the subscriber');

  // Checked after the signature, deliberately. This is the one step that costs an RPC round trip,
  // and doing it first would let anyone spend our RPC budget without holding a key.
  let agent;
  try {
    agent = await readAgent(network, agentId);
  } catch (e) {
    // The RPC is a third party and it goes down. Answering 404 here would tell someone their agent
    // does not exist because a node did not answer, and send them looking for a mistake they did
    // not make. 502 says whose fault it is.
    return fail(502, 'cannot reach the chain to check this agent — try again', {
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  if (!agent) return fail(404, 'no such agent on this network', { agentId: agentId.toString(), network });

  if (!(await burnNonce(sql, subscriber, nonce))) {
    return fail(409, 'this signature has already been used — sign again');
  }

  // Regenerated on every subscribe, including a resubscribe. The secret is shown once and never
  // again, so a subscriber who lost theirs recovers by re-signing the same subscription rather than
  // by asking us to hand it back — which would make the read path a way to steal it.
  const secret = randomBytes(32).toString('hex');

  const rows = await sql`
    insert into alert_subscription
      (chain_id, registry, subscriber, agent_id, kind, threshold, webhook_url, delivery_secret)
    values
      (${chainId}, ${registry.toLowerCase()}, ${subscriber.toLowerCase()}, ${agentId.toString()},
       ${kind}, ${thresholdForStorage(kind, threshold)}, ${webhookUrl}, ${secret})
    on conflict (chain_id, registry, subscriber, agent_id, kind, coalesce(threshold, -1))
    do update set
      webhook_url = excluded.webhook_url,
      delivery_secret = excluded.delivery_secret,
      disabled_at = null,
      failure_count = 0,
      last_error = null
    returning id
  `;

  return json(
    {
      id: Number(rows[0].id),
      network,
      registry,
      agentId,
      kind,
      threshold: thresholdForStorage(kind, threshold),
      // Shown once. Deliveries carry an HMAC of the body under this key, so a receiver can tell a
      // real alert from anything else that learns the URL — and a webhook URL does leak, into
      // proxy logs and error reports, which is exactly why the URL alone is not the credential.
      deliverySecret: secret,
      signatureHeader: 'x-botid-signature: hex hmac-sha256 of the raw body under this secret',
    },
    { status: 201, ...PRIVATE },
  );
}

/**
 * A subscriber's own subscriptions.
 *
 * Webhook URLs come back as their origin only. Anyone can name any address here — there is no
 * signature on a read — so returning the full URL would make this endpoint a directory of other
 * people's callback tokens. The origin is enough to recognise your own row; the path is not.
 */
export async function GET(request: Request) {
  const sql = db();
  if (!sql) return fail(503, 'alerts are not configured on this deployment (no DATABASE_URL)');

  const url = new URL(request.url);
  const net = parseNetwork(url);
  if ('error' in net) return net.error;

  const subscriber = url.searchParams.get('subscriber');
  if (!subscriber || !isAddress(subscriber)) {
    return fail(400, 'subscriber must be an address', { given: subscriber });
  }
  const registry = registryAddress(net.network);
  if (!registry) return json({ network: net.network, subscriptions: [] }, PRIVATE);

  const rows = await sql`
    select id, agent_id, kind, threshold, webhook_url, created_at, disabled_at, failure_count, last_error
    from alert_subscription
    where chain_id = ${CHAINS[net.network].id}
      and registry = ${registry.toLowerCase()}
      and subscriber = ${subscriber.toLowerCase()}
    order by agent_id, kind
  `;

  return json(
    {
      network: net.network,
      subscriptions: rows.map((r) => ({
        id: Number(r.id),
        agentId: String(r.agent_id),
        kind: r.kind as AlertKind,
        threshold: r.threshold === null ? null : Number(r.threshold),
        webhookOrigin: originOf(String(r.webhook_url)),
        createdAt: r.created_at,
        disabledAt: r.disabled_at,
        failureCount: Number(r.failure_count),
        lastError: r.last_error,
      })),
    },
    PRIVATE,
  );
}

function originOf(raw: string) {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Stop an alert. Signed the same way as subscribing, minus the URL there is no longer any of. */
export async function DELETE(request: Request) {
  const sql = db();
  if (!sql) return fail(503, 'alerts are not configured on this deployment (no DATABASE_URL)');

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, 'body is not JSON');
  }

  const parsed = parseCommon(body);
  if ('error' in parsed) return parsed.error;
  const { chainId, registry, subscriber, agentId, kind, threshold, nonce, expiry, signature } = parsed;

  const valid = await verifyTypedData({
    address: subscriber,
    domain: alertDomain(chainId),
    types: UNSUBSCRIBE_TYPES,
    primaryType: 'AlertUnsubscribe',
    message: { registry, agentId, kind, threshold, nonce, expiry },
    signature,
  });
  if (!valid) return fail(401, 'signature does not recover to the subscriber');

  if (!(await burnNonce(sql, subscriber, nonce))) {
    return fail(409, 'this signature has already been used — sign again');
  }

  // Deleted rather than disabled. `disabled_at` means "this endpoint is failing", which is a
  // different fact from "I no longer want this", and the delivery rows go with it by cascade.
  const rows = await sql`
    delete from alert_subscription
    where chain_id = ${chainId}
      and registry = ${registry.toLowerCase()}
      and subscriber = ${subscriber.toLowerCase()}
      and agent_id = ${agentId.toString()}
      and kind = ${kind}
      and coalesce(threshold, -1) = ${thresholdForStorage(kind, threshold) ?? -1}
    returning id
  `;

  return json({ deleted: rows.length }, PRIVATE);
}
