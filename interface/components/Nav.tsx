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
      if (e.key !== 'Escape') return;
      // One press, one layer. The panel can hold a control with its own popup — NetworkSelect's
      // listbox — and that popup marks the event as consumed when it closes itself, so the panel
      // does not go with it. The next press finds no marker and lands here.
      if (e.defaultPrevented) return;
      setOpen(false);
      toggle.current?.focus();
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
      {/* Both words at every width. "Protocol" used to be a span the narrow header hid, because 70px
          of a 375px row was the difference between fitting the network selector and Connect wallet
          beside it and not. Those live in the hamburger panel now, so the second word costs nothing
          and the phone header can say what the site is called. */}
      <Link href="/" className="nav-brand" style={{ color: 'inherit', textDecoration: 'none' }}>
        BotID&nbsp;Protocol
      </Link>
      {/* One wrapper around everything the toggle reveals — the links *and* the controls. It is not
          a box on the desktop header: .nav-menu is `display: contents` above 720px, so .nav-links
          and .nav-actions are direct flex items of the nav exactly as they were before it existed,
          and the wordmark's auto margin still centres the menu between them. Below 720px the same
          wrapper becomes the panel.

          That is the whole reason for the indirection: NetworkSelect owns a listbox with its own
          open and active state, and ConnectWalletButton will own a connection. Rendering a second
          copy for the phone would mean two listboxes that can disagree about which network is
          selected, and two lists of hrefs with two aria-currents to keep in step. The pair that
          drifts is always the one nobody looks at. Which shape the menu takes is CSS; what is in it
          is one instance of each control.

          The toggle is deliberately *outside* the wrapper: it has to stay in the top row while the
          thing it controls moves out of it. */}
      <div className="nav-menu" id="nav-menu" ref={menu} data-open={open || undefined}>
        <div className="nav-links">
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
        </div>
      </div>
      {/* .btn .btn-secondary with no size override, so it is the same height as the controls it
          sits beside on a desktop-width header by construction rather than by numbers kept in
          sync — the same bargain NetworkSelect's trigger makes.

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
    </nav>
  );
}
