import type { Metadata } from 'next';
import './globals.css';
import { cabinet, satoshi } from './fonts';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { NetworkProvider } from '@/lib/network';
import { WalletProvider } from '@/lib/wallet';
import { readTheme } from '@/lib/theme.server';

export const metadata: Metadata = {
  title: { default: 'BotID', template: '%s · BotID' },
  description: 'Bonded identity and settled reputation for autonomous agents.',
};

// Nav and Footer are mounted here rather than by each page. They were previously imported
// page by page, which had already drifted: five routes rendered no footer at all, so the legal
// links required by §18 were missing from exactly the pages a stranger is most likely to land on.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The font classes carry --font-cabinet and --font-satoshi; globals.css reads them through
    // --font-heading and --font-body, so no component ever names a typeface directly.
    // data-theme is rendered by the server from the cookie, not written by a pre-paint script
    // reading localStorage. The script version does not survive: <html> is a React-rendered
    // element, and hydration strips attributes React does not own, so a stored light preference
    // held only until the bundle loaded and then snapped back to dark. Reading a cookie the
    // server can see makes the first paint already correct, with no mismatch to suppress.
    // The cost is that this opts every route into dynamic rendering — acceptable here, where
    // every page already renders per-request data.
    <html lang="en" data-theme={readTheme()} className={`${cabinet.variable} ${satoshi.variable}`}>
      {/* Grammarly and its kind stamp their own attributes onto <body> the moment the HTML lands —
          data-gr-ext-installed and friends — which is before React hydrates. React then compares
          the DOM it finds against the HTML it sent, sees attributes it did not write, and reports
          a hydration mismatch it can do nothing about: the markup is ours, the extra attributes
          are not. Suppression here is one element deep, covering this tag's own attributes and
          nothing inside it, so a real mismatch in the tree still shouts. */}
      <body suppressHydrationWarning>
        {/* The provider wraps the whole frame, not just the nav, because the switcher in the nav
            and the labels in the footer and the status bars have to name the same chain. */}
        {/* WalletProvider inside NetworkProvider, not beside it: the wallet client is bound to the
            selected chain, and "switch to the network the page is showing" is a question only
            answerable when the selected network is already in scope. */}
        <NetworkProvider>
          <WalletProvider>
          <div className="page-frame">
            <Nav />
            {/* Wrapper, not a bare {children}: it is what carries the viewport-height rule, which
                is what puts the first pixel of the footer exactly on the fold. */}
            <div className="page-body">{children}</div>
            <Footer />
          </div>
          </WalletProvider>
        </NetworkProvider>
      </body>
    </html>
  );
}
