-- What a queued alert says, and how far the daemon has read.
--
-- Separate from 001 rather than folded into it because 001 had already been applied to a live
-- database by the time the daemon was written, and `create table if not exists` does not go back
-- and add a column. A migration that has run is history; the fix is another migration, not an
-- edit to the first one.

-- The body to POST.
--
-- Written when the delivery is queued rather than rebuilt when it is sent, because those happen at
-- different times and the chain moves in between: an alert that said "score fell to 4,900" should
-- still say that when it arrives after three failed attempts, not whatever the score is by then.
alter table alert_delivery
  add column if not exists payload jsonb not null default '{}'::jsonb;

-- How far the daemon has followed the logs, per deployment.
--
-- Without it a restart re-scans a fixed lookback and anything older is simply missed — at 0.75s
-- blocks a few thousand blocks is under an hour of downtime. The dedupe index in 001 makes
-- re-scanning harmless, so this only needs to be roughly right: it bounds how much gets re-read,
-- and it makes a long outage a visible gap rather than a silent one.
create table if not exists alert_cursor (
  chain_id       integer     not null,
  registry       text        not null,
  block          bigint      not null,
  updated_at     timestamptz not null default now(),
  primary key (chain_id, registry)
);
