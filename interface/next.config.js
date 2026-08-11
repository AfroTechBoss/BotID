// The instant the fixtures are anchored to. Evaluated once, here, because this file is read once
// per build and once when the dev server starts — never per request and never in the browser. That
// is the whole point: lib/mock-data.ts must not read a clock, since a value read during server
// rendering and read again during hydration disagrees and React throws the server HTML away.
// Baking it in at build time is the only way to have it track real time *and* stay identical on
// both sides.
//
// Truncated to the top of the hour so it is a round number that is always slightly in the past —
// fixtures are all "N hours ago" relative to this, and an anchor in the future would render them
// as negative ages. An hour is also the finest granularity anything here displays.
const MOCK_NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

  // `env` is inlined by DefinePlugin into the server and client bundles alike, so both sides of
  // hydration see the same literal. A runtime lookup would not do — process.env does not exist in
  // the browser, and anything read per-request could differ between the two renders.
  env: { NEXT_PUBLIC_MOCK_NOW: String(MOCK_NOW) },

  // The ABIs live in ../contracts/abi, outside this project root, and Next refuses to compile
  // imports from outside the root unless told to. They are deliberately not copied in: they are a
  // build product of the contracts (scripts/export-abi.js), and a copy is a thing that goes stale
  // silently — an interface calling a function signature the deployed contract no longer has fails
  // at the RPC with a decode error, not at build. One source, imported across.
  experimental: { externalDir: true },

  // `next dev` and `next build` both write to .next. Running a build while the dev server is up
  // replaces the chunks the running server has already resolved, and it dies on the next request
  // with "Cannot find module './875.js'" — an error that reads like a code fault and is not one.
  //
  // NEXT_DIST_DIR lets a build go somewhere else entirely, which is what `npm run build:check`
  // does. Unset, everything behaves exactly as before.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
