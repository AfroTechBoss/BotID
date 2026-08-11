'use client';
import { useEffect, useRef, useState } from 'react';
import { NETWORKS, NetworkId, useNetwork } from '@/lib/network';

// A native <select> with `appearance: none` styles the closed control and nothing else: the open
// list is drawn by the OS, which on Windows means white-on-white against a dark page, and no
// amount of CSS reaches it. This is the listbox pattern instead — a button and a list we own.
//
// The trigger takes .btn .btn-secondary with no font-size or padding override, so it is the same
// height as Connect wallet beside it by construction rather than by two numbers kept in sync.
export default function NetworkSelect() {
  const { network, setNetwork } = useNetwork();
  const [open, setOpen] = useState(false);
  // Which option the keyboard is on. Separate from the selected one: arrowing through a list is
  // not the same as choosing from it, and committing on every arrow press would switch networks
  // three times on the way to the option you wanted.
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setActive(NETWORKS.findIndex((n) => n.id === network.id));
    // Pointerdown, not click: a menu that waits for mouseup stays open under the press, which
    // looks like the click missed.
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, network.id]);

  const choose = (id: NetworkId) => {
    setOpen(false);
    // setNetwork refuses a network BotID is not on yet and raises the explanation itself, so there
    // is nothing to branch on here. Focus goes back to the trigger either way: the dialog captures
    // whatever was focused when it opened and hands it back on close, which is the same element.
    setNetwork(id);
    trigger.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Escape closes one layer, the innermost. Below 720px this trigger lives inside the nav's
      // hamburger panel, which closes on Escape too, so without a marker the single press collapsed
      // both and the reader lost the menu they were working in.
      //
      // preventDefault is that marker, and stopPropagation is not: React dispatches from the root
      // container, so by the time a listener on the document runs, stopping propagation is already
      // too late — measured, not assumed. defaultPrevented rides on the native event and is still
      // readable there whatever the order. Escape has no default action on a button, so spending it
      // as a signal costs nothing.
      //
      // Guarded on `open` rather than unconditional: with the list already shut, Escape here *is*
      // meant to reach the panel and dismiss it.
      if (open) e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key === 'Tab') { setOpen(false); return; }
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % NETWORKS.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + NETWORKS.length) % NETWORKS.length); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(NETWORKS.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(NETWORKS[active].id); }
  };

  // A <button> activates Space on key*up*, and preventDefault on keydown does not reach that far.
  // Without this the menu opened on keydown and the trailing click closed it again, so Space
  // appeared to do nothing at all. Enter needs no equivalent: it activates on keydown.
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') e.preventDefault();
  };

  return (
    <div ref={root} className="select" onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
      <button
        ref={trigger}
        type="button"
        className="btn btn-secondary select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {/* The dot is the live indicator the status bars use, so the nav and the footer agree
            about which network is live without repeating the word. */}
        <span aria-hidden="true" className="select-dot" data-network={network.id} />
        {/* One name. This used to render both and hide one by width, because the narrowest phones
            could not fit "Bohr Testnet" into the header row alongside the wordmark and Connect
            wallet. Below 720px the trigger is no longer in that row — it is a full-width control in
            the hamburger panel, which has room for the long name at 320px — so the short form here
            was a span that could never be seen. `network.short` is still what NetworkLabel and the
            overview's status line render; it is only this abbreviation that is gone. */}
        <span>{network.name}</span>
        <span aria-hidden="true" className="select-caret" data-open={open || undefined} />
      </button>

      {open && (
        <ul className="select-list" role="listbox" aria-label="Network" tabIndex={-1}>
          {NETWORKS.map((n, i) => (
            <li
              key={n.id}
              role="option"
              aria-selected={n.id === network.id}
              // aria-disabled, not disabled: the row is still reachable and still clickable,
              // because clicking it is what produces the explanation. A row a screen reader skips
              // entirely would answer "is there a mainnet?" with silence.
              aria-disabled={!n.live || undefined}
              data-active={i === active || undefined}
              className="select-option"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(n.id)}
              onMouseEnter={() => setActive(i)}
            >
              <span aria-hidden="true" className="select-dot" data-network={n.id} />
              <span className="select-option-name">{n.name}</span>
              {n.live ? (
                <span className="select-option-chain">chain {n.chainId}</span>
              ) : (
                <span className="select-option-soon">Soon</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
