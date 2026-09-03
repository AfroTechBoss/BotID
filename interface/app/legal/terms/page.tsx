import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of service',
  description:
    'The basis on which this interface is provided: no custody, no advice, no warranty, what you may and may not do, and the limits of our liability.',
};

const NAV: [string, string][] = [
  ['agreement', 'The agreement'],
  ['what', 'What this is'],
  ['custody', 'No custody'],
  ['fixtures', 'Deployed, no history'],
  ['eligibility', 'Eligibility'],
  ['sanctions', 'Sanctions & jurisdiction'],
  ['use', 'Acceptable use'],
  ['agents', 'If you register an agent'],
  ['consumers', 'If you integrate'],
  ['advice', 'No advice'],
  ['thirdcontent', 'Third-party content'],
  ['ip', 'IP and licensing'],
  ['warranty', 'No warranty'],
  ['liability', 'Limitation of liability'],
  ['assumption', 'Assumption of risk'],
  ['indemnity', 'Indemnity'],
  ['law', 'Governing law'],
  ['disputes', 'Disputes'],
  ['term', 'Termination'],
  ['misc', 'General'],
];

export default function Terms() {
  return (
    <>
      {/* 1fr rather than 68ch — the column takes the screen, .legal-body keeps the measure on the
          paragraphs. Same change as privacy and the risk disclosure. */}
      <div className="doc-shell" style={{ ['--rail-w' as string]: '220px' } as React.CSSProperties}>
        <aside className="doc-rail">
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
        <main className="legal-body">
          <h1 style={{ fontSize: 28 }}>Terms of service</h1>
          <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 10, 2026</p>

          <h3 id="agreement">The agreement</h3>
          <p>
            These terms are a binding agreement between you and the interface operator identified on{' '}
            <a href="/about">about</a> (&ldquo;we,&rdquo; &ldquo;us&rdquo;) governing your use of this
            website. <strong>By accessing or using this interface you accept them.</strong> If you do
            not accept them, do not use the interface.
          </p>
          <p>
            Read them together with the <a href="/legal/disclaimer">risk disclosure</a>, the{' '}
            <a href="/legal/privacy">privacy policy</a> and the{' '}
            <a href="/legal/cookies">cookie notice</a>, which are incorporated here by reference. The
            risk disclosure is the one that will cost you money if you skip it.
          </p>

          <h3 id="what">What this is</h3>
          <p>
            An interface. Nothing more. The BotID protocol — the contracts that hold bonds, route
            executions, verify attestations and score outcomes — is autonomous software deployed to a
            public blockchain. It runs whether or not this website is reachable, and it will keep
            running if we shut this website down tomorrow.
          </p>
          <p>
            We are not a broker, dealer, exchange, custodian, money transmitter, investment adviser,
            fiduciary, credit rating agency, escrow agent or counterparty to anything you do. We do not
            operate BOT Chain, we do not operate the RPC endpoints this page reads from, and we do not
            control any agent listed here. We provide a way to read public data and to compose
            transactions that you sign yourself.
          </p>

          <h3 id="custody">No custody</h3>
          <p>
            The interface never holds your funds and never holds your private keys. Every transaction
            is composed in your browser and signed by your own wallet, then submitted directly to the
            contracts. We cannot move your assets, cannot reverse a transaction, cannot recover a lost
            key or seed phrase, and cannot recover funds sent to a wrong address. Nobody can. If you
            lose access to your wallet, your assets are gone.
          </p>
          <p>
            <strong>We will never ask for your seed phrase or private key.</strong> Anyone who does —
            including anyone claiming to be us — is attempting to steal from you.
          </p>

          <h3 id="fixtures">Deployed, unaudited, and untested by use</h3>
          <p>
            As of the date above, the BotID contracts are <strong>unaudited</strong> and are deployed to
            two chains: Bohr testnet (chain 968) and BOT Chain mainnet (chain 677). Bonds posted on
            mainnet are posted in real USDT and are really at risk. No third-party audit has been
            performed on either set, and none is scheduled.
          </p>
          <p>
            <strong>Nothing has ever executed on mainnet.</strong> No agent is registered on chain 677,
            no execution has been requested, and no settlement has run there. The contracts holding real
            value are the ones with the least operational history behind them.
          </p>
          <p>
            Everything this interface displays is read from those contracts rather than generated —
            but read that in the right direction. Every score that exists today was earned on a{' '}
            <strong>test network</strong>, where the bond token has no value and no agent has ever risked
            anything a person would miss. A score earned there is a real measurement of a rehearsal. It
            is not evidence about how any agent behaves when the money is real.
          </p>
          <p>
            <strong>Do not make any financial decision on the basis of anything displayed here.</strong>{' '}
            See <a href="/security">security</a> for the precise deployment state and the addresses.
          </p>

          <h3 id="eligibility">Eligibility</h3>
          <p>By using this interface you represent and warrant that:</p>
          <ul>
            <li>you are at least 18 years old and have legal capacity to enter this agreement;</li>
            <li>you are acting on your own behalf, or are authorised to act for the entity you represent;</li>
            <li>you have sufficient knowledge of blockchains, smart contracts, digital assets and automated trading systems to evaluate the risks of what you are doing;</li>
            <li>your use complies with every law that applies to you, including securities, derivatives, commodities, tax, anti-money-laundering and sanctions law;</li>
            <li>you are not on any sanctions list and are not accessing this interface from a jurisdiction where doing so is prohibited.</li>
          </ul>

          <h3 id="sanctions">Sanctions and jurisdiction</h3>
          <p>
            You may not use this interface if you are a person or entity designated on any sanctions
            list maintained by the United States, the United Kingdom, the European Union, the United
            Nations, or any other applicable authority, or if you are located in or ordinarily resident
            in a comprehensively sanctioned jurisdiction. You may not use it on behalf of anyone who is.
          </p>
          <p>
            We may block access to this website from any jurisdiction or address at our discretion and
            without notice. Blocking this website does not and cannot block access to the protocol —
            see <a href="#term">termination</a>.
          </p>
          <p>
            Nothing here is an offer or solicitation in any jurisdiction where that would be unlawful.
            We make no representation that this interface is appropriate or available in your location,
            and determining that is your responsibility.
          </p>

          <h3 id="use">Acceptable use</h3>
          <p>You agree not to:</p>
          <ul>
            <li>exploit, or attempt to exploit, any vulnerability in the protocol, this interface or their infrastructure;</li>
            <li>interfere with the operation of either, including denial-of-service, load testing without written permission, or attempts to circumvent rate limits or access controls;</li>
            <li>scrape, crawl or bulk-extract beyond documented endpoints and reasonable use;</li>
            <li>impersonate a registered agent, an operator, a publisher, a consumer protocol, or us;</li>
            <li>submit false input attestations, or report false outcomes at settlement, or otherwise attempt to manipulate any agent&apos;s score;</li>
            <li>use the interface to launder proceeds of crime, to finance terrorism, to evade sanctions, or in furtherance of any unlawful activity;</li>
            <li>reverse-engineer, decompile or tamper with the interface in order to alter what a transaction actually does before a user signs it;</li>
            <li>use the interface or the BotID name to represent to third parties that an agent is endorsed, certified, vetted or guaranteed by us. It is not.</li>
          </ul>
          <p>
            Security research is welcome and is not a breach of these terms when it is conducted
            against a local deployment and reported under the policy on{' '}
            <a href="/security">security</a>. There is currently no authorised live target and no
            safe-harbour commitment, so please do not test against live infrastructure.
          </p>

          <h3 id="agents">If you register an agent</h3>
          <p>
            You are solely responsible for your agent&apos;s code, its model, its operator key, its
            declared risk limits and everything it does. Registering does not make us a party to any
            arrangement between you and a consumer, and it does not make your agent&apos;s conduct our
            responsibility.
          </p>
          <p>
            You accept that <strong>your bond is at risk of being slashed by the protocol</strong> —
            for a lost challenge, for non-delivery, and for the other conditions described in{' '}
            <a href="/docs">docs</a>. Slashing is executed by contract logic, not by us, and it is not
            appealable, reversible or discretionary. Bond remains slashable throughout the unbonding
            period; beginning an exit does not protect it. We cannot restore a slashed bond, adjust a
            score, or intervene in a challenge.
          </p>
          <p>
            You are responsible for your own tax treatment of fees earned, bonds posted and amounts
            slashed. We give no tax advice.
          </p>

          <h3 id="consumers">If you integrate the oracle</h3>
          <p>
            The read API is provided as-is. Your policy thresholds are your decision and your risk. A
            score is a summary of past, counterparty-reported outcomes and is not a prediction — it can
            be stale, it can be based on outcomes a counterparty misreported, and it says nothing about
            an agent&apos;s behaviour in market conditions it has not yet met.
          </p>
          <p>
            <strong>Do not build a system whose only safety property is a BotID score.</strong> If you
            call <code>settle()</code>, you are asserting an outcome that no proof system verifies, and
            you are responsible for asserting it honestly — misreporting corrupts the score of the
            agents you rely on and may expose you to claims from others who relied on it.
          </p>

          <h3 id="advice">No advice</h3>
          <p>
            <strong>Nothing on this website is investment, financial, legal, tax or accounting advice,
            and nothing here is a recommendation to buy, sell, hold or allocate to anything.</strong>{' '}
            Scores, tiers, leverage factors and verification badges are outputs of a deterministic
            formula over reported data. They are not credit ratings in any regulatory sense, they are
            not issued by a registered rating agency, they are not an audit, a licence, a certification
            or an assurance opinion, and they are not a guarantee of any future behaviour or outcome.
          </p>
          <p>
            We are not your adviser or fiduciary. Get independent professional advice before committing
            capital. Read the <a href="/legal/disclaimer">risk disclosure</a>.
          </p>

          <h3 id="thirdcontent">Third-party content</h3>
          <p>
            Agent names and metadata, publisher feed values, consumer-reported outcomes, and any
            external links all originate outside this interface. We display them; we do not verify,
            endorse or accept responsibility for them. Agent-supplied text and links are the
            agent&apos;s statements, not ours, and an agent may misrepresent itself. Following an
            external link takes you somewhere governed by someone else&apos;s terms.
          </p>

          <h3 id="ip">Intellectual property and licensing</h3>
          <p>
            The BotID name and marks belong to us and these terms grant you no licence to use them
            except to refer to the protocol accurately and descriptively. You keep ownership of
            anything you submit; by submitting it for display you grant us a non-exclusive licence to
            display it.
          </p>
          <p>
            <strong>The source code is public but it is not open source.</strong> The protocol, this
            interface and the reference relayer are published under the Business Source License 1.1.
            You may read, audit, modify and run the code for evaluation or on a test network at no
            cost. <strong>Deploying it, or any derivative of it, to a mainnet — or using it in any
            production or customer-facing capacity, whether or not you charge for it — requires a
            separate commercial licence from us.</strong> Making the code visible is not a grant of
            permission to operate it, and the two are routinely confused.
          </p>
          <p>
            Each version converts automatically to the MIT Licence on 13 August 2030, or four years
            after that version was first published, whichever comes first. Versions published before
            13 August 2026 were released under MIT and that grant stands. The full text, the exact
            parameters and the contact address for commercial terms are in the repository&apos;s{' '}
            <code>LICENSE</code> file, which is the operative document and takes precedence over this
            summary; there is a plain-language version in <a href="/docs#license">the docs</a>.
          </p>
          <p>
            Nothing in this section restricts what you may do with the deployed contracts themselves.
            Anyone may transact with a contract that is already on a public chain — that is a property
            of the chain, not a permission we grant — and the licence governs copies of the code, not
            your use of a live deployment.
          </p>

          <h3 id="warranty">No warranty</h3>
          <p>
            <strong>THE INTERFACE AND ALL INFORMATION IN IT ARE PROVIDED &ldquo;AS IS&rdquo; AND
            &ldquo;AS AVAILABLE,&rdquo; WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, TO THE
            MAXIMUM EXTENT PERMITTED BY LAW.</strong> We expressly disclaim all implied warranties of
            merchantability, fitness for a particular purpose, title and non-infringement.
          </p>
          <p>
            We do not warrant that the interface will be available, uninterrupted, timely, secure or
            error-free; that displayed data is accurate, complete or current; that any score correctly
            characterises any agent; that the contracts are free of defects; that any transaction you
            submit will be included, or included at the price or time you expected; or that any defect
            will be corrected. The contracts are unaudited. Smart contract software can contain
            catastrophic bugs that are discovered only when they are exploited.
          </p>

          <h3 id="liability">Limitation of liability</h3>
          <p>
            <strong>TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR ANY INDIRECT,
            INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF
            PROFITS, REVENUE, DATA, GOODWILL, DIGITAL ASSETS OR TRADING OPPORTUNITY,</strong> arising
            out of or relating to your use of this interface or the protocol, on any theory of
            liability, whether or not we were advised of the possibility.
          </p>
          <p>
            In particular and without limiting the above, we are not liable for: losses caused by an
            agent&apos;s conduct or failure; a slashing event; a score you relied on being wrong,
            stale, or based on a misreported outcome; a defect or exploit in the contracts; publisher
            collusion or a false input bundle; a TEE compromise or a trusted-setup compromise; changes
            an owner key makes to protocol parameters; chain congestion, reorganisation, censorship,
            downtime or repricing; RPC or wallet provider failure; your own error, including signing
            the wrong transaction or sending to the wrong address; phishing, a compromised device, or a
            malicious copy of this website.
          </p>
          <p>
            <strong>Our total aggregate liability for all claims relating to this interface will not
            exceed one hundred United States dollars (USD 100).</strong> You acknowledge this cap is a
            fundamental basis of the bargain, and that we could not provide a free, non-custodial
            interface without it.
          </p>
          <p>
            Nothing here excludes liability that cannot lawfully be excluded — including liability for
            fraud, fraudulent misrepresentation, death or personal injury caused by negligence, or any
            other liability your jurisdiction does not permit to be limited. Some jurisdictions do not
            allow certain exclusions, so parts of these two sections may not apply to you.
          </p>

          <h3 id="assumption">Assumption of risk</h3>
          <p>
            You acknowledge that you use this interface and the protocol entirely at your own risk,
            that you may lose some or all of the capital you commit, that you are financially able to
            bear that loss, and that you have read and understood the{' '}
            <a href="/legal/disclaimer">risk disclosure</a>. You release us from all claims, demands
            and damages arising out of any dispute between you and any agent, operator, publisher or
            consumer protocol.
          </p>

          <h3 id="indemnity">Indemnity</h3>
          <p>
            You agree to indemnify, defend and hold harmless us and our operators, contributors and
            affiliates from any claim, loss, liability, damage, cost or expense — including reasonable
            legal fees — arising from your use of the interface or the protocol, your breach of these
            terms or of any law, your infringement of any third party&apos;s rights, or, if you operate
            an agent, anything your agent does.
          </p>

          <h3 id="law">Governing law</h3>
          <p>
            These terms are governed by the laws of the Federal Republic of Nigeria, without regard to
            conflict-of-laws rules, and the courts of Nigeria have exclusive jurisdiction — except
            where the mandatory consumer-protection law of your country of residence gives you a right
            to your local courts, which these terms do not attempt to remove.
          </p>

          <h3 id="disputes">Disputes</h3>
          <p>
            Before starting proceedings, please write to{' '}
            <a href="mailto:chidileozoemena@gmail.com">chidileozoemena@gmail.com</a> with a description of the
            dispute and the outcome you want, and allow 30 days for us to try to resolve it. Claims
            must be brought individually; you agree not to bring any claim as a class, collective or
            representative action. Any claim must be brought within one year of the event giving rise
            to it, to the extent your jurisdiction allows such a limit.
          </p>

          <h3 id="term">Termination</h3>
          <p>
            We may suspend or withdraw your access to this website at any time, for any reason,
            without notice, and we may discontinue the website entirely. Provisions that by their
            nature should survive — no warranty, limitation of liability, indemnity, assumption of
            risk, governing law, disputes — survive termination.
          </p>
          <p>
            <strong>We cannot withdraw your access to the protocol. Nobody can.</strong> It is
            autonomous software on a public chain: contracts do not check terms of service, and losing
            this website changes nothing about your on-chain position or obligations. If we disappear,
            your bond, your open exposure and your unbonding queue all continue exactly as the
            contracts specify.
          </p>

          <h3 id="misc">General</h3>
          <p>
            These terms, with the documents they incorporate, are the entire agreement between us on
            this subject. If any provision is held unenforceable, it is limited or severed to the
            minimum extent necessary and the rest stays in force. Our failure to enforce a provision is
            not a waiver of it. You may not assign this agreement; we may assign it to a successor.
            Nothing in it creates a partnership, agency, employment or joint venture. We may change
            these terms, and material changes move the &ldquo;Last updated&rdquo; date above —
            continued use after a change means you accept the revised terms, and if you do not, stop
            using the interface.
          </p>
          <p className="text-muted" style={{ fontSize: 13 }}>
            These terms have not been reviewed by a qualified lawyer and are not legal advice. They
            should be reviewed by counsel in the relevant jurisdictions before this interface serves
            users in production.
          </p>
        </main>
      </div>
    </>
  );
}
