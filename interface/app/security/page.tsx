import type { Metadata } from 'next';
import ContractsTable from '@/components/ContractsTable';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'Audit status, deployment state, threat model, trust assumptions, key custody and disclosure policy for the BotID protocol and this interface.',
};

// This page has one job: tell a reader things they would rather not hear, before they lose money.
// So it leads with what is missing, names every trust assumption including the ones that are
// embarrassing, and does not print an address it cannot source from a deployment artifact.
//
// It previously showed four testnet addresses under three contract names that do not exist in this
// protocol. Those are gone; see the note in lib/contracts.ts. The verifier registration table was
// likewise hardcoded and is now labelled for what it is.

const HEAD: React.CSSProperties = { color: 'var(--text-muted)', margin: 'var(--space-6) 0 var(--space-2)' };

const THREATS: [string, string, string][] = [
  [
    'Fabricated inputs',
    'An agent feeds its own model invented prices, gets a valid proof, and executes a theft that verifies.',
    'Mitigated. inputCommitment must be a quorum-signed bundle from registered publishers, is checked for freshness against request creation, and is bound into the attestation. Values are committed as keccak256(abi.encode(value, salt)) so a public commitment does not leak the numbers.',
  ],
  [
    'Proof or signature replay',
    'A valid attestation from one execution is presented for a different one.',
    'Mitigated. The signed digest binds chainId, adapter address, requestId, agentId, model, input and output commitments and the delivery deadline. A Gold proof is reusable only across requests that agree on model, input and output — where it asserts the same true statement.',
  ],
  [
    'Sybil identities',
    'Spin up many cheap agents to manufacture capacity or to farm scores.',
    'Mitigated economically, not cryptographically. Capacity is a function of bond, and the score is weighted by capital at risk with a half-weight constant, so dust volume moves nothing. Identity itself is permissionless by design.',
  ],
  [
    'Score grinding',
    'Accumulate a high score cheaply, then use it once at size.',
    'Mitigated. Weight is min(notional, weightCap) — a score can only be earned at roughly the size at which it will be spent. Credit is a step function of score, so a marginal point never silently lifts a ceiling.',
  ],
  [
    'Stale reputation resale',
    'Sell or reuse a dormant agent with a high historical score.',
    'Mitigated. Scores decay toward neutral on a half-life and the profile exposes lastActiveAt. Consumers who check only minScore and ignore maxStalenessSeconds are accepting this risk voluntarily.',
  ],
  [
    'Dishonest outcome reporting',
    'The consumer calls settle() with a false realizedPnlBps, slaBreached or limitBreached, corrupting the score.',
    'NOT mitigated, and not mitigable. Realised P&L is a fact about the world off chain and no proof system attests to it. This is the softest joint in the protocol. Weigh a record spread across many distinct consumers far above a long history with one.',
  ],
  [
    'Non-delivery',
    'An agent takes requests and simply does not answer.',
    'Mitigated. Anyone may call markExpired after deliverBy: the fee is refunded, exposure released, a liveness slash of 200 bps taken and a permanent fault recorded outside the EWMA. This, not invalid proofs, is how agents fail in practice — an invalid proof reverts and never reaches the record.',
  ],
  [
    'Fee evasion',
    'A consumer and an agent who know each other set fee = 0 and settle off chain.',
    'Mitigated. A floor of minFeeBps against notional, which is the one quantity in a request that is costly to misreport in either direction. Zero-notional requests are exempt on purpose.',
  ],
  [
    'Frivolous challenges',
    'Grief an honest agent with a stream of challenges to force proving costs on it.',
    'Mitigated. A challenge requires a bond, and a challenge the agent answers with a valid Gold proof forfeits that bond to the agent and finalizes the execution at Gold.',
  ],
  [
    'Owner key compromise',
    'Whoever holds the owner key retunes slash rates, windows, fee floors, publishers or adapters.',
    'NOT mitigated. Parameters are owner-settable and the owner is a single key on the only existing deployment. There is no timelock and no multisig. Treat this as the largest non-code risk on this page.',
  ],
  [
    'Frontend compromise',
    'This site is replaced or its transaction composer is tampered with to route funds elsewhere.',
    'Partially mitigated. The site holds no keys and no funds, so a compromise is a phishing risk rather than a custody one. Verify what your wallet shows you against the deployment artifact, never against this page. There is no protocol-level defence for a hostile frontend.',
  ],
  [
    'Chain-level failure',
    'Reorgs, validator censorship, halted block production, or a repricing of the bn254 precompiles.',
    'Inherited, not mitigated. BotID is a set of contracts and has exactly the liveness and finality of the chain under it. Gold verification depends on precompiles at 0x06/0x07/0x08 at Istanbul prices; the deploy script probes rather than assumes, but a live repricing would break Gold without breaking Bronze or Silver.',
  ],
];

