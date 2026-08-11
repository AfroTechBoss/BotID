'use client';
import { useNetwork } from '@/lib/network';
import ComingSoonDialog from './ComingSoonDialog';

/**
 * Renders the refusal, wherever the request came from.
 *
 * Mounted in the root layout rather than inside the switcher: the switcher is one caller, and on a
 * phone it is a caller that disappears at the moment of the click — the network list lives in the
 * hamburger panel, and choosing an option closes the panel. A dialog owned by that subtree went
 * with it, so the phone got a control that appeared to do nothing at all.
 *
 * This also puts the overlay at the top of the document rather than inside the nav's stacking
 * context, so its z-index is read against the page instead of against the nav's own children.
 */
export default function NetworkGate() {
  const { pending, dismissPending } = useNetwork();
  if (!pending) return null;
  return <ComingSoonDialog network={pending} onClose={dismissPending} />;
}
