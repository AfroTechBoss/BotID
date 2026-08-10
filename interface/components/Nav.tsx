'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NetworkSelect from './NetworkSelect';
import ConnectWalletButton from './ConnectWalletButton';

// Mounted once in the root layout. It derives the active link from the URL rather than taking a
// `current` prop, so a new route cannot forget to tell the nav where it is.
//
// There is no Verify entry: /verify/[requestId] has no meaning without a request, and a nav item
// that needs a placeholder id is a nav item that should not exist. It is reached from an
// execution, which is where a reader has one.
const LINKS: [string, string][] = [
  ['/', 'Overview'],
  ['/agents', 'Agents'],
  ['/executions', 'Executions'],
  ['/portal', 'Portal'],
  ['/docs', 'Docs'],
];

export default function Nav() {
  const pathname = usePathname() || '/';
  const isCurrent = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Closing on the pathname is not the same as closing on the click: a link is a navigation, and a
  // menu still standing over the page it just loaded is a menu the reader has to dismiss to see
  // what they asked for. Tapping the current page is the case this misses, so the links close it
  // themselves as well.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); toggle.current?.focus(); }
    };
    // Pointerdown for the same reason NetworkSelect uses it: a menu that waits for mouseup stays
    // open under the press and reads as a missed tap. The toggle is excluded because its own click
    // handler already flips the state — closing here first would make the two cancel out.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !toggle.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <nav className="nav">
      {/* Wordmark only. The concentric ring that used to sit beside it was a fourth thing drawing
          rings — after BotIdBadge, the live dots and the network dot — and being decorative rather
          than carrying state it just diluted the ones that mean something. */}
      {/* "Protocol" is a span so the narrow header can drop it. The short mark is what the page
          title already uses, and spending 70px of a 375px row on the second word is what forces
          the wordmark and the controls onto separate lines. */}
      <Link href="/" className="nav-brand" style={{ color: 'inherit', textDecoration: 'none' }}>
        BotID<span className="nav-brand-rest">&nbsp;Protocol</span>
      </Link>
      {/* The links and the controls are each wrapped in one box rather than sitting loose in the
          nav's flex row. Loose, they were seven siblings that could only ever be one line: below
          about 700px the row was 682px wide inside a 375px viewport and every page on the site
          scrolled sideways. Grouped, the menu is one thing the narrow header can lift out of the
          row entirely and hang under the toggle — see the media query in globals.css.

          One list, not a desktop copy and a phone copy. Two would be two sets of hrefs and two
          aria-currents to keep in step, and the pair that drifts is always the one nobody looks at.
          Which shape it takes is CSS; what is in it is not. */}
      <div className="nav-links" id="nav-menu" ref={menu} data-open={open || undefined}>
        {LINKS.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            aria-current={isCurrent(href) ? 'page' : undefined}
            onClick={() => setOpen(false)}
          >
            {label}
          </Link>
        ))}
      </div>
      <div className="nav-actions">
        <NetworkSelect />
        <ConnectWalletButton />
        {/* .btn .btn-secondary with no size override, so it is the same height as the two controls
            beside it by construction rather than by numbers kept in sync — the same bargain
            NetworkSelect's trigger makes.

            aria-expanded is what tells a screen reader this is a disclosure rather than a link, and
            it is also the hook the bars-to-cross CSS hangs on, so the visual state cannot disagree
            with the announced one. Hidden above 720px by display:none, which takes it out of the
            accessibility tree and the tab order together — on a desktop header the menu is simply
            there, and a button offering to reveal it would be a lie. */}
        <button
          ref={toggle}
          type="button"
          className="btn btn-secondary nav-toggle"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true" className="nav-toggle-bars" />
        </button>
      </div>
    </nav>
  );
}
