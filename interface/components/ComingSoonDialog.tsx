'use client';
import { useEffect, useRef } from 'react';
import type { Network } from '@/lib/network';

/**
 * Shown when someone reaches for a network BotID is not on yet.
 *
 * The alternative was to let the switch happen and let the pages explain themselves, which they
 * partly do — the portal already says "BotID is not deployed on BOT Chain". But by then the reader
 * has changed the whole interface to a chain where every list is empty and every balance is zero,
 * and an empty list is ambiguous: it reads as "no agents have registered" rather than as "you are
 * looking at the wrong chain". Refusing the switch and saying why keeps the interface describing
 * something real at all times.
 *
 * It is a plain overlay rather than <dialog>: showModal() puts the element in the top layer, above
 * everything including our own nav, and the backdrop is styled through ::backdrop, which does not
 * read the same custom properties as the rest of the page in every browser. This is one z-index
 * above the nav's 50 and inherits the ordinary cascade.
 */
export default function ComingSoonDialog({ network, onClose }: { network: Network; onClose: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Where focus was, so it can go back. Captured rather than assumed to be the network switcher:
    // on a phone that trigger is inside the hamburger panel and is already gone by now, and any
    // future caller would be a different element again. Checked for `isConnected` on the way out,
    // because handing focus to a detached node silently drops it on <body>.
    const opener = document.activeElement as HTMLElement | null;
    // Focus moves to the dialog, because the control that opened it is now behind an overlay and
    // a keyboard would otherwise still be sitting on it, tabbing through a page it cannot reach.
    confirm.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      // The backdrop dismisses, but only when the backdrop itself was clicked. Without the target
      // check, a drag that starts inside the panel and releases outside it closes the dialog.
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="overlay-panel" role="dialog" aria-modal="true" aria-labelledby="coming-soon-title">
        <h2 id="coming-soon-title" style={{ fontSize: 20, margin: '0 0 var(--space-3)' }}>
          {network.name} is coming soon
        </h2>
        <p style={{ margin: '0 0 var(--space-3)' }}>
          BotID is not deployed on {network.name} yet. The chain is live, but none of our contracts
          are on it — no registry, no router, no bonds. Switching there would show you an interface
          with nothing behind it: every list empty, every balance zero, and every transaction sent
          to an address that holds no code.
        </p>
        <p className="text-muted" style={{ margin: '0 0 var(--space-4)', fontSize: 13 }}>
          Everything works today on Bohr Testnet, chain 968, where all eight contracts are deployed
          and verified. Mainnet follows an audit, not a calendar date.
        </p>
        {/* Not .btn-block: that class exists for menu rows and left-aligns its label deliberately.
            This is the single action in a dialog, and it belongs in the middle. */}
        <button ref={confirm} className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>
          Stay on Bohr Testnet
        </button>
      </div>
    </div>
  );
}
