// Puts the licensed heading face on disk before `next build` runs.
//
// Beautifully Delicious Sans is bought per-licence, and this repo is public, so the woff2 is
// gitignored by name (see .gitignore and app/fonts.ts). Vercel clones the repo like anyone else,
// which means the font is simply absent on the build machine and webpack fails with
// "Can't resolve './fonts/BeautifullyDeliciousSans-Black.woff2'" — accurate, but it reads like a
// broken import rather than a missing licensed asset, and it names no way to fix it.
//
// So the file travels as a base64 environment variable instead. Env vars are private to the
// Vercel project, so this satisfies the webfont licence the same way self-hosting does: the file
// reaches our own build and our own origin, and never reaches whoever clones the repo.
//
// npm runs a `prebuild` script automatically before `build`, so nothing has to remember to call
// this. Note that `build:check` does not trigger it — that path is for a developer who already
// has the font locally, which is the case this script skips anyway.

const fs = require('node:fs');
const path = require('node:path');

const ENV_VAR = 'BEAUTIFULLY_DELICIOUS_B64';
const target = path.join(__dirname, '..', 'app', 'fonts', 'BeautifullyDeliciousSans-Black.woff2');

// A developer with the licence keeps the real file in the working tree. Never overwrite it from
// an env var: the file on disk is the one they bought and the one the design was checked against,
// and silently replacing it with whatever a stale env var holds is the sort of thing that ends
// with two different fonts shipping from two different machines.
if (fs.existsSync(target) && fs.statSync(target).size > 0) {
  console.log(`font: using the ${path.basename(target)} already in the working tree`);
  process.exit(0);
}

const encoded = process.env[ENV_VAR];
if (!encoded) {
  console.error(
    `\nfont: ${path.basename(target)} is missing and ${ENV_VAR} is not set.\n\n` +
      'This file is licensed and deliberately not committed, so a fresh clone does not have it.\n' +
      'Either drop your licensed copy into interface/app/fonts/, or set ' +
      `${ENV_VAR} to its base64.\n` +
      "Failing here rather than falling back to system-ui: a missing licensed font should stop a\n" +
      'build, not quietly ship a site that looks like a different site.\n'
  );
  process.exit(1);
}

const bytes = Buffer.from(encoded, 'base64');

// Buffer.from is famously forgiving — it discards anything that is not base64 rather than
// throwing, so a truncated or whitespace-mangled paste decodes to a shorter, entirely valid-looking
// Buffer. Checking the woff2 signature turns that silent corruption into a message at the point
// it happened, instead of a font that renders as tofu in production.
if (bytes.subarray(0, 4).toString('ascii') !== 'wOF2') {
  console.error(
    `\nfont: ${ENV_VAR} did not decode to a woff2 (expected the file to start with "wOF2").\n` +
      'The value is probably truncated or had characters mangled in transit. Re-copy it whole.\n'
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, bytes);
console.log(`font: wrote ${path.basename(target)} from ${ENV_VAR} (${bytes.length} bytes)`);
