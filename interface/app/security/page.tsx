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
    'Mitigated. Weight is min(notional, weightCap, remaining budget for this counterparty) — a score can only be earned at roughly the size at which it will be spent, and no single counterparty can supply the whole record. Credit is a step function of score, so a marginal point never silently lifts a ceiling.',
  ],
  [
    'Stale reputation resale',
    'Sell or reuse a dormant agent with a high historical score.',
    'Mitigated. Scores decay toward neutral on a half-life and the profile exposes lastActiveAt. Consumers who check only minScore and ignore maxStalenessSeconds are accepting this risk voluntarily.',
  ],
  [
    'Dishonest outcome reporting',
    'The consumer calls settle() with a false realizedPnlBps, slaBreached or limitBreached, corrupting the score.',
    'Bounded, not prevented. Realised P&L is a fact about the world off chain and no proof system attests to it, so a determined consumer can always lie about its own trade — that much is not mitigable, and it remains the softest joint in the protocol. What is enforced is the blast radius: consumerWeightCap gives each counterparty a per-agent weight budget, defaulting to half the half-weight constant, so one liar drags a score at most a third of the way toward its claimed quality and the second report inside the same half-life is nearly mute. The advice to weigh a record spread across many distinct consumers above a long history with one is now the arithmetic rather than a suggestion.',
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
    'NOT mitigated. The owner is a single key on the only existing deployment, and there is no multisig. Four setters — the router, the reputation writers, a verification adapter and the input attestor — are now behind a 21-day queue-then-execute delay in the source, which is the subset that can substitute the code deciding whether an execution was honest. Every economic parameter stays instant, the delay is a notice period rather than a veto, and a key that can wait three weeks still wins. Treat this as the largest non-code risk on this page.',
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
  ['A single owner key', 'Every parameter listed in the docs is settable by it. Four of those setters now wait 21 days; the rest take effect in the block they land in.'],
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
          <span>Deployed to Bohr testnet only (chain 968). Nothing is deployed to BOT Chain mainnet, and no address on mainnet is ours.</span>
          <span>Every figure in this interface is now read from chain 968 — there is no sample data left in it. That makes the numbers true and the stakes fake: the testnet bond token is worthless, so nothing here has yet been tested by an adversary with something to gain.</span>
        </div>

        <p>
          The purpose of this page is to be the least flattering document on the site. If you are
          deciding whether to put capital behind an agent scored by this protocol, the paragraphs
          below matter more than anything on the overview, and they are written to be read by
          someone looking for a reason not to.
        </p>

        <h3>Deployment state</h3>
        <p>
          BotID is deployed on Bohr testnet, chain 968, as of 2026-08-25, with the bn254 precompiles
          confirmed present. There is no mainnet deployment. Bohr is a testnet: its BOT has no
          value, the chain carries no uptime commitment, and the deployment can be replaced without
          notice. Nothing there is a place to put capital you expect to keep.
        </p>
        <p>
          &ldquo;Replaced without notice&rdquo; is not hypothetical: this is the second deployment,
          and it replaced the one dated 2026-08-11. Six of the eight contracts changed bytecode when
          the findings below were remediated, and none of them is upgradeable — the router&apos;s
          registry, engine and bond token are <code>immutable</code>, so there was no way to swap one
          contract and keep the rest. The signing domain changed too, so nothing signed for the old
          adapters verifies against the new ones. If you hold addresses from before that date, they
          are not stale so much as a different protocol wearing the same name. All eight are
          source-verified on the explorer; the table below is the current set.
        </p>
        <p>
          The owner of every parameter on that deployment is a single externally-owned key, which is
          also the deployer, the only registered feed publisher, and the only TEE notary. That is
          four roles on one key: it can change the capital limits, it alone signs the input readings
          every execution is judged against, it alone decides which enclaves count as Silver, and
          losing it loses all four at once. Acceptable on a testnet, stated plainly because it is
          exactly the sort of thing that quietly survives into mainnet.
        </p>
        <p>
          The table below is load-bearing: it is this site&apos;s answer to &ldquo;is this the real
          BotID.&rdquo; It follows the network selected in the nav, it never falls back to another
          network&apos;s addresses, and no BotID contract goes into it until a deployment artifact
          exists for that network.
        </p>
        <p>
          Switch the nav to BOT Chain and the table disappears, because there is nothing of ours to
          list there. The bond token is the exception on both networks and is marked as such: USDT
          is not ours, it was already deployed, and agents post their bonds in it. It is listed per
          network because the two addresses differ — and using the mainnet one on Bohr does not
          fail, it resolves to an unrelated token with different decimals. Every address in the
          table, ours and USDT alike, was verified by calling the deployed contracts directly rather
          than copied out of the deploy log.
        </p>
        <ContractsTable />
        <p>
          <strong>That table is the whole list.</strong> An address presented to you as{' '}
          <em>our</em> contract — in a message, a post, a wallet prompt or a fork of this site — and
          not appearing above is not ours, whatever it is named after. Until today the honest answer
          was &ldquo;none of them are real&rdquo;, which was easy to check and impossible to
          impersonate. That is over: there are real addresses now, so check the one you are about to
          sign against this table character by character, and check it against the explorer link
          rather than against the string someone sent you.
        </p>

        <h6 style={HEAD}>The contracts that appear there</h6>
        <p>
          Named here so the table can be checked against something written down. The protocol is{' '}
          <code>AgentRegistry</code>, <code>ExecutionRouter</code>, <code>InputAttestor</code>,{' '}
          <code>ReputationEngine</code>, the three tier adapters —{' '}
          <code>SignatureAdapter</code>, <code>TeeAdapter</code>, <code>ZkAdapter</code> — the
          generated <code>Halo2Verifier</code> that <code>ZkAdapter</code> calls, and the ERC-20{' '}
          <code>bondToken</code>. Nothing else. An earlier version of this page listed
          contracts called RequestManager, ScoreRegistry and BondVault; they have never existed, and
          the addresses beside them were placeholders. That was the exact error this table is
          supposed to prevent, so it is recorded here rather than quietly deleted.
        </p>

        <h6 style={HEAD}>Verifier &amp; model registrations</h6>
        <p>
          Intended to be read live from <code>ZkAdapter</code>; still transcribed here rather than
          fetched, so treat it as a claim to check and not as chain state. On Bohr one model is
          registered: <code>botid.reference-allocator.v1</code> at an input scale of 8 bits, whose
          commitment is <code>keccak256</code> of that name —{' '}
          <code style={{ wordBreak: 'break-all' }}>
            0x08a284ace0e1e53d8ecffe84217e9680646ac0264ab252948dabbfe7f54d8fa2
          </code>{' '}
          — bound to the <code>Halo2Verifier</code> in the table above. Read back from{' '}
          <code>ZkAdapter.modelFor()</code> on 2026-08-25, against the new adapter. The verifier
          itself is the one contract carried over from the previous deployment unchanged, so the
          model binding is identical to what it was. Nothing is registered on mainnet, because there
          is no mainnet adapter.
        </p>

        <h6 style={HEAD}>Misconfiguration, which is not an attack and is still how money is lost</h6>
        <p>
          The threat model below is about adversaries. This is about the owner key making an honest
          mistake, which on a one-key deployment is the likelier of the two. Two such mistakes used
          to fail <em>silently</em>, and both now fail loudly instead.
        </p>
        <p>
          <strong>A bond token address with no contract at it.</strong> The transfer helpers accept a
          call that returns no data as a success, because USDT and others really do return nothing on
          a real transfer. Calling an address with no code also succeeds and also returns nothing, so
          the two are indistinguishable — a typo in a constructor argument would have made every
          deposit, fee and slash appear to work while nothing moved, with the protocol reporting bonds
          it did not hold and the first symptom arriving at the first withdrawal. Both helpers now
          check the address has code and revert with <code>NotAContract</code>, which moves the
          failure to the first deposit.
        </p>
        <p>
          <strong>A challenge bond above 2<sup>128</sup>.</strong> The bond is collected as a{' '}
          <code>uint256</code> and recorded per request as a <code>uint128</code>, and every refund
          pays out the recorded field. Past that boundary those are different numbers and the
          difference is simply gone — not refunded, not recoverable, and absent from every event,
          because a truncating cast is silent by construction. <code>setParameters</code> now refuses
          the value outright, so the revert lands on the governance call that is wrong, where it can
          still be corrected, rather than on the first challenger to post a bond.
        </p>
        <p>
          Neither was reachable by an attacker and neither is a claim that the owner key is safe —
          see <em>Owner key compromise</em> below, which is still the largest risk here even with a
          notice period on four of its setters. What they are is two cases
          where a wrong value used to be indistinguishable from a right one, and now is not.
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
          There is a fast door, and it is worth stating what gates it rather than leaving it in a
          parameter table. <code>withdrawEarly</code> returns queued bond before the 21 days for a 10%
          penalty to the treasury — but only while <code>openNotional</code> is zero. That condition is
          not a proxy for &ldquo;nothing outstanding&rdquo;; it is the thing itself. The router reserves
          exposure when a request is made and releases it in exactly three places — settlement, a lost
          challenge, and expiry — which are its three terminal states. Nothing is released at delivery,
          at <code>finalize</code>, or when a challenge is answered. So an agent with any execution still
          live, delivered and challengeable, under challenge, or finalized and awaiting settlement,
          cannot use the door at all, and one with none has nothing left that could reach its bond.
        </p>
        <p>
          That ordering is what makes the penalty safe to be small. Ten percent is less than the 20% a
          lost challenge costs, so if the exit were open during a dispute an operator expecting a fault
          would simply buy their way out — no toll sized in bond can fix that, because the payoff being
          weighed comes out of notional, which leverage and tier carry to nine times bond. Gated, the
          comparison stops mattering: the fault is always paid first. What the 10% prices is churn, and
          what the 21 days now cover is the case where an agent wants out with work still in flight.
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
              Report to <a href="mailto:chidileozoemena@gmail.com">chidileozoemena@gmail.com</a>. A PGP key
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
              The Bohr deployment is a fair target and testnet BOT is free, so hammer it. What is
              not a target is BOT Chain mainnet, this site&apos;s hosting, or anything belonging to
              the chain operators — none of that is ours to authorise. Running the contracts locally
              works too; the deploy script is in the repository, and findings from a local run are
              just as welcome. There is still no bounty, so this is permission to test, not an offer
              of payment or a safe-harbour commitment.
            </p>
          </section>

          <section>
            <h6 style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Key custody</h6>
            <p style={{ margin: 0 }}>
              The protocol owner key is a single externally-owned account. No multisig, no
              governance contract. It can retune slash rates, windows, fee floors, the publisher set
              and the adapter registry, and half of that list still takes effect in one block.
            </p>
            <p style={{ marginBottom: 0 }}>
              What changed is the other half. Four setters — <code>setRouter</code>,{' '}
              <code>setWriter</code>, <code>setAdapter</code> and <code>setInputAttestor</code> —
              have to be queued, announced on chain, and then executed no sooner than 21 days later
              and no later than 35. Those four are the ones that point a contract at code it did not
              previously depend on: swapping the Bronze adapter for one whose <code>verify</code>{' '}
              always returns true does not look like theft in any event these contracts emit, it
              just makes every subsequent delivery pass and every challenge lose. The delay is 21
              days because that is <code>UNBONDING_PERIOD</code>, so an agent that objects can
              finish withdrawing its bond before the change lands.
            </p>
            <p style={{ marginBottom: 0 }}>
              Read it for what it is. It is a notice period, not a veto — nobody can stop a queued
              change, only see it coming and leave. It does nothing about a key that is patient. It
              covers none of the economic parameters, deliberately. And it arms only when{' '}
              <code>finalizeBootstrap()</code> has been called on all three contracts, which the
              deploy script does last and records in the manifest; a live deployment reporting{' '}
              <code>bootstrapped() == false</code> has no delay at all. The current Bohr deployment
              reports <code>true</code> on all three, read back off chain after deployment rather
              than assumed from the script&apos;s own output. Moving the key itself behind a multisig
              remains the single highest-value change available, and it has not been made.
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
