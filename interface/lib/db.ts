// The one piece of state in this interface that is not on a chain.
//
// Everything else here is a read: a number comes off Bohr, gets formatted, and is forgotten. An
// alert subscription cannot work that way. It has to outlive the request that created it, be
// visible to a process running somewhere else entirely, and survive both of them restarting.
//
// It is Postgres rather than a file because of who is allowed to talk to whom. The write path is
// this app, which on Vercel is a serverless function with no durable disk. The read path is the
// relayer's alert daemon, which holds a signing key and must never accept an inbound connection —
// that is why the browser cannot simply POST to it. A table both can reach is the seam that keeps
// the key-holding process outbound-only. See db/001_alerts.sql, which is the schema for both.
//
// DATABASE_URL is the POOLED Neon string here (the host with `-pooler` in it). Route handlers open
// a connection per invocation and a burst of them will exhaust the direct endpoint; the pooler is
// built for exactly that shape. The relayer takes the direct string, being one long-lived process.

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let cached: NeonQueryFunction<false, false> | null | undefined;

/**
 * The query function, or null when no database is configured.
 *
 * Null rather than a throw, because a missing DATABASE_URL is not a broken deployment — it is the
 * ordinary state of a local checkout and of any fork that does not want alerts. Every caller here
 * checks, and the portal renders the alerts form as disabled rather than as an error. The one
 * thing that must not happen is the form appearing to work and the row going nowhere.
 */
export function db(): NeonQueryFunction<false, false> | null {
  if (cached !== undefined) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? neon(url) : null;
  return cached;
}

/** Whether the alerts feature has anywhere to write. Safe to call on the server at render time. */
export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
