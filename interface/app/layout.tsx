import type { Metadata } from 'next';
import './globals.css';
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
    <html lang="en">
      <body>
        <div className="page-frame">
          <Nav />
          {children}
          <Footer />
        </div>
      </body>
    </html>
  );
}
