-- Alert subscriptions.
--
-- Two processes share this schema and neither owns the other: the interface writes rows (a
-- signed POST from the portal form), the relayer reads them and delivers. That split is the
-- reason this lives in a database at all rather than in a file beside the daemon — the write
-- path runs on serverless functions with no durable filesystem, and the read path runs in a
-- process holding WATCHTOWER_KEY, which must never accept an inbound connection. A shared
-- table is the seam that keeps the key-holding process outbound-only.
--
-- Addresses are stored lowercase hex with the 0x prefix, as text, not bytea: every consumer
-- here is JavaScript, every comparison is against a string that came off the chain or out of
-- a signature, and a bytea round trip buys nothing but a place to get the encoding wrong.
--
-- agent_id is numeric(78,0) because it is a uint256. It will realistically be under a
-- thousand, and it is still not a bigint, because the day it is a hash-derived id is not the
-- day to find out that the column silently truncated.

create table if not exists alert_subscription (
  id             bigserial primary key,

  -- Which deployment this is about. The contract set is replaced whole on every redeploy
  -- (docs/contract.md §8), so a subscription is only meaningful against the addresses it was
  -- made for. Storing the chain alone is not enough: keep the registry address so a redeploy
  -- on the same chain does not silently resurrect subscriptions against a dead protocol.
  chain_id       integer     not null,
  registry       text        not null,

  -- The address that signed the subscription request. Authorisation is checked at write time
  -- against the chain (agent owner, agent operator, or — for a consumer watching someone
  -- else's agent — nobody, because watching a public score needs no permission).
  subscriber     text        not null,

  agent_id       numeric(78,0) not null,

  -- 'fault'         — FaultRecorded or Slashed touching this agent
  -- 'challenge'     — ExecutionChallenged against this agent. The escalation window is six
  --                   hours; this is the alert whose absence costs money.
  -- 'score_below'   — score crossed threshold downward
  -- 'score_above'   — score crossed threshold upward
  -- 'unbonding'     — UnbondingStarted, for a consumer watching capital leave
  kind           text        not null,
  check (kind in ('fault', 'challenge', 'score_below', 'score_above', 'unbonding')),

  -- Only the score kinds use it; enforced rather than documented.
  threshold      integer,
  check (
    (kind in ('score_below', 'score_above') and threshold between 0 and 10000)
    or (kind not in ('score_below', 'score_above') and threshold is null)
  ),

  webhook_url    text        not null,

  -- HMAC key for signing deliveries, generated server-side and shown to the subscriber once.
  -- A webhook URL is a bearer token that leaks into logs and proxies; the signature is what
  -- lets a receiver tell a real alert from anyone who read one.
  delivery_secret text       not null,

  created_at     timestamptz not null default now(),

  -- Set when the endpoint has failed enough times to stop trying. A dead endpoint retried
  -- forever is a slow outbound scanner pointed at somebody else's infrastructure.
  disabled_at    timestamptz,
  failure_count  integer     not null default 0,
  last_error     text
);

-- One subscription per (subscriber, agent, kind, threshold) per deployment. Resubscribing
-- with a new URL updates rather than accumulating, so a form submitted twice is not two
-- webhooks.
create unique index if not exists alert_subscription_unique
  on alert_subscription (chain_id, registry, subscriber, agent_id, kind, coalesce(threshold, -1));

create index if not exists alert_subscription_live
  on alert_subscription (chain_id, registry, agent_id)
  where disabled_at is null;

-- Replay protection for the signed write path. A signature over {agent, kind, url, nonce} is
-- otherwise reusable by anyone who saw it once.
create table if not exists alert_auth_nonce (
  subscriber     text        not null,
  nonce          text        not null,
  used_at        timestamptz not null default now(),
  primary key (subscriber, nonce)
);

-- Last observed value per watched agent, per deployment. This is what makes a threshold a
-- *crossing* rather than a standing condition — without it, "score below 5000" is true on
-- every pass and fires forever.
--
-- It also covers the case no event can: score decays continuously with decayHalfLife (90
-- days), so an agent can cross a threshold with no transaction anywhere on chain. A log
-- follower alone misses exactly the alert a consumer most wants, which is why the daemon
-- sweeps watched agents on a timer as well as following events.
create table if not exists alert_agent_state (
  chain_id       integer     not null,
  registry       text        not null,
  agent_id       numeric(78,0) not null,
  score          integer,
  observed_at    timestamptz not null default now(),
  observed_block bigint,
  primary key (chain_id, registry, agent_id)
);

-- Delivery log, and the dedupe key. event_key is derived from the thing that happened
-- (transaction hash + log index for an event, or agent + threshold + direction + the block
-- the crossing was detected in for a decay crossing), so a daemon restart that re-scans a
-- range does not re-notify. Several daemons may run; the unique constraint is what makes
-- that harmless, the same way the watchtower's races are harmless.
create table if not exists alert_delivery (
  id              bigserial primary key,
  subscription_id bigint      not null references alert_subscription (id) on delete cascade,
  event_key       text        not null,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  attempts        integer     not null default 0,
  last_status     integer,
  last_error      text
);

create unique index if not exists alert_delivery_once
  on alert_delivery (subscription_id, event_key);

create index if not exists alert_delivery_pending
  on alert_delivery (created_at)
  where delivered_at is null;
