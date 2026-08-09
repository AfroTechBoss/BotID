/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

  // `next dev` and `next build` both write to .next. Running a build while the dev server is up
  // replaces the chunks the running server has already resolved, and it dies on the next request
  // with "Cannot find module './875.js'" — an error that reads like a code fault and is not one.
  //
  // NEXT_DIST_DIR lets a build go somewhere else entirely, which is what `npm run build:check`
  // does. Unset, everything behaves exactly as before.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
