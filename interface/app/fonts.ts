import localFont from 'next/font/local';

// Self-hosted, and deliberately so.
//
// The CDN build worked, but it meant every reader of a page about not having to trust anybody
// made a request to a third party before the first paint — and the privacy page promises no
// third-party requests, which was simply false while a font came from someone else's CDN.
// Serving these from our own origin also removes a DNS lookup and a TLS handshake from the
// critical path, and next/font emits the files with a content hash and an immutable cache header.
//
// Both faces are Fontshare (Indian Type Foundry), free for commercial use under the Fontshare
// licence, which permits self-hosting. The files came from api.fontshare.com/v2/css; see
// app/fonts/ for the woff2 payloads.
//
// woff2 only. Every browser that can run this app supports it, and shipping woff and ttf
// fallbacks would triple the directory for readers who will never fetch them.

export const cabinet = localFont({
  src: [{ path: './fonts/CabinetGrotesk-Extrabold.woff2', weight: '800', style: 'normal' }],
  variable: '--font-cabinet',
  display: 'swap',
  // Fall back to the platform's own UI face rather than a generic sans: the metric jump on swap
  // is smaller, and the headline numerals on the overview are large enough for it to show.
  fallback: ['system-ui', 'sans-serif'],
});

export const satoshi = localFont({
  src: [
    { path: './fonts/Satoshi-Medium.woff2', weight: '500', style: 'normal' },
    // 700 is not decoration. The markup leans on bold for table emphasis and nav state, and
    // without a real face the browser synthesises one by smearing the 500 — which looks like a
    // rendering bug next to Cabinet Grotesk's genuine 800.
    { path: './fonts/Satoshi-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-satoshi',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
});