const ASSUMPTIONS: [string, string][] = [
  ['Publisher honesty, up to quorum', 'Input attestation is only as good as its publisher set. A colluding quorum can sign a false bundle and every downstream proof will be valid over false numbers.'],
  ['Consumer honesty at settlement', 'Outcomes are self-reported and unproven.'],
  ['TEE vendor integrity, for Silver', 'A Silver attestation reduces to trusting AWS Nitro, Intel SGX or Phala and a measurement allowlist. Enclave breaks are a live research area; Silver is stronger than a bare signature and weaker than a proof.'],
  ['Trusted setup, for Gold', 'Groth16 needs a per-circuit setup. A compromised setup for a circuit means forgeable proofs for that model.'],
  ['Correctness of ezkl compilation', 'A Gold proof attests that the compiled circuit ran, not that the circuit faithfully represents the model an author intended. Division in ezkl is a reciprocal lookup that returns zero for large divisors, and a scale of 0 quantises reciprocals to zero — compiling, proving and verifying successfully while computing nothing.'],
  ['A single owner key', 'Every parameter listed in the docs is settable by it, with no timelock.'],
  ['The chain beneath it', 'Finality, censorship-resistance and gas pricing are BOT Chain’s properties, not BotID’s.'],
];

export default function Security() {
  return (
    <>
      {/* Full width. The two things a reader came to check are the contracts table and the threat
          model, and both were being squeezed into 70ch. Tables want the screen; the measure lives
          on the paragraphs. */}
      <main className="legal-body" style={{ padding: 'var(--space-8) var(--space-6)' }}>
        <h1 style={{ fontSize: 28 }}>Security</h1>

        <div style={{ border: '2px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', fontWeight: 600, margin: 'var(--space-4) 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span>Unaudited. No audit is scheduled and no bug bounty is open.</span>
          <span>Not deployed to any public network. The only deployment artifact in this repository is a local devnet (chain 31337).</span>
          <span>This interface runs on generated fixtures. Every agent, execution, score, address and chart in it is sample data, not chain state.</span>
        </div>

        <p>
          The purpose of this page is to be the least flattering document on the site. If you are
          deciding whether to put capital behind an agent scored by this protocol, the paragraphs
          below matter more than anything on the overview, and they are written to be read by
          someone looking for a reason not to.
        </p>

        <h3>Deployment state</h3>
        <p>
          BotID has no mainnet deployment and no public testnet deployment. Contracts have been
          deployed and exercised end to end on a local Hardhat devnet only, most recently on
          2026-08-09, with the bn254 precompiles confirmed present.
        </p>
        <p>
          The table below is load-bearing: it is this site&apos;s answer to &ldquo;is this the real
          BotID.&rdquo; It follows the network selected in the nav, it never falls back to another
          network&apos;s addresses, and no BotID contract goes into it until a deployment artifact
          exists for that network.
        </p>
        <p>
          The single entry is the bond token, and it is there because it is the one address that is
          knowable in advance: USDT is not ours, it was already deployed, and agents will post their
          bonds in it. It is listed per network because the two addresses differ — and using the
          mainnet one on Bohr does not fail, it resolves to an unrelated token with different
          decimals. Both were verified by calling the contracts directly.
        </p>
        <ContractsTable />
        <p>
          <strong>No address in that table other than the bond token is a BotID contract yet.</strong>{' '}
          Any address presented to you as <em>our</em> contract today — in a message, a post, a
          wallet prompt or a fork of this site — is not one. There is nothing to be confused with
          yet, which makes this the one moment when the answer is unambiguous.
        </p>

        <h6 style={HEAD}>The contracts that will appear there</h6>
        <p>
          Named here so a future table can be checked against something written down. The protocol is{' '}
          <code>AgentRegistry</code>, <code>ExecutionRouter</code>, <code>InputAttestor</code>,{' '}
          <code>ReputationEngine</code>, the three tier adapters —{' '}
          <code>SignatureAdapter</code>, <code>TeeAdapter</code>, <code>ZkAdapter</code> — and the
          ERC-20 <code>bondToken</code>. Nothing else. An earlier version of this page listed
          contracts called RequestManager, ScoreRegistry and BondVault; they have never existed, and
          the addresses beside them were placeholders. That was the exact error this table is
          supposed to prevent, so it is recorded here rather than quietly deleted.
        </p>

        <h6 style={HEAD}>Verifier &amp; model registrations</h6>
        <p>
          Intended to be read live from <code>ZkAdapter</code>. There is no adapter to read on a
          public network, so there is nothing to show; the reference circuit is{' '}
          <code>botid.reference-allocator.v1</code> at an input scale of 8 bits, whose commitment is{' '}
          <code>keccak256</code> of that name.
        </p>
        <p className="text-muted" style={{ fontSize: 13 }}>
          No registrations on the selected network.
        </p>

        <h3>Threat model</h3>
        <p>
          What the protocol defends against, what it does not, and which is which. The rows marked
          NOT mitigated are the ones worth your time.
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th style={{ minWidth: 160 }}>Threat</th><th>Attack</th><th>Status</th></tr></thead>
            <tbody>
              {THREATS.map(([name, attack, status]) => (
                <tr key={name}>
                  <td style={{ verticalAlign: 'top' }}><strong>{name}</strong></td>
                  <td style={{ verticalAlign: 'top' }}>{attack}</td>
                  <td style={{ verticalAlign: 'top' }}>
                    {status.startsWith('NOT mitigated') ? (
                      <><strong style={{ color: 'var(--score-critical)' }}>NOT mitigated</strong>{status.slice('NOT mitigated'.length)}</>
                    ) : status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Trust assumptions</h3>
        <p>
          Verification narrows what you must trust; it does not eliminate it. Everything below is a
          thing you are trusting if you rely on a BotID score.
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th style={{ minWidth: 200 }}>Assumption</th><th>What it means</th></tr></thead>
            <tbody>
              {ASSUMPTIONS.map(([name, meaning]) => (
                <tr key={name}>
                  <td style={{ verticalAlign: 'top' }}><strong>{name}</strong></td>
                  <td>{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>What a bond is, and what it is not</h3>
        <p>
          A bond is the agent&apos;s skin in the game. It backs the agent&apos;s own credit —{' '}
          <code>maxOpenNotional</code> is bond times a score-derived leverage times a tier factor —
          and it is what gets slashed on a fault. Slashing pays a bounty to the challenger who
          surfaced the fault and sends the remainder to treasury.
        </p>
        <p>
          <strong>It is not insurance and it does not compensate you.</strong> If an agent loses your
          capital, no part of its bond flows to you. The insurance vault sketched in the roadmap does
          not exist and has not been started. Bonds are also never lent out for yield: doing so would
          put the slashing guarantee behind a liquidity assumption, which is the one thing the bond
          exists to avoid.
        </p>
        <p>
          Two timing details matter. Bond remains slashable for the entire 21-day unbonding period, and
          credit is computed on bond <em>net of</em> anything queued for unbonding, so an agent&apos;s
          capacity shrinks the moment it starts to leave rather than when it finishes.
        </p>
        <p>
          The exception is worth stating plainly rather than leaving in a parameter table. Since{' '}
          <code>withdrawEarly</code>, an agent can take its queued bond out before the 21 days are up by
          paying 10% of it to the treasury. Live exposure is not at risk from this — credit already nets
          out the queued amount, so nothing an agent currently has open was ever backed by the bond it is
          withdrawing. What the door does reach is an execution that has already been delivered and is
          still inside its settlement window: the capital behind it can leave for a tenth of itself. A
          lost challenge costs 20% of remaining bond, so the exit is the cheaper of the two, and an
          operator who expects a fault is better off taking it. Treat the 21 days as a delay that has a
          price, not as an assurance that the bond will be there at the end of a dispute.
        </p>

        <h3>Audit status</h3>
        <p>
          No contract in this protocol has been audited. No audit is booked and no date is set. The
          intended scope for a first engagement, in priority order, is{' '}
          <code>ExecutionRouter</code> (it holds escrow and drives every state transition),{' '}
          <code>AgentRegistry</code> (bond custody and the unbonding queue),{' '}
          <code>ZkAdapter</code> (the instance-pinning logic that substitutes for in-circuit hashing),{' '}
          <code>InputAttestor</code>, then <code>ReputationEngine</code> and{' '}
          <code>ScoreMath</code>.
        </p>
        <p>
          <strong>CertiK has audited BOT Chain itself, its DEX and its bridge. Those audits do not
          cover BotID.</strong> A chain-level audit says nothing about a contract deployed on that
          chain, and anyone citing one as coverage for this protocol is misrepresenting it.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 'var(--space-6)', alignItems: 'start', marginTop: 'var(--space-8)' }}>
          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Responsible disclosure</h6>
            <p style={{ margin: 0 }}>
              Report to <a href="mailto:security@botid.example">security@botid.example</a>. A PGP key
              is available on request. Please include enough detail to reproduce, and give us a
              reasonable window before publishing. We will acknowledge receipt, tell you honestly
              whether we can fix it, and credit you if you want credit.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Bug bounty</h6>
            <p style={{ margin: 0 }}>
              None yet, and we will not imply otherwise. There is no reward pool and no safe-harbour
              commitment in place today. When a program launches, its scope, severity tiers, payouts
              and legal safe harbour will be published here in full <em>before</em> any submission is
              expected. Until then, disclosure is goodwill and we will not pretend it is a contract.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Please do not test on us</h6>
            <p style={{ margin: 0 }}>
              With no deployment and no bounty, there is no authorised target. Do not attempt live
              testing against BOT Chain infrastructure or against this site. Run the contracts
              locally instead — the devnet deploy script is in the repository, and findings from a
              local run are just as welcome.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Key custody</h6>
            <p style={{ margin: 0 }}>
              The protocol owner key is a single externally-owned account. No multisig, no timelock,
              no governance contract. It can retune slash rates, windows, fee floors, the publisher
              set and the adapter registry. Moving it behind a multisig with a timelock is the single
              highest-value change available and it has not been made.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Interface &amp; infrastructure</h6>
            <p style={{ margin: 0 }}>
              Frontends are the soft target in this industry, so: this site is statically rendered
              with no server-side secrets and no backend of ours. It holds no funds and no keys. RPC
              access runs through BOT Chain&apos;s public endpoints, which we do not operate and
              which can see your IP and your queries. Deploy access is limited to the operator named
              in <a href="/about">about</a>.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>No third-party requests</h6>
            <p style={{ margin: 0 }}>
              Fonts are self-hosted, there is no analytics script, no tag manager, no CDN for
              third-party code and no advertising pixel. The supply chain you inherit by loading this
              page is our build and nothing else. See <a href="/legal/cookies">cookies</a> for the
              full accounting.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Verifying a wallet prompt</h6>
            <p style={{ margin: 0 }}>
              Never trust an address because this page displayed it. Check the contract address your
              wallet shows against the deployment artifact in the repository, confirm the chain id
              (BOT Chain 677, Bohr 968), and read the function being called. A composer that is
              honest today can be tampered with tomorrow; an artifact in version control is harder to
              rewrite quietly.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Reporting an impersonation</h6>
            <p style={{ margin: 0 }}>
              Tokens, airdrops, presales, staking programs and &ldquo;official&rdquo; BotID contracts
              do not exist. If you are shown one, it is a scam regardless of how convincing the site
              is. Report it to the same security address and we will say so publicly.
            </p>
          </section>
        </div>

        <h3 style={{ marginTop: 'var(--space-8)' }}>If you take one thing from this page</h3>
        <p>
          Reputation is a multiplier on capital that is actually at risk, never a substitute for it.
          An attacker&apos;s maximum extractable value is bounded by their own bond times the
          leverage cap — that bound is the security model, and every other mechanism here exists to
          keep it honest. A score is a summary of settled history reported by counterparties. It is
          not a guarantee, a rating, a licence, or advice. See{' '}
          <a href="/legal/disclaimer">risk disclosure</a>.
        </p>
      </main>
    </>
  );
}
