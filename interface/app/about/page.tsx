import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About',
  description:
    'What BotID is, the problem it addresses, the four attacks it is designed around, what it deliberately does not do, and who operates this interface.',
};

// The narrative page. It is allowed to argue a position, but not to make a claim the contracts do
// not support — so the "does not do" section is as long as the pitch, and the design-decision
// section shows its work rather than asserting good judgement.

const ATTACKS: [string, string][] = [
  [
    'Sybil reputation',
    'Reputation is bonded to capital rather than to a free identity, so registering twenty agents creates twenty bonds to fund, not twenty reputations. Capacity is derived from bond and the score is weighted by capital at risk, so dust volume moves nothing.',
  ],
  [
    'Unfalsifiable claims',
    'Every execution carries an attestation — a bonded signature, an enclave measurement, or a proof — bound to a specific request, model, input commitment and output. Optimistic tiers sit in a challenge window in which anyone can force the agent to produce a proof or be slashed.',
  ],
  [
    'Score inflation',
    'Score moves only on settled economic outcomes, weighted by capital at risk, and never on proof validity alone. A perfectly verified execution that breached its declared limits scores badly. Verifying that you did the thing is not the same as the thing having gone well.',
  ],
  [
    'Liveness faults going unpunished',
    'A commissioned execution that never arrives is a fault: bond is slashed, exposure released, and a permanent counter increments outside the score where a run of good outcomes cannot smooth it away. This is how agents actually fail — invalid proofs simply revert.',
  ],
];

const NOTDO: [string, string][] = [
  ['It does not certify that an agent is good', 'A score summarises how cleanly an agent has delivered inside limits it declared itself, on outcomes reported by its counterparties. It is a summary of history, not a prediction and not an endorsement.'],
  ['It does not prove profitability', 'quality() is deliberately not linear in P&L. Paying score for profit would pay score for taking risk with someone else’s capital.'],
  ['It does not verify the outcome', 'Realised P&L is a fact about the world off chain. The consumer reports it and nothing proves it. This is the softest joint in the design and we would rather say so than bury it.'],
  ['It does not prove LLM agents', 'ZK-ML today proves small numeric models. The Gold tier covers those; anything larger relies on an enclave or a bond. No amount of protocol design changes what is provable.'],
  ['It does not insure you', 'A bond is the agent’s skin in the game. If an agent loses your capital, none of its bond flows to you. The insurance vault in the roadmap has not been started.'],
  ['It does not give advice', 'Nothing here is investment, legal, tax or accounting advice, and no part of it is a recommendation to allocate to anything.'],
  ['It does not custody anything', 'This interface holds no funds and no keys, and the protocol holds bonds only as per-agent collateral in an ERC-20 it never lends out.'],
  ['It is not governance, and not a token', 'There is no BotID token, no presale, no airdrop and no staking program. Anything presenting itself as one is a scam.'],
];

const DECISIONS: [string, string][] = [
  [
    'Why three verification tiers instead of proofs only',
    'A proof-only protocol would address the sliver of agents that are small numeric models and would be honest about a guarantee almost nobody could buy. Three tiers let an LLM agent participate on a bond today while a numeric model gets cryptographic finality, and challenge escalation means the weak tiers are still backstopped by the strong one: the happy path never pays for a proof, but the agent must be able to produce one on demand.',
  ],
  [
    'Why the score is weighted by capital, not by count',
    'A count-weighted score is a farming target — thousands of trivial executions buy a number you then spend once, at size. Weighting by min(notional, weightCap) means a score can only be earned at roughly the size at which it will be used, and an execution with zero at risk moves nothing at all.',
  ],
  [
    'Why scores decay toward neutral',
    'Reputation that never decays is an asset that can be earned once and sold later. Decay on a half-life means a dormant high score converges to neutral, which caps the resale value of a Sybil farm and stops a two-year-old record being traded as a current one.',
  ],
  [
    'Why faults sit outside the score',
    'Anything folded into an average can be diluted by volume. A liveness failure or a lost challenge applies a multiplicative haircut and increments a counter consumers read independently — so maxFaults: 0 is a policy a consumer can actually enforce.',
  ],
  [
    'Why the consumer supplies the input commitment',
    'The original design let an agent prove that its model ran, without constraining what it ran on. That permits a perfectly valid proof over fabricated prices — a theft that verifies. Inputs are now a quorum-signed publisher bundle, checked for freshness and bound into the attestation, and committed with a salt so publishing the commitment does not leak the numbers to the agent about to be graded on them.',
  ],
  [
    'Why credit is a step function',
    'Continuous leverage means every marginal score point silently moves a capital ceiling, and it invites optimising against the fourth decimal place. Five steps make the consequence of a score legible and make small movements consequence-free.',
  ],
  [
    'Why the fee has a floor',
    'The protocol takes 5% of a fee that its two counterparties jointly choose, so unfloored the answer is fee = 0 and a side agreement. The floor is denominated in notional — the one number in a request that is expensive to misreport in either direction, since it is capped by bond-derived credit and is the weight of the score update.',
  ],
  [
    'Why reads are free',
    'Metering getProfile would make the oracle something nobody integrates, and an unread score is worth nothing regardless of how well it is computed. Off-chain callers pay nothing; on-chain callers pay gas to validators, not to us.',
  ],
];

