import localFont from 'next/font/local';

// Self-hosted, and deliberately so.
//
// The CDN build worked, but it meant every reader of a page about not having to trust anybody
// made a request to a third party before the first paint — and the privacy page promises no
// third-party requests, which was simply false while a font came from someone else's CDN.
// Serving these from our own origin also removes a DNS lookup and a TLS handshake from the
// critical path, and next/font emits the files with a content hash and an immutable cache header.
//
// The body face, Satoshi, is Fontshare (Indian Type Foundry), free for commercial use under the
// Fontshare licence, which permits self-hosting. It came from api.fontshare.com/v2/css.
//
// The heading face is not free, and that changes what has to be true rather than whether it can
// be used here. Beautifully Delicious (Elena Genova, My Creative Land) is sold per-licence on
// MyFonts, Fontspring and Fonts.com. Self-hosting it requires the *webfont* licence — the desktop
// licence covers a design tool on a machine, not a woff2 served to every visitor — and that
// licence is usually capped on monthly pageviews, so it is a thing to re-check rather than buy
// once and forget. What must not happen is the obvious shortcut: linking it from a font CDN to
// avoid the purchase. The privacy page promises this site makes no third-party requests, and a
// CDN font makes one before the first paint, which is how that promise quietly became false the
// last time. Buy the webfont licence and keep the file in this directory, or use a free face.
//
// woff2 only. Every browser that can run this app supports it, and shipping woff and ttf
// fallbacks would triple the directory for readers who will never fetch them.

// The Sans cut, not the Script. The family ships both, and --font-heading feeds the 34px stat
// numerals on the overview and the wordmark that sits beside contract addresses — a script face
// is a poor choice for a numeral you are asking someone to read as a fact.
//
// If the licence you buy turns out to cover Bold rather than Black, two things change together:
// the weight here and --font-heading-weight in globals.css. Declaring 900 while shipping a 700
// file does not fail, it makes the browser smear the 700 into a fake 900, which reads as a
// rendering bug rather than as a mistake in a config file.
export const delicious = localFont({
  src: [{ path: './fonts/BeautifullyDeliciousSans-Black.woff2', weight: '900', style: 'normal' }],
  variable: '--font-delicious',
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
    // rendering bug next to the heading face's genuine weight.
    { path: './fonts/Satoshi-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-satoshi',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
});
