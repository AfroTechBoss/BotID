import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'What this interface collects, what your browser discloses regardless, what is permanent on chain, and the rights you have over each.',
};

const NAV: [string, string][] = [
  ['summary', 'Summary'],
  ['controller', 'Who is responsible'],
  ['collect', 'What we collect'],
  ['browser', 'What your browser sends'],
  ['chain', 'On-chain data'],
  ['local', 'Browser storage'],
  ['analytics', 'Analytics'],
  ['alerts', 'Alerts'],
  ['cookies', 'Cookies'],
  ['third', 'Third parties'],
  ['basis', 'Legal basis'],
  ['retention', 'Retention'],
  ['transfers', 'International transfers'],
  ['rights', 'Your rights'],
  ['security', 'Security'],
  ['children', 'Children'],
  ['dnt', 'Do Not Track'],
  ['changes', 'Changes & contact'],
];

const STORAGE: [string, string, string][] = [
  ['botid-theme (cookie)', 'Holds the literal string "light" or "dark". Read on the server during render so the first paint matches your preference instead of flashing the wrong theme. Carries no identifier. path=/; SameSite=Lax.', '1 year'],
];

const THIRD: [string, string, string][] = [
  ['RPC provider (BOT Chain public endpoints)', 'Your IP address and every call this page makes on your behalf — which agents you looked at, which executions you opened, when. This is the most revealing disclosure on this page.', 'We do not operate these endpoints and cannot limit what they log. You can point the interface at your own endpoint, or run one.'],
  ['Your wallet (extension or WalletConnect)', 'The connection request, your address once you approve it, and the contents of anything you sign.', 'Governed by your wallet’s own privacy policy, not ours.'],
  ['Hosting provider', 'Standard web-server request logs — IP, user agent, path, timestamp — for serving static files.', 'Unavoidable for anything served over HTTP.'],
  ['Analytics', 'Nothing today. No analytics script is loaded.', 'If this ever changes it will be cookieless and aggregate, and this table will say so before it ships.'],
];

const RIGHTS: [string, string][] = [
  ['Access', 'Ask what we hold about you. For most visitors the honest answer is nothing.'],
  ['Rectification', 'Correct anything inaccurate — in practice, a webhook URL or a threshold.'],
  ['Erasure', 'Have it deleted. Applies to alert configuration; it cannot apply to on-chain records or to your own browser storage, which only you can clear.'],
  ['Portability', 'Receive it in a machine-readable form.'],
  ['Objection and restriction', 'Object to processing, or ask us to restrict it.'],
  ['Withdraw consent', 'Where processing rests on consent, withdraw it at any time. Deleting an alert is the withdrawal.'],
  ['Complain to a regulator', 'You may complain to your local data protection authority instead of, or as well as, contacting us.'],
];