export default function About() {
  return (
    <>
      {/* Full width. Where width would otherwise buy nothing but longer lines it buys columns
          instead, so no line of body copy is longer than it was under the old measure. */}
      <main className="legal-body" style={{ padding: 'var(--space-8) var(--space-6)' }}>
        <h1 style={{ fontSize: 28 }}>About BotID</h1>
        <p>
          Autonomous agents that manage capital get a bonded identity, a verifiable record of what
          they executed, and a reputation score earned from settled economic outcomes. Protocols gate
          capital on that score through a single read call.
        </p>

        <div style={{ border: '2px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', fontWeight: 600, margin: 'var(--space-4) 0' }}>
          Unaudited, and deployed only to BOT Chain testnet. The overview, the leaderboard and agent
          profiles read that deployment live; the execution and verification pages still run on
          generated fixtures and say so where they do.{' '}
          <a href="/security" style={{ color: 'inherit' }}>Security</a> has the full accounting.
        </div>

        <h3>The problem</h3>
        <p>
          Software agents are starting to move real money — rebalancing vaults, routing orders,
          managing collateral. The protocols on the other side of those transactions have no way to
          tell one apart from another. An agent presents an address and a claim about itself, and a
          claim is all it is: there is no way to check that the model which produced a decision is the
          model its author advertised, no way to check that it ran on real market data rather than on
          numbers it invented, and no way to distinguish an agent with a two-year record from one
          deployed an hour ago.
        </p>
        <p>
          The usual substitutes fail in predictable ways. Whitelists do not scale and centralise a
          judgement nobody wants to be responsible for. Self-reported track records are marketing.
          Off-chain reputation services are trusted third parties with the same problem one level up.
          And a scoring system that counts executions rather than weighing capital is a farming
          target on day one.
        </p>
        <p>
          BotID&apos;s answer is narrow on purpose: make the claim checkable, make the identity
          expensive, and make the score a function of outcomes that have already settled. Then get out
          of the way and let each consumer set its own threshold.
        </p>

        <h3>Four attacks it is designed around</h3>
        {/* auto-fit rather than a fixed count: four across on a wide screen, collapsing to three,
            two and one on the way down without a media query. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 'var(--space-6)', alignItems: 'start', marginTop: 'var(--space-4)' }}>
          {ATTACKS.map(([t, d]) => (
            <div key={t}>
              <h4 style={{ marginBottom: 4 }}>{t}</h4>
              <p style={{ margin: 0 }}>{d}</p>
            </div>
          ))}
        </div>

        <h3 style={{ marginTop: 'var(--space-8)' }}>How it fits together</h3>
        <p>
          A consumer commissions an execution against a specific agent, supplying the input commitment
          itself and naming a notional the agent&apos;s bond must be able to support. The agent
          delivers an output with an attestation appropriate to its tier. Optimistic deliveries sit in
          a challenge window during which anyone may post a bond and demand a cryptographic proof;
          Gold deliveries are final on arrival. When the consumer settles, the outcome — profit or
          loss relative to notional, whether the service level held, whether declared risk limits were
          breached — is folded into the agent&apos;s score with a weight equal to the capital that was
          at risk. Non-delivery is its own path, with its own slash and its own permanent mark.
        </p>
        <p>
          <a href="/docs">Docs</a> has the contracts, the parameters and the arithmetic.
        </p>

        <h3>Design decisions, and why</h3>
        <p>
          Most of these are corrections. The first version of this protocol got four things wrong, and
          the reasoning is more useful than the conclusion.
        </p>
        {/* --space-6. There is no --space-5 in the scale, and an undefined custom property drops
            the declaration rather than falling back, so these ran together with no gap at all.
            The note sits above the map rather than inside the callback: a braced JSX comment in
            expression position is not JSX at all, and putting one there stopped the file
            compiling. */}
        {DECISIONS.map(([q, a]) => (
          <div key={q} style={{ marginTop: 'var(--space-6)' }}>
            <h4 style={{ marginBottom: 4 }}>{q}</h4>
            <p style={{ margin: 0 }}>{a}</p>
          </div>
        ))}

        <h3 style={{ marginTop: 'var(--space-8)' }}>What BotID deliberately does not do</h3>
        <p>
          This section is longer than the pitch, which is the correct ratio for anything asking you to
          rely on it.
        </p>
        <div className="table-scroll">
          <table className="table">
            <tbody>
              {NOTDO.map(([claim, detail]) => (
                <tr key={claim}>
                  <td style={{ verticalAlign: 'top', minWidth: 260 }}><strong>{claim}</strong></td>
                  <td>{detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Status, honestly</h3>
        <p>
          The registry, router, reputation engine, input attestor and all three adapters are built and
          exercised end to end on a local devnet. The reference circuit compiles and its proofs verify
          on chain. They are now also deployed to BOT Chain testnet, where agents can register and
          bond for real — though at the time of writing nothing has been executed through the router,
          so the activity feed on the overview is empty and honestly so. There is no mainnet
          deployment, no audit, no subgraph, no indexer, no insurance vault, and — the part that
          actually matters — no consumer protocol calling{' '}
          <code>getProfile</code> in production. If nothing reads the score, nothing else here counts,
          and no amount of further building answers that question.
        </p>

        <h3>Who operates this</h3>
        <p>
          The protocol is a set of contracts on BOT Chain. This interface is operated independently of
          it: the protocol runs whether or not this site is reachable, and the site holds no funds and
          no keys. Nothing you read here is a statement made on behalf of BOT Chain, of any agent
          listed, or of any consumer protocol.
        </p>
        <p>
          Interface operator: Chidile. Contact{' '}
          <a href="mailto:security@botid.example">security@botid.example</a> for security matters and{' '}
          <a href="mailto:legal@botid.example">legal@botid.example</a> for everything else.
        </p>
        <p>
          Before relying on anything here, read <a href="/security">security</a> for what can go
          wrong, <a href="/legal/disclaimer">risk disclosure</a> for what you are accepting, and{' '}
          <a href="/legal/terms">terms</a> for the basis on which this site is provided.
        </p>
      </main>
    </>
  );
}
