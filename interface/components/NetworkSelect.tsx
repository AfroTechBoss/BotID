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
    setNetwork(id);
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); return; }
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
        {/* Both names are rendered and one is hidden by width, because the narrowest phones cannot
            fit "Bohr Testnet" in the header row. The short form is the same field the footer and
            the status bars use, so nothing is invented for the small screen. */}
        <span className="select-name-long">{network.name}</span>
        <span className="select-name-short">{network.short}</span>
        <span aria-hidden="true" className="select-caret" data-open={open || undefined} />
      </button>

      {open && (
        <ul className="select-list" role="listbox" aria-label="Network" tabIndex={-1}>
          {NETWORKS.map((n, i) => (
            <li
              key={n.id}
              role="option"
              aria-selected={n.id === network.id}
              data-active={i === active || undefined}
              className="select-option"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(n.id)}
              onMouseEnter={() => setActive(i)}
            >
              <span aria-hidden="true" className="select-dot" data-network={n.id} />
              <span className="select-option-name">{n.name}</span>
              <span className="select-option-chain">chain {n.chainId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