export default function Privacy() {
  return (
    <>
      {/* 1fr, not 68ch: the article column takes what the screen has left after the nav rail, and
          the measure lives on the paragraphs inside it (see .legal-body). The tables here are the
          reason — they were being squeezed into a reading column. */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 'var(--space-8)', padding: 'var(--space-8) var(--space-6)', flex: 1 }}>
        <aside style={{ position: 'sticky', top: 'var(--space-6)', alignSelf: 'start', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
        <main className="legal-body">
          <h1 style={{ fontSize: 28 }}>Privacy policy</h1>
          <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 10, 2026</p>

          <h3 id="summary">Summary</h3>
          <p>
            There is no account, no sign-up and no password. We do not ask for your name, your email
            or your wallet address, and we do not create a profile of you. There is no analytics
            script, no tag manager, no advertising pixel and no third-party font request. If you never
            configure an alert, this site holds no personal data about you at all.
          </p>
          <p>
            That is unusually little for a product in this space, and it is a deliberate design
            property rather than a promise we are asking you to take on faith — you can verify it by
            watching your browser&apos;s network tab.
          </p>
          <p>
            <strong>What follows is the part people skip and shouldn&apos;t.</strong> Using a
            blockchain interface discloses information to parties that are not us, and some of it is
            permanent. Those sections are below, and they are the ones that matter.
          </p>

          <h3 id="controller">Who is responsible</h3>
          <p>
            This interface is operated by the interface operator identified on{' '}
            <a href="/about">about</a>, who is the data controller for the limited processing
            described here. Contact <a href="mailto:privacy@botid.example">privacy@botid.example</a>.
          </p>
          <p>
            The BotID protocol is a set of smart contracts. Nobody is the controller of on-chain data
            in any sense a data protection regime can act on: there is no operator who can amend or
            delete a block. Where this policy distinguishes &ldquo;us&rdquo; from &ldquo;the
            protocol,&rdquo; the distinction is load-bearing.
          </p>

          <h3 id="collect">What we collect</h3>
          <p>By default, nothing tied to an identity. Specifically:</p>
          <ul>
            <li><strong>No account data</strong> — there are no accounts.</li>
            <li><strong>No wallet address collection.</strong> If you connect a wallet, the address is used in your browser to render your view. We do not transmit it to a server of ours, because there isn&apos;t one.</li>
            <li><strong>No behavioural profiling, no ad targeting, no data sales.</strong> We do not sell, rent or share personal data with anyone for their own purposes, and we do not receive payment for anything of the sort.</li>
            <li><strong>Alert configuration, if you create one.</strong> The webhook URL you supply, the threshold you set, and the agent id you are watching. Nothing else — no email unless the webhook you give us is an email relay, in which case you have chosen that.</li>
          </ul>
          <p>
            Do not put anything sensitive in a webhook URL. It is stored as you typed it and it is
            transmitted to the endpoint you named.
          </p>

          <h3 id="browser">What your browser sends anyway</h3>
          <p>
            Independently of us, and unavoidably: your RPC provider sees your IP address and the
            specific calls this page makes while it reads chain state. That is a meaningful
            disclosure. The pattern of calls reveals which agents you are researching and when, and
            correlating it with an address you later transact from is not difficult for whoever holds
            those logs. Your wallet provider sees the connection request the moment you click
            &ldquo;Connect wallet,&rdquo; and sees everything you sign. Your hosting provider — and
            every network between you and it — sees the request that fetched this page.
          </p>
          <p>
            None of those parties is us, and none of them is bound by this policy. If that matters to
            you, use your own RPC endpoint and a network path you trust.
          </p>

          <h3 id="chain">On-chain data</h3>
          <p>
            <strong>Anything you transact through the protocol is public, permanent, and outside
            anyone&apos;s control — including ours.</strong> Addresses, amounts, timestamps, agent
            ids, commitments, scores and outcomes are written to a public ledger, replicated by every
            node, and indexed by explorers and analytics firms worldwide within seconds.
          </p>
          <p>
            There is no delete. There is no correction. There is no right to erasure that any operator
            can honour, because there is no operator. A blockchain address is pseudonymous, not
            anonymous, and it becomes identifying the moment it touches an exchange, a bridge, a
            donation or anything else that knows your name. Assume that anything you do on chain is
            permanently attributable to you at some point in the future, and decide what to do on that
            basis before you sign.
          </p>

          <h3 id="local">Browser storage</h3>
          <p>
            <strong>This interface uses no <code>localStorage</code> and no{' '}
            <code>sessionStorage</code> at all.</strong> One cookie is set, listed below, and clearing
            site data removes it. An earlier version of this policy listed four local-storage keys that
            do not exist in the build; the correction is recorded on the{' '}
            <a href="/legal/cookies">cookie notice</a> rather than made silently.
          </p>
          <table className="table">
            <thead><tr><th>Name</th><th>Purpose</th><th>Lifetime</th></tr></thead>
            <tbody>
              {STORAGE.map(([k, p, l]) => (
                <tr key={k}>
                  <td style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
                  <td>{p}</td>
                  <td style={{ verticalAlign: 'top' }}>{l}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 id="analytics">Analytics</h3>
          <p>
            None. No analytics product is loaded by this site today. Should that change, it will be
            cookieless, aggregate, never joined to a wallet address, and disclosed in this policy and
            in the <a href="/legal/cookies">cookie notice</a> before it goes live.
          </p>

          <h3 id="alerts">Alerts</h3>
          <p>
            Score-threshold alerts are configured in the <a href="/portal">portal</a>, which states
            whether they are client-side only or backed by a server in the current build. A
            client-side alert never leaves your browser. A server-backed alert stores the three fields
            listed above and calls your webhook; delete the alert and the record goes with it.
          </p>

          <h3 id="cookies">Cookies</h3>
          <p>
            One cookie, for the theme, so the first server-rendered paint matches your preference. It
            is strictly necessary, carries no identifier and is not used for tracking, which is why
            there is no consent banner. Full accounting in the{' '}
            <a href="/legal/cookies">cookie notice</a>.
          </p>

          <h3 id="third">Third parties</h3>
          <table className="table">
            <thead><tr><th style={{ minWidth: 180 }}>Party</th><th>What they see</th><th>Note</th></tr></thead>
            <tbody>
              {THIRD.map(([party, sees, note]) => (
                <tr key={party}>
                  <td style={{ verticalAlign: 'top' }}><strong>{party}</strong></td>
                  <td>{sees}</td>
                  <td>{note}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 id="basis">Legal basis for processing</h3>
          <p>Where the GDPR, UK GDPR or a comparable regime applies:</p>
          <ul>
            <li><strong>Consent</strong> for alert configuration. You supply it; you can withdraw it by deleting the alert.</li>
            <li><strong>Legitimate interests</strong> for server logs kept to serve the site securely and to diagnose faults. The interest is operating the site; the processing is minimal and not used to profile anyone.</li>
            <li><strong>Not applicable</strong> to on-chain data, which we neither determine the purposes of nor have the means to change.</li>
          </ul>

          <h3 id="retention">Retention</h3>
          <ul>
            <li><strong>Alert configuration:</strong> until you delete it.</li>
            <li><strong>Server request logs:</strong> for as long as the hosting provider&apos;s default retention, which is short and outside our control in its details.</li>
            <li><strong>Local storage and the theme cookie:</strong> on your device until you clear it.</li>
            <li><strong>On-chain records:</strong> forever, by everyone. See above.</li>
          </ul>

          <h3 id="transfers">International transfers</h3>
          <p>
            Static assets are served from a globally distributed edge network, so the request that
            delivered this page was almost certainly handled outside your country. Blockchain data is
            replicated by nodes worldwide with no geographic boundary of any kind. Where we hold
            personal data — the small amount described above — transfers rely on the standard
            safeguards our providers offer. If cross-border transfer is unacceptable to you, this
            interface cannot be made to satisfy that constraint.
          </p>

          <h3 id="rights">Your rights</h3>
          <p>
            You have the rights below over data we hold, which for most visitors is nothing. Write to{' '}
            <a href="mailto:privacy@botid.example">privacy@botid.example</a>; we will respond within
            30 days and will not charge you for a first request.
          </p>
          <table className="table">
            <tbody>
              {RIGHTS.map(([r, d]) => (
                <tr key={r}>
                  <td style={{ verticalAlign: 'top', minWidth: 180 }}><strong>{r}</strong></td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <strong>The limit is worth restating.</strong> No exercise of any right can remove data
            from a blockchain, and no request to us can. If you are a California resident: we do not
            sell or share personal information as those terms are defined by the CCPA/CPRA, we do not
            use it for cross-context behavioural advertising, and we have no financial incentive
            program to disclose.
          </p>

          <h3 id="security">How this data is protected</h3>
          <p>
            The site is statically rendered with no server-side secrets and no database of ours in the
            request path. That is the strongest privacy control available, because data that is never
            collected cannot be breached. Where alert configuration is stored server-side, it is
            transmitted over TLS and access is limited to the operator. We cannot guarantee absolute
            security of any transmission over the internet, and we will not claim otherwise.
          </p>

          <h3 id="children">Children</h3>
          <p>
            This interface is not directed at, and is not intended for use by, anyone under 18. We do
            not knowingly collect data from children. If you believe a child has provided us data,
            write to the address above and we will delete it.
          </p>

          <h3 id="dnt">Do Not Track and Global Privacy Control</h3>
          <p>
            We do not track you across sites, so there is nothing for these signals to switch off.
            They are honoured trivially by there being no tracking to begin with.
          </p>

          <h3 id="changes">Changes and contact</h3>
          <p>
            Material changes move the &ldquo;Last updated&rdquo; date at the top of this page.
            Continued use after a change means you accept the revised policy; if you do not, stop
            using the interface. Questions:{' '}
            <a href="mailto:privacy@botid.example">privacy@botid.example</a>.
          </p>
          <p className="text-muted" style={{ fontSize: 13 }}>
            This policy is written to be accurate about a product that collects almost nothing. It is
            not legal advice, and it has not been reviewed by counsel.
          </p>
        </main>
      </div>
    </>
  );
}
