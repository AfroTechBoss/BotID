import type { Metadata } from 'next';
import './globals.css';
import { cabinet, satoshi } from './fonts';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

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
    // data-theme is explicit rather than implied by :root so the value is inspectable and a
    // toggle has something to write to. Dark is the default; 'light' is the only other value.
    <html lang="en" data-theme="dark" className={`${cabinet.variable} ${satoshi.variable}`}>
      <body>
        <div className="page-frame">
          <Nav />
          {/* Wrapper, not a bare {children}: it is what grows to fill the viewport, which is what
              pins the footer to the bottom on short pages. */}
          <div className="page-body">{children}</div>
          <Footer />
        </div>
      </body>
    </html>
  );
}
