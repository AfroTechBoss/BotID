// NEXT_PUBLIC_MOCK_NOW used to be defined here: a build-time clock the fixture generator anchored
// its "N hours ago" timestamps to, so that server render and hydration agreed on what "now" was.
// It went out with lib/mock-data.ts. Nothing reads it, and a build-time constant named after a
// clock is exactly the kind of leftover that gets picked up later by someone who assumes it means
// something — so it is deleted rather than left defined and unused.

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

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
