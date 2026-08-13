import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cookies & local storage',
  description:
    'Every cookie and storage key this interface sets, what each is for, and why there is no consent banner. One cookie, no tracking, no third parties.',
};

// Verified against the source rather than described from memory, which is how the previous version
// of this page came to list four localStorage keys that do not exist. The interface calls
// localStorage nowhere; the theme is a cookie because the server needs it during render to avoid a
// flash of the wrong theme, and that is the only client-side state it persists at all.

const HEAD: React.CSSProperties = { color: 'var(--text-muted)', margin: 'var(--space-6) 0 var(--space-2)' };

export default function Cookies() {
  return (
    <>
      {/* Full width so the tables get the screen — they are the substance of the page. The measure
          lives on the paragraphs via .legal-body. */}
      <main className="legal-body" style={{ padding: 'var(--space-8) var(--space-6)', flex: 1 }}>
        <h1 style={{ fontSize: 28 }}>Cookies &amp; local storage</h1>
        <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 10, 2026</p>

        <p>
          One cookie, for your light/dark preference. No tracking cookies, no advertising cookies, no
          analytics cookies, no third-party cookies, no pixels, no fingerprinting, and no consent
          banner — because there is nothing here to consent to.
        </p>
        <p>
          You do not have to take that on faith. Open your browser&apos;s storage inspector on any page
          of this site and compare it against the table below.
        </p>

        <h3>Cookies, in full</h3>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Name</th><th>Purpose</th><th>Type</th><th>Lifetime</th><th>Attributes</th></tr></thead>
            <tbody>
              <tr>
                <td style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>botid-theme</td>
                <td>
                  Stores <code>light</code> or <code>dark</code>. Read on the server during render so the
                  first paint already matches your preference instead of flashing the wrong theme and
                  correcting itself.
                </td>
                <td style={{ verticalAlign: 'top' }}>Strictly necessary</td>
                <td style={{ verticalAlign: 'top' }}>1 year</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, verticalAlign: 'top' }}>path=/; SameSite=Lax</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          That is the entire list. The value is the literal string <code>light</code> or{' '}
          <code>dark</code> — no identifier, no session token, no hash, nothing that could distinguish
          you from anyone else who prefers the same theme. It is set by your own click on the theme
          toggle and by nothing else.
        </p>
        <p>
          It is classified as strictly necessary because it carries no identifier and is used for no
          purpose other than delivering the display setting you chose, which is why no consent is
          required for it under the GDPR or the ePrivacy Directive. If it ever came to carry anything
          else, it would stop being strictly necessary and this page would say so before that shipped.
        </p>

        <h6 style={HEAD}>Local storage and session storage</h6>
        <p>
          <strong>Empty. This interface does not use either.</strong> An earlier version of this page
          listed four <code>localStorage</code> keys — a theme preference, a feed pause state, a
          watchlist and an RPC override. None of them exist in the code, and the page was describing an
          intention rather than a build. It has been corrected rather than quietly amended, because a
          privacy disclosure that overstates what it collects is still an inaccurate privacy
          disclosure.
        </p>
        <p>
          If watchlists or an RPC override are added later they will live in{' '}
          <code>localStorage</code> under a <code>botid.</code> prefix, will stay on your device, and
          will be listed here <em>before</em> the feature ships.
        </p>

        <h3>What we deliberately do not load</h3>
        <div className="table-scroll">
          <table className="table">
            <tbody>
              <tr><td style={{ verticalAlign: 'top', minWidth: 220 }}><strong>Analytics</strong></td><td>None. No Google Analytics, no Plausible, no Fathom, no Vercel Analytics, no self-hosted alternative.</td></tr>
              <tr><td style={{ verticalAlign: 'top' }}><strong>Tag managers</strong></td><td>None. Nothing on this site can inject a script we did not write.</td></tr>
              <tr><td style={{ verticalAlign: 'top' }}><strong>Advertising and conversion pixels</strong></td><td>None, from anyone.</td></tr>
              <tr><td style={{ verticalAlign: 'top' }}><strong>Social embeds</strong></td><td>None. No Twitter/X widgets, no Discord embeds, no YouTube players — all of which set third-party cookies on load.</td></tr>
              <tr><td style={{ verticalAlign: 'top' }}><strong>Third-party fonts</strong></td><td>None. Fonts are self-hosted and served from the same origin, so no font provider learns that you visited.</td></tr>
              <tr><td style={{ verticalAlign: 'top' }}><strong>Third-party CDNs for code</strong></td><td>None. Every script and stylesheet comes from our own build.</td></tr>
              <tr><td style={{ verticalAlign: 'top' }}><strong>Session recording / heatmaps</strong></td><td>None. Nobody is watching your cursor.</td></tr>
              <tr><td style={{ verticalAlign: 'top' }}><strong>Cross-site tracking</strong></td><td>None. There is nothing for Do Not Track or Global Privacy Control to switch off.</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          This is a security property as much as a privacy one: the supply chain you inherit by loading
          this page is our build and nothing else. Frontends in this industry are usually compromised
          through a third-party script, and the cheapest defence is not to have any.
        </p>

        <h3>Things that see you anyway, and are not cookies</h3>
        <p>
          Blocking cookies does not make a blockchain interface private. Two disclosures happen
          regardless of your cookie settings, and they are more revealing than the cookie above:
        </p>
        <ul>
          <li>
            <strong>Your RPC provider</strong> sees your IP address and every call your browser makes
            on your behalf — which agents you looked at, which executions you opened, and when. We do
            not operate those endpoints and cannot limit what they log. Use your own endpoint if this
            matters to you. Where a page is rendered on our server instead, our host makes those calls
            and the provider sees us rather than you — the watcher changes, not the fact of being
            watched.
          </li>
          <li>
            <strong>Your hosting path</strong> — our provider and every network between you and it —
            sees the ordinary web request that fetched this page: IP, user agent, path, timestamp.
          </li>
        </ul>
        <p>
          Your wallet, if you connect one, is governed by its own policy and sees the connection request
          and everything you sign. The <a href="/legal/privacy">privacy policy</a> covers all of this in
          more detail.
        </p>

        <h3>How to remove the cookie</h3>
        <p>
          Clear site data for this domain in your browser settings, or block cookies for it outright.
          The only consequence is that the theme resets to the default and the first paint may briefly
          show the wrong one. Nothing else on the site depends on it, and no feature will stop working.
        </p>

        <h3>If that ever changes</h3>
        <p>
          A consent banner, should one become necessary, will be a bottom-anchored bar with equal-weight
          Accept and Decline buttons, no scrim, no scroll lock, no pre-ticked boxes, and it will never
          cover content on mobile. Declining will be exactly one click and will be respected —
          non-essential cookies will not be set before you choose. We would rather add a banner honestly
          than quietly reclassify a tracking cookie as necessary, which is the standard trick.
        </p>
        <p>
          Material changes move the &ldquo;Last updated&rdquo; date at the top of this page. Questions:{' '}
          <a href="mailto:chidileozoemena@gmail.com">chidileozoemena@gmail.com</a>.
        </p>
      </main>
    </>
  );
}
