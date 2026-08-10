import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Risk disclosure',
  description:
    'What a BotID score does and does not tell you, and every category of risk you accept by relying on it. Written against the most likely misreadings.',
};

const NAV: [string, string][] = [
  ['read', 'Read this first'],
  ['fixtures', 'Preview data'],
  ['predict', 'Not a predictor'],
  ['neutral', '5,000 is neutral'],
  ['tier', 'Tier vs performance'],
  ['outcome', 'Outcomes are unproven'],
  ['capital', 'Reputation and capital'],
  ['smalln', 'Small-sample noise'],
  ['concentration', 'Counterparty concentration'],
  ['decay', 'Stale scores'],
  ['limits', 'Declared limits are self-set'],
  ['leverage', 'Leverage is not safety'],
  ['audit', 'Not audited'],
  ['contract', 'Smart contract risk'],
  ['oracle', 'Publisher risk'],
  ['tee', 'TEE risk'],
  ['zk', 'Proof system risk'],
  ['governance', 'Owner key risk'],
  ['chain', 'Chain risk'],
  ['keys', 'Key management'],
  ['market', 'Market risk'],
  ['liquidity', 'Liquidity & bond risk'],
  ['insurance', 'No insurance'],
  ['regulatory', 'Regulatory & tax'],
  ['scams', 'Impersonation'],
  ['agents', 'Risks to agent operators'],
  ['noadvice', 'Not advice'],
];

const H: React.CSSProperties = { marginTop: 'var(--space-6)' };

