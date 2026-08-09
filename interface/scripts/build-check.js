// A production build that is safe to run while `npm run dev` is up.
//
// Both commands write to .next by default. Building over a live dev server replaces the chunks
// that server has already resolved, and it then dies on the next request with
// "Cannot find module './875.js'" — an error that names a file nobody wrote and points at no
// real defect. This sends the build to .next-check instead.
//
// A plain `NEXT_DIST_DIR=... next build` in the npm script would not do: that syntax is a shell
// builtin on POSIX and a syntax error in cmd.exe, and this repo is developed on Windows. Setting
// it in Node keeps one script that works everywhere without pulling in cross-env for one line.

const { spawn } = require('node:child_process');

const child = spawn('next', ['build'], {
  stdio: 'inherit',
  shell: true, // `next` is a .cmd shim on Windows and is not directly executable
  env: { ...process.env, NEXT_DIST_DIR: '.next-check' },
});

child.on('exit', (code) => process.exit(code ?? 1));