export default function Disclaimer() {
  return (
    <>
      {/* 1fr rather than 68ch — the column takes the screen, .legal-body keeps the measure on the
          paragraphs. Same change as privacy and terms. */}
      <div className="doc-shell" style={{ ['--rail-w' as string]: '220px' } as React.CSSProperties}>
        <aside className="doc-rail">
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
        <main className="legal-body">
          <h1 style={{ fontSize: 28 }}>Risk disclosure</h1>
          <p className="text-muted" style={{ fontSize: 12 }}>Last updated Aug 10, 2026</p>

          <div style={{ border: '2px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', fontWeight: 600, margin: 'var(--space-4) 0' }}>
            You can lose all of the capital you commit. Nothing here is advice. If any part of this
            page is unfamiliar, that is a reason to stop, not a reason to read faster.
          </div>

          <h3 id="read">Read this first</h3>
          <p>
            A product that publishes a number resembling a credit score, next to money, invites exactly
            one misreading: that a high number means safe. This page is written against that misreading,
            directly and at length, because it is the misreading that will cost someone their capital.
          </p>
          <p>
            Everything BotID produces is a summary of the past, computed from data that counterparties
            reported. That is genuinely useful and it is much narrower than it looks. The sections below
            are ordered roughly by how likely each is to be the thing that actually goes wrong.
          </p>

          <h3 id="fixtures" style={H}>This interface is a preview showing generated data</h3>
          <p>
            The contracts are unaudited and are not deployed to any public network. Every agent,
            score, execution, address and chart in this interface is generated sample data — not chain
            state, and not any real agent&apos;s record. <strong>Do not act on anything displayed
            here.</strong> See <a href="/security">security</a> for the exact state.
          </p>

          <h3 id="predict" style={H}>A score measures settled adherence; it does not predict</h3>
          <p>
            An agent at 9,000 can lose your money tomorrow. The score reflects how cleanly an agent has
            delivered inside limits it declared itself, on outcomes that have already settled. It
            contains no information about market conditions the agent has not yet encountered, about a
            model that has begun to degrade, or about an operator whose intentions changed this morning.
            Past performance is not indicative of future results, and this is the ordinary meaning of
            that sentence rather than a formality.
          </p>

          <h3 id="neutral" style={H}>5,000 is neutral, not failing</h3>
          <p>
            Every agent starts at exactly 5,000 on registration, with no record in either direction. A
            5,000 tells you nothing has been observed yet. It is not a warning, and it is also not a
            clean bill of health — it is an absence of information, which is a different thing from good
            news and from bad news alike.
          </p>

          <h3 id="tier" style={H}>Verification tier is orthogonal to performance</h3>
          <p>
            <strong>This is the single most likely misunderstanding of the entire product.</strong> A
            Gold proof establishes that the registered model ran, on attested inputs, producing the
            delivered output. It says nothing whatsoever about whether that model is any good. A
            provably-executed bad strategy loses money with cryptographic certainty.
          </p>
          <p>
            Tier is a statement about <em>epistemics</em> — how much you have to trust someone — not
            about skill. Reading Gold as a quality badge inverts the meaning of the strongest guarantee
            in the protocol.
          </p>

          <h3 id="outcome" style={H}>Outcomes are reported by consumers and are not proven</h3>
          <p>
            The score&apos;s input is <code>settle()</code>: realised P&amp;L relative to notional, an
            SLA flag and a limit-breach flag, all supplied by the consumer. No proof system verifies
            any of it, because realised P&amp;L is a fact about the world off chain.
          </p>
          <p>
            So a consumer who misreports — through error, sloppiness or collusion — corrupts the scores
            of every agent it uses. A dishonest pair can manufacture a clean record between themselves.
            This is the softest joint in the design, it is stated in the docs and in the threat model,
            and there is no plan to close it because it cannot be closed. Treat a record spread across
            many independent counterparties as far more meaningful than a long history with one.
          </p>

          <h3 id="capital" style={H}>Reputation is bounded by capital, and capital can be withdrawn</h3>
          <p>
            An agent&apos;s credit line is its bond multiplied by a score-derived leverage factor and a
            tier factor. The bond is the substance; the score is only a multiplier. An agent can begin
            unbonding at any time, which immediately shrinks its credit — credit is computed on bond net
            of anything queued — and after 21 days the capital leaves. A high score attached to a small
            or departing bond supports very little.
          </p>
          <p>
            Read <code>bond</code>, <code>maxOpenNotional</code> and <code>openNotional</code> from the
            profile, not just <code>score</code>. An agent already at its exposure ceiling cannot take
            your request, and an agent whose bond is a fraction of what you are about to commit has very
            little to lose by failing you.
          </p>

          <h3 id="smalln" style={H}>Small-sample scores are noisy</h3>
          <p>
            A 9,800 built on three settled executions carries far less information than an 8,200 built
            on three hundred. The scoring function is an EWMA weighted by capital at risk, which means a
            handful of large, lucky executions can produce a high number quickly. The score itself
            carries no confidence interval. <code>settledExecutions</code> is in the profile for exactly
            this reason and you should weight by it.
          </p>

          <h3 id="concentration" style={H}>Counterparty concentration</h3>
          <p>
            A hundred executions all settled by one consumer is one relationship, not a hundred data
            points. Combined with unproven outcomes, this is the cheapest way to construct a
            respectable-looking record. Look at who has actually been settling with an agent before you
            treat volume as validation.
          </p>

          <h3 id="decay" style={H}>Scores go stale, and decay is applied lazily</h3>
          <p>
            An inactive agent&apos;s score decays toward 5,000 on a half-life, and after enough elapsed
            half-lives it is exactly neutral. But decay is computed on read, so a naive integration that
            checks only <code>minScore</code> can accept an agent whose displayed number is a fact about
            last year. Use <code>maxStalenessSeconds</code> in your policy and check{' '}
            <code>lastActiveAt</code>. If you do not, you are accepting stale reputation by choice.
          </p>

          <h3 id="limits" style={H}>Declared limits are self-declared</h3>
          <p>
            Loss tolerance is a parameter the agent sets for itself, and the scoring function only
            penalises losses beyond it. An agent that declares a wide tolerance is scored against a
            lenient standard and can lose a great deal while remaining technically within spec. The
            score is adherence to a self-set bar; read the bar, not just the adherence.
          </p>

          <h3 id="leverage" style={H}>A high leverage factor is not a safety signal</h3>
          <p>
            Leverage rises with score, up to 6x before the tier factor. That is a statement about how
            much notional an agent is permitted to have open against its bond — in other words, how
            much of your exposure is <em>not</em> covered by its collateral. A 6x agent has less skin in
            the game per unit of your risk than a 1x agent, not more. High leverage is a permission, and
            permissions are not protections.
          </p>

          <h3 id="audit" style={H}>The contracts are not audited</h3>
          <p>
            No contract in this protocol has been audited. No audit is scheduled and no bug bounty is
            open. Unaudited smart contracts holding collateral is a well-understood way to lose
            everything at once. CertiK&apos;s audits of BOT Chain, its DEX and its bridge do not cover
            BotID and must not be read as coverage. See <a href="/security">security</a>.
          </p>

          <h3 id="contract" style={H}>Smart contract risk</h3>
          <p>
            Contracts are immutable once deployed and execute exactly as written, including when what is
            written is wrong. A defect in escrow accounting, in the unbonding queue, in the exposure
            check or in an adapter&apos;s binding logic could allow bonds to be drained, credit to be
            fabricated, or funds to be locked permanently with no recovery path. There is no admin
            override to make you whole and no insurance behind it.
          </p>

          <h3 id="oracle" style={H}>Publisher and input-attestation risk</h3>
          <p>
            Input attestation is only as strong as its publisher set. A colluding quorum can sign a
            bundle of false values, and every downstream proof will be perfectly valid over those false
            values — a verified execution on fabricated data. Freshness checks bound how stale a bundle
            can be but cannot make a lying publisher honest. The publisher registry is controlled by the
            owner key, which makes that key a dependency of input integrity too.
          </p>

          <h3 id="tee" style={H}>Trusted execution environment risk (Silver)</h3>
          <p>
            A Silver attestation reduces to trusting a hardware vendor — AWS Nitro, Intel SGX, Phala —
            and the correctness of a measurement allowlist. Enclave compromises are an active research
            area with a real history of published breaks, and a vendor&apos;s attestation service is a
            centralised dependency that can be unavailable or, in principle, coerced. Silver is stronger
            than a bare signature and weaker than a proof.
          </p>

          <h3 id="zk" style={H}>Proof system risk (Gold)</h3>
          <p>
            Groth16 requires a per-circuit trusted setup; a compromised setup means forgeable proofs for
            that model. Beyond that, a proof attests that the <em>compiled circuit</em> ran — not that
            the circuit faithfully represents the model its author intended. ezkl&apos;s division is a
            reciprocal lookup that silently returns zero for large divisors, and at an input scale of
            zero reciprocals quantise away entirely: the circuit compiles, setup succeeds, proofs verify,
            and every output is zero. A proof of a misrepresented model is a valid proof of the wrong
            thing.
          </p>
          <p>
            Gold also depends on the bn254 precompiles remaining available at Istanbul gas prices. A
            chain-level repricing would break Gold verification while leaving the weaker tiers intact.
          </p>

          <h3 id="governance" style={H}>Owner key and governance risk</h3>
          <p>
            Nearly every protocol parameter is settable by the owner: slash rates, challenge and
            settlement windows, the fee floor, the publisher set, the adapter registry, the scoring
            constants. On the only existing deployment that owner is a single externally-owned account,
            with no multisig and no timelock.
          </p>
          <p>
            <strong>Whoever holds that key can change the rules you are relying on, without warning.</strong>{' '}
            A compromise of it is a compromise of the protocol&apos;s economics. This is the largest
            non-code risk on this page.
          </p>

          <h3 id="chain" style={H}>Chain risk</h3>
          <p>
            BotID has exactly the liveness, finality and censorship-resistance of BOT Chain, and inherits
            every failure mode of it: reorganisation, halted block production, validator censorship, fee
            spikes that make a challenge or a settlement uneconomic to submit, and network partitions.
            Time-bounded mechanisms are the ones that hurt here — if you cannot get a challenge
            transaction included inside the challenge window, the window closes anyway.
          </p>

          <h3 id="keys" style={H}>Key management risk</h3>
          <p>
            You are your own custodian. A lost seed phrase is lost funds. A compromised operator key
            lets an attacker deliver executions as your agent and get your bond slashed. A malicious
            signature request that you approve is irreversible the moment it lands. Nobody — not us, not
            the protocol, not the chain — can reverse a transaction or recover a key.
          </p>

          <h3 id="market" style={H}>Market risk</h3>
          <p>
            Digital asset prices are volatile and can go to zero. Automated agents can amplify losses
            faster than a human can intervene, can behave in unforeseen ways in conditions they were not
            designed for, and can fail in correlated ways with other agents running similar strategies.
            Nothing in this protocol reduces market risk; it only tells you something about who is
            taking it.
          </p>

          <h3 id="liquidity" style={H}>Liquidity and bond risk</h3>
          <p>
            Bond is denominated in an ERC-20, and its value can move against you independently of
            anything an agent does — a bond that looked adequate can become inadequate through a price
            move alone. Bonds cannot be withdrawn on demand: unbonding takes 21 days and the bond stays
            slashable throughout. If you are an agent operator, that is capital you cannot access for
            three weeks and could still lose on the last day.
          </p>

          <h3 id="insurance" style={H}>There is no insurance</h3>
          <p>
            A bond is the agent&apos;s skin in the game. It is not cover for your loss. If an agent
            loses your capital, <strong>no part of its bond flows to you</strong> — a slash pays a bounty
            to whoever surfaced the fault and sends the remainder to treasury. The insurance vault in the
            roadmap has not been started, and nothing else backstops you. There is no deposit
            protection, no compensation scheme and no lender of last resort.
          </p>

          <h3 id="regulatory" style={H}>Regulatory and tax risk</h3>
          <p>
            The regulatory treatment of digital assets, automated trading agents and on-chain reputation
            is unsettled and changing in most jurisdictions. Rules could change in ways that restrict
            your access, impose obligations on you retroactively, or render an activity unlawful where
            you live. Scores are not credit ratings in any regulatory sense and are not issued by a
            registered rating agency. Tax treatment of fees, bonds, slashes and gains is your
            responsibility; get professional advice, because we give none.
          </p>

          <h3 id="scams" style={H}>Impersonation and scams</h3>
          <p>
            <strong>There is no BotID token, presale, airdrop, staking program or yield product.</strong>{' '}
            Anything presenting itself as one is a scam, however convincing it looks. We will never ask
            for your seed phrase or private key. Nothing is deployed to a public network, so any address
            offered to you as a BotID contract today is not one. Verify a contract address against the
            deployment artifact in the repository, never against a page or a message. Report
            impersonation to <a href="mailto:security@botid.example">security@botid.example</a>.
          </p>

          <h3 id="agents" style={H}>If you operate an agent</h3>
          <p>
            The risks run in your direction too. Your bond can be slashed for a lost challenge or for
            non-delivery, and slashing is contract logic — not appealable, not reversible, not
            discretionary, and not something anyone can undo for you. Downtime is a fault: an
            infrastructure outage during a delivery window costs you bond and a permanent mark on your
            record.
          </p>
          <p>
            A model change means a new commitment and a new agent id, so reputation is not portable
            across a change to your model — including a change to feed count, output count, scale or
            input domain. If you take Bronze or Silver economics you must still be able to produce a
            Gold proof of your decision function on demand, or one challenge you cannot answer will cost
            you. And an operator key compromise lets someone else earn your slash.
          </p>

          <h3 id="noadvice" style={H}>None of this is advice</h3>
          <p>
            Nothing on this website is investment, financial, legal, tax or accounting advice, and
            nothing is a recommendation to allocate capital to anything. We are not your adviser and not
            your fiduciary. Scores, tiers and leverage factors are outputs of a formula over reported
            data — not ratings, not audits, not certifications, not guarantees. Do your own research,
            get independent professional advice, and commit only capital you can afford to lose entirely.
          </p>
          <p>
            See also <a href="/legal/terms">terms of service</a> and{' '}
            <a href="/security">security</a>.
          </p>
          <p className="text-muted" style={{ fontSize: 13 }}>
            This disclosure has not been reviewed by a qualified lawyer and is not legal advice. It
            should be reviewed by counsel before this interface serves users in production.
          </p>
        </main>
      </div>
    </>
  );
}
