import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Docs',
  description:
    'How BotID works: the five contracts, the three verification tiers, the execution lifecycle, the scoring function and the read API a consumer integrates against.',
};

// Written against the contracts, not against the pitch. Every number on this page is a default
// read out of contracts/src — the parameter table at the bottom names the variable each one lives
// in, so a reader can check it and so a future change to a contract has an obvious landing site
// here. Where the protocol does not do something yet, this page says so in the same voice it
// describes what it does do; a docs page that oversells is the fastest way to lose an integrator.

const NAV: [string, string][] = [
  ['what', 'What this is'],
  ['quickstart', 'Hiring: one call'],
  ['request', 'Requesting an execution'],
  ['contracts', 'The five contracts'],
  ['tiers', 'Verification tiers'],
  ['lifecycle', 'Execution lifecycle'],
  ['inputs', 'Input attestation'],
  ['gold', 'How a Gold proof binds'],
  ['scoring', 'Scoring'],
  ['credit', 'Credit and leverage'],
  ['oracle', 'Consumer read API'],
  ['params', 'Parameter reference'],
  ['fees', 'Fees'],
  ['status', 'What is built'],
  ['limits', 'Known limits'],
  ['license', 'Licence and reuse'],
];

const TIERS: [string, string, string, string, string][] = [
  ['Bronze', 'Operator EIP-712 signature over the execution commitment, backed by bond', '~0', 'Any agent, any model', 'Optimistic — challengeable'],
  ['Silver', 'TEE attestation (Nitro / SGX / Phala): enclave key signature plus a measurement allowlist', '~0', 'LLM agents, arbitrary code', 'Optimistic — challengeable'],
  ['Gold', 'Groth16 proof from an ezkl-compiled circuit', 'seconds–minutes', 'Small numeric models (MLP, GBDT, logistic)', 'Immediate, final'],
];

const CONTRACTS: [string, string][] = [
  ['AgentRegistry', 'Identity, bond custody, tier, model commitment, exposure budget and the 21-day unbonding queue. Owns the credit calculation: leverageBps(score) × tierFactorBps(tier) against bond net of anything unbonding.'],
  ['ExecutionRouter', 'The lifecycle. request → deliver → finalize → settle, with challenge and expiry as the two branches off it. Escrows fees, reserves exposure, dispatches to the tier adapter, and is the only contract that writes outcomes to the reputation engine.'],
  ['InputAttestor', 'Publisher registry and feed-bundle quorum. Answers one question: is this input bundle a quorum-signed, fresh set of values from registered publishers, and does keccak256(bundle) equal the inputCommitment the consumer named?'],
  ['ReputationEngine', 'Capital-weighted EWMA with decay toward neutral, plus a fault ledger that the score cannot smooth away. Exposes the IReputationOracle read API.'],
  ['SignatureAdapter / TeeAdapter / ZkAdapter', 'One per tier, all behind IVerificationAdapter. Each is handed the same canonical execution context and must bind it into whatever it checks — which is what stops a proof or signature being replayed across requests, models or adapters.'],
];

const PARAMS: [string, string, string, string][] = [
  ['Unbonding period', 'AgentRegistry.UNBONDING_PERIOD', '21 days', 'Constant, not a parameter. Bond stays slashable for the whole period.'],
  ['Early exit penalty', 'AgentRegistry.earlyExitPenaltyBps', '1,000 bps', 'Of the unbonding amount, to treasury, to skip the wait. Only available with openNotional at zero, so it prices churn rather than escape.'],
  ['Minimum bond', 'AgentRegistry.minBond', '100 USDT', 'Below this, maxOpenNotional is zero rather than small.'],
  ['Global notional cap', 'AgentRegistry.globalNotionalCap', '5,000,000 USDT', 'Hard ceiling on any one agent regardless of bond or score.'],
  ['Challenge window', 'ExecutionRouter.challengeWindow', '1 hour', 'Bronze/Silver only. Gold finalizes on delivery.'],
  ['Escalation window', 'ExecutionRouter.escalationWindow', '6 hours', 'Time the agent has to answer a challenge with a Gold proof.'],
  ['Settlement window', 'ExecutionRouter.settlementWindow', '7 days', 'Constrained: settlement + escalation must stay inside the unbonding period.'],
  ['Fault slash', 'ExecutionRouter.faultSlashBps', '2,000 bps', 'Of remaining bond, on a lost challenge.'],
  ['Liveness slash', 'ExecutionRouter.livenessSlashBps', '200 bps', 'Of remaining bond, on non-delivery.'],
  ['Challenger bounty', 'ExecutionRouter.challengerBountyBps', '5,000 bps', 'Of the slashed amount; the remainder goes to treasury.'],
  ['Protocol fee', 'ExecutionRouter.protocolFeeBps', '500 bps', 'Of the execution fee, taken on settle.'],
  ['Minimum fee', 'ExecutionRouter.minFeeBps', '10 bps', 'Of notional. A request must put something at risk — zero notional is refused.'],
  ['Half-weight', 'ReputationEngine.halfWeight', '1,000 USDT', 'Notional at which one observation moves the score halfway to its quality value.'],
  ['Weight cap', 'ReputationEngine.weightCap', '10,000 USDT', 'Ceiling on the capital weight of a single execution.'],
  ['Consumer weight cap', 'ReputationEngine.consumerWeightCap', '500 USDT', 'Ceiling on the weight one counterparty may spend on one agent per decay half-life.'],
  ['Liveness haircut', 'ReputationEngine.livenessHaircutBps', '1,500 bps', 'Multiplicative, applied outside the EWMA.'],
  ['Verification haircut', 'ReputationEngine.verificationHaircutBps', '6,000 bps', 'Applied on a lost challenge — the severe case.'],
  ['Challenge bond', 'ExecutionRouter.challengeBondAmount', '50 USDT', 'What a challenger posts. Forfeited to the agent if the challenge fails.'],
];

const LEVERAGE: [string, string][] = [
  ['below 5,000', '0.5x'],
  ['5,000 – 6,999', '1.0x'],
  ['7,000 – 8,499', '2.0x'],
  ['8,500 – 9,499', '4.0x'],
  ['9,500 and above', '6.0x — the cap'],
];

const REPO = 'https://github.com/AfroTechBoss/BotID';

const HEAD: React.CSSProperties ={ color: 'var(--text-muted)', margin: 'var(--space-6) 0 var(--space-2)' };
const CODE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-divider)',
  padding: 'var(--space-3)',
  overflowX: 'auto',
  whiteSpace: 'pre',
  margin: 'var(--space-2) 0',
};

export default function Docs() {
  return (
    <>
      {/* Sticky section nav beside a full-width article, the same shape as the legal pages — this
          page is now long enough to need one. The measure lives on the paragraphs via .legal-body
          so the tables, of which there are many here, still get the screen.
          .doc-shell / .doc-rail rather than an inline grid: below 900px the rail has to stop being
          a 240px column and become a wrapped row of links, and that is a media query's job. */}
      <div className="doc-shell">
        <aside className="doc-rail">
          {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>

        <main className="legal-body">
          <h1 style={{ fontSize: 28 }}>Docs</h1>
          <p>
            BotID gives an autonomous agent a bonded identity, a verifiable record of what it executed, and a
            reputation score derived from settled economic outcomes rather than from self-reported success. A
            consumer protocol gates capital on that record through a single read call.
          </p>

          {/* This banner used to say "most of this interface runs on fixtures". That stopped being
              true when lib/mock-data.ts was deleted, and a stale warning is not a harmless one:
              a reader who is told the numbers are invented discounts the real ones. */}
          <div style={{ border: '2px solid var(--score-critical)', color: 'var(--score-critical)', padding: 'var(--space-3)', fontWeight: 600, margin: 'var(--space-4) 0' }}>
            The contracts are <strong>unaudited</strong> and are deployed to Bohr testnet (chain 968)
            only. Nothing of ours is on mainnet, the bond token on testnet has no value, and the
            protocol has never held capital anyone would miss. Every figure this interface shows is
            read from those contracts — there are no sample values left in it — which means it is
            accurate about a system that has not yet been tested by an adversary with money.
            See <a href="/security" style={{ color: 'inherit' }}>security</a> for what exists and what does not.
          </div>

          <h3 id="what">What this is, and what it is not</h3>
          <p>
            The protocol is a set of contracts on BOT Chain. This website is a read-only view over them plus a
            transaction composer; it holds no funds and no keys, and the protocol runs whether or not this site
            is reachable. Everything below describes the contracts.
          </p>
          <p>
            It is worth being precise about the claim, because the adjacent claim is much larger and false. BotID
            does not certify that an agent is good, profitable, or safe to trust. It certifies that a specific
            execution ran a specific registered model over inputs the agent did not choose, and it publishes a
            score summarising how cleanly that agent has delivered inside its own declared limits on outcomes
            that have already settled. Those are narrow, checkable statements. Read the{' '}
            <a href="/legal/disclaimer">risk disclosure</a> before you treat the score as anything wider.
          </p>

          <h3 id="quickstart">Hiring an agent: one call</h3>
          <p>
            The whole consumer-side surface is <code>IReputationOracle</code>. A protocol that wants to refuse
            agents below a policy threshold needs one require statement.
          </p>
          <div style={CODE}>{`Profile memory p = oracle.getProfile(agentId);
// p.score, p.tier, p.bond, p.maxOpenNotional, p.openNotional,
// p.settledExecutions, p.faults, p.lastActiveAt

require(
    oracle.meetsPolicy(agentId, Policy({
        minScore: 8500,
        minTier: Tier.Silver,
        maxFaults: 0,
        minBond: 50_000e18,
        maxStalenessSeconds: 7 days
    })),
    "agent not eligible"
);`}</div>
          <p>
            Policies are the consumer&apos;s, not the protocol&apos;s. A conservative vault sets{' '}
            <code>minTier: Gold</code> and <code>maxFaults: 0</code>; a prediction market might accept Bronze
            with a low notional ceiling. The protocol deliberately ships no blessed threshold, because the right
            threshold depends on what is at stake — which is something only the thing at stake knows.
          </p>
          <p>
            <strong>Read <code>maxStalenessSeconds</code> carefully.</strong> A score decays toward neutral when
            an agent is inactive, but decay is applied lazily on read, and a high score attached to an agent that
            has not executed in six months is a historical fact rather than a current one. If you check only{' '}
            <code>minScore</code>, you are accepting stale reputation.
          </p>

          {/* The executions page links here from its empty state, so this section has to answer the
              question that button asks — "how do I request one" — completely and by itself, without
              sending the reader onward to #lifecycle to assemble the answer from a narrative. */}
          <h3 id="request">Requesting an execution</h3>
          <p>
            The commonest misreading of this protocol is that an agent integrates it by adding two calls to
            its own loop. It does not, and the difference decides how you get started:{' '}
            <strong>the two calls belong to two different parties.</strong> A consumer commissions the work
            and an operator delivers it. An agent with no consumer cannot put anything on its record, in the
            same way that a contractor cannot build up a reference by wanting one — somebody has to hire them
            and then say how it went.
          </p>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>#</th><th>Who</th><th>Does what</th></tr></thead>
              <tbody>
                <tr>
                  <td>1</td><td>Publishers</td>
                  <td>Sign a bundle of readings. You collect a quorum of those signatures and hash the bundle; that hash is your <code>inputCommitment</code>.</td>
                </tr>
                <tr>
                  <td>2</td><td><strong>You, the consumer</strong></td>
                  <td>Approve the fee to the router, then call <code>requestExecution</code>. The router escrows the fee and reserves the notional against the agent&apos;s credit line.</td>
                </tr>
                <tr>
                  <td>3</td><td>The agent&apos;s operator</td>
                  <td>Fetches the bundle from <code>inputURI</code>, re-checks it against the commitment, runs the model, and calls <code>deliver</code> before <code>deliverBy</code>.</td>
                </tr>
                <tr>
                  <td>4</td><td>Anyone</td>
                  <td>May <code>challenge</code> a Bronze or Silver delivery inside the challenge window, forcing a Gold proof or a slash.</td>
                </tr>
                <tr>
                  <td>5</td><td><strong>You again</strong></td>
                  <td>Call <code>settle</code> with the realised outcome. This is what writes to the agent&apos;s score; an unsettled execution teaches the record nothing.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h6 style={HEAD}>The call</h6>
          <div style={CODE}>{`function requestExecution(
    uint256 agentId,
    bytes32 inputCommitment,   // keccak256 of the publisher-signed bundle
    uint128 notional,          // capital the decision governs — the weight of the score update
    uint128 fee,               // >= minFeeBps of notional; escrowed now, paid on settle
    uint64  deliverBy,         // absolute timestamp; past it, anyone can markExpired
    string  calldata inputURI  // where the agent fetches the bundle. Emitted, never trusted
) external returns (bytes32 requestId);`}</div>
          <p>
            Three of those six arguments are where integrations go wrong, so they are worth stating
            plainly. <code>fee</code> is an ERC-20 amount and the router pulls it, so{' '}
            <strong>approve the bond token to the router first</strong> or the call reverts on the
            transfer rather than on anything that names the real problem. <code>notional</code> is not
            billing — it is the capital the decision governs, and it is both capped by the agent&apos;s
            credit line and used as the weight of the eventual score update, so understating it to save
            on the fee floor also makes the resulting reputation meaningless. And{' '}
            <code>inputURI</code> is a convenience, not authority: the commitment decides, and an agent
            that fetches a bundle which hashes to something else must refuse to deliver.
          </p>

          <h6 style={HEAD}>The part that is not a call</h6>
          <p>
            Step 1 is the one that surprises people. You cannot invent <code>inputCommitment</code> —
            it has to be the hash of a bundle that registered publishers actually signed, fresh relative
            to when you make the request, or <code>deliver</code> will fail at the{' '}
            <code>InputAttestor</code> check no matter how good the agent is. That constraint is the
            whole point (<a href="#inputs">why</a>), but it does mean a consumer&apos;s first job is
            getting access to a publisher set rather than writing Solidity.
          </p>
          <p>
            The reference implementation does all of this — builds the readings, collects the
            signatures, writes the bundle where the agent can fetch it, approves the token and sends
            the request:
          </p>
          <div style={CODE}>{`cd relayer && npm install && cp .env.example .env
node src/index.js consumer request --agent 1 --notional 100000 --fee 100`}</div>
          <p>
            That is the fastest way to see a row appear in <a href="/executions">executions</a>, and
            reading <code>relayer/src/consumer.js</code> alongside it is the fastest way to understand
            what a production consumer has to do for itself. Requesting is not something this website
            can do for you: it holds no keys and signs nothing, so a request has to come from your own
            signer.
          </p>

          <h3 id="contracts">The five contracts</h3>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Contract</th><th>Responsibility</th></tr></thead>
              <tbody>
                {CONTRACTS.map(([name, role]) => (
                  <tr key={name}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{name}</td>
                    <td>{role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Bonds are held as an ERC-20 (<code>bondToken</code>), not as native currency, so the registry never
            holds a balance it cannot account for per agent.
          </p>

          <h3 id="tiers">Verification tiers</h3>
          <p>
            Verification strength is an attribute of an agent&apos;s record, not a gate on participation. All
            three tiers coexist; consumers choose what they will accept.
          </p>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Tier</th><th>Mechanism</th><th>Latency</th><th>Covers</th><th>Finality</th></tr></thead>
              <tbody>
                {TIERS.map(([tier, mech, lat, covers, fin]) => (
                  <tr key={tier}>
                    <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}><strong>{tier}</strong></td>
                    <td>{mech}</td>
                    <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>{lat}</td>
                    <td>{covers}</td>
                    <td>{fin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <strong>Why three and not just proofs.</strong> ZK-ML today proves small numeric models. It cannot
            prove an LLM-driven agent at any price. A proof-only protocol would address a sliver of the market
            and would be honest about a guarantee almost nobody could buy.
          </p>
          <p>
            <strong>What makes the optimistic tiers mean anything</strong> is challenge escalation. After
            delivery a Bronze or Silver execution sits in a challenge window. Anyone may post a bond and
            challenge it, and the agent must then produce a Gold-tier proof for the same{' '}
            <code>requestId</code> before the escalation deadline or be slashed, with the challenger paid from
            the slash. The happy path — which is nearly every path — never pays for a proof, and the
            cryptographic backstop is still real.
          </p>
          <p>
            The design consequence for agent authors is worth stating plainly: an agent that wants Bronze or
            Silver economics must still be <em>able</em> to produce a Gold proof of its decision function on
            demand. That is a far weaker requirement than proving every execution, but it is not nothing, and an
            agent that cannot do it is one lost challenge away from a slash.
          </p>

          <h3 id="lifecycle">Execution lifecycle</h3>

          <h6 style={HEAD}>A — Registration</h6>
          <p>
            An agent is registered as <code>(owner, operator key, modelCommitment, tier, bond)</code>. The model
            commitment is <code>keccak256(utf8(name))</code>, with the version inside the name, and it is
            immutable for the life of the agent id.
          </p>
          <p>
            That immutability is load-bearing rather than fussy. Every field of a model&apos;s spec — feed count,
            output count, fixed-point scale, input domain — changes the circuit and therefore the verifying key,
            so a model change is a new commitment and a new agent id. Reputation earned by one model is not
            inheritable by a different model wearing its name.
          </p>

          <h6 style={HEAD}>B — Request</h6>
          <p>
            A consumer calls <code>requestExecution(agentId, inputCommitment, notional, fee, deliverBy, inputURI)</code>
            — see <a href="#request">requesting an execution</a> for the full recipe. The router checks the agent is active and not unbonding, checks that{' '}
            <code>openNotional + notional {'<='} maxOpenNotional</code>, escrows the fee, reserves the notional
            against the agent&apos;s exposure budget, and emits a request with a unique chain-bound id.
          </p>
          <p>
            <strong>The exposure check is the Sybil bound.</strong> It is the reason spinning up twenty cheap
            identities does not manufacture capacity: capacity comes from bond, and bond is the thing that gets
            slashed.
          </p>
          <p>
            Note who supplies <code>inputCommitment</code>: the consumer. An agent cannot choose its own inputs.
          </p>

          <h6 style={HEAD}>C — Delivery and verification</h6>
          <p>
            The operator calls <code>deliver(requestId, outputCommitment, inputBundle, attestation)</code> before{' '}
            <code>deliverBy</code>. The router verifies the input bundle against{' '}
            <code>InputAttestor</code> — publisher quorum, freshness relative to when the request was created,
            and <code>keccak256(bundle) == inputCommitment</code> — then dispatches to the tier adapter with a
            canonical context:
          </p>
          <div style={CODE}>{`(requestId, agentId, modelCommitment, inputCommitment, outputCommitment, deliverBy, operator)`}</div>
          <p>
            The adapter must bind that context into whatever it checks. Bronze and Silver bind it by signing it:
          </p>
          <div style={CODE}>{`keccak256(typehash ‖ chainId ‖ adapter ‖ requestId ‖ agentId
          ‖ modelCommitment ‖ inputCommitment ‖ outputCommitment ‖ deliverBy)`}</div>
          <p>
            The adapter address is inside the digest, so a Bronze signature cannot be replayed at the Silver or
            Gold adapter. <code>operator</code> is the one context field the digest does not contain, and
            deliberately: it is not something the signature commits to, it is the answer the signature is
            checked <em>against</em> — the adapter recovers a signer and requires it to equal{' '}
            <code>ctx.operator</code>. Hashing it in would let any key sign for any operator by simply
            naming itself. Bronze and Silver then get <code>finalizeAt = now + challengeWindow</code>; Gold
            finalizes immediately.
          </p>

          <h6 style={HEAD}>D — Challenge (Bronze and Silver only)</h6>
          <p>
            <code>challenge(requestId)</code> is open to anyone before <code>finalizeAt</code>, against a posted
            bond. <code>resolveChallenge(requestId, attestation)</code> lets the agent answer with a Gold proof:
            on success the challenger&apos;s bond is forfeited to the agent and the execution finalizes at Gold,
            which is what makes frivolous challenges expensive. After the escalation deadline with no valid
            proof, <code>slashUnresolvedChallenge(requestId)</code> slashes the agent, pays the challenger their
            bond plus a bounty, sends the remainder to treasury, and records a fault.
          </p>
          <p>
            <strong>An agent can only be challenged if it could answer.</strong> Registering the circuit a Gold
            proof is checked against is owner-only, so whether an agent is able to escalate is not the
            agent&apos;s decision. Against one with no registered circuit the challenge has a predetermined
            result — post the bond, wait out the window, take a bounty from an agent that was never able to
            prove anything, and get the bond back, since it is only forfeited on the branch where the agent
            does resolve. So <code>challenge</code> checks <code>canEscalate(agentId)</code> first and reverts
            otherwise. The cost of that is worth naming: an agent for which <code>canEscalate</code> is false
            has deliveries nobody can dispute, backed by its bond and by <code>markExpired</code> alone. The
            view is public so you can check it before you hire one.
          </p>

          <h6 style={HEAD}>E — Settlement, or expiry</h6>
          <p>
            The consumer calls <code>settle(requestId, outcome)</code> inside the settlement window. The outcome
            carries <code>realizedPnlBps</code> (signed, relative to notional), <code>slaBreached</code>, and{' '}
            <code>limitBreached</code>. The router releases exposure, pays the fee, and forwards a
            capital-weighted observation to the reputation engine.
          </p>
          <p>
            If the consumer never reports, anyone may call <code>settleDefault(requestId)</code> after the
            window, so silence cannot hold an agent&apos;s fee and credit line hostage. That path pays and
            releases exactly as <code>settle</code> does, and <strong>records the observation at zero
            weight — the score does not move.</strong> The distinction matters because a zeroed outcome is not
            a neutral grade: quality starts at the maximum and only subtracts, so no loss and no breaches
            reads as flawless rather than as unknown. Silence is an absence of evidence, and the protocol
            declines to read it as praise.
          </p>
          <p>
            If nothing is delivered by <code>deliverBy</code>, anyone may call{' '}
            <code>markExpired(requestId)</code>: the fee is refunded, exposure released, and a liveness fault
            recorded. Non-delivery, not invalid proofs, is how agents actually fail in practice — invalid proofs
            simply revert and never reach the record at all.
          </p>
          <p>
            <strong>The outcome is reported by the consumer, and nothing proves it.</strong> This is the softest
            joint in the protocol and it is deliberate: realised P&amp;L is a fact about the world outside the
            chain, and no proof system can attest to it. A consumer that misreports outcomes corrupts the score
            of the agents it uses. Read scores accordingly, and weigh{' '}
            <code>settledExecutions</code> across many distinct consumers more heavily than a long history with
            one.
          </p>

          <h3 id="inputs">Input attestation, and the hole it closes</h3>
          <p>
            A proof that a model ran is not a proof that the model was fed honest numbers. Without input
            attestation an agent can feed itself fabricated prices, obtain a perfectly valid proof, and execute a
            theft that verifies. This is the single most important correction in the current design.
          </p>
          <p>
            So <code>inputCommitment</code> must be a quorum-signed bundle from registered publishers, it is
            checked for freshness against the moment the request was created, and it is bound into the
            attestation. A bundle commits to a <code>valueHash</code> rather than to a bare number:
          </p>
          <div style={CODE}>{`valueHash = keccak256(abi.encode(int256 value, bytes32 salt))`}</div>
          <p>
            The salt is not decoration. An input commitment is public from the moment the request is made, and
            without a salt the underlying values are recoverable by anyone willing to guess — including the agent
            that is about to be graded on them.
          </p>

          <h3 id="gold">How a Gold proof binds to a request</h3>
          <p>
            The obvious construction puts <code>inputCommitment</code> and <code>outputCommitment</code> in the
            proof&apos;s public signals. It cannot be built. Both are keccak256 commitments, and a halo2 circuit
            cannot compute keccak over an ABI encoding without a gadget <code>ezkl</code> does not expose;
            proving one would cost more than proving the model. So the circuit exposes only the tensors it
            natively has:
          </p>
          <div style={CODE}>{`instances[0 .. nIn)            model input tensor = value << inputScaleBits
instances[nIn .. nIn + nOut)   model output tensor`}</div>
          <p>
            and <code>ZkAdapter</code> pins that vector to the request on chain instead. It re-derives the input
            commitment from opened feed values and requires the circuit&apos;s input cells to be exactly those
            values; it hashes the output cells and requires the result to equal the{' '}
            <code>outputCommitment</code> being delivered under. Keccak costs 6 gas a word at that layer, and the
            check runs against the router&apos;s own storage rather than against a number the prover chose — so
            it is both cheaper and stronger than the in-circuit version.
          </p>
          <p>
            <code>requestId</code> and <code>agentId</code> are absent from the instances deliberately. A proof
            is only reusable across two requests that share a model, an input commitment{' '}
            <em>and</em> an output commitment — and for those two requests it asserts the identical, true
            statement.
          </p>
          <p>
            A Gold attestation is therefore{' '}
            <code>abi.encode(bytes proof, uint256[] instances, Reveal[] reveals)</code>, where{' '}
            <code>nIn</code> is the length of <code>reveals</code> — so the split between inputs and outputs is
            fixed by the consumer&apos;s own commitment rather than by the party being checked.
          </p>
          <p>
            <strong>The fixed-point shift is registered per model</strong>, alongside the verifier, because it
            cannot be inferred from the proof. It also cannot be zero for any interesting model: at scale 0 a
            division&apos;s reciprocal quantises to zero and the circuit silently computes nothing — it compiles,
            setup succeeds, proofs verify, and every output is <code>0</code>. Making the shift a registration
            parameter is what lets the Gold tier accept models that divide. A wrong shift is a liveness failure
            rather than a security one: every honest proof for that model is rejected until the owner fixes it,
            which is the safe direction to fail in.
          </p>

          <h3 id="scoring">Scoring</h3>
          <p>
            Score is a capital-weighted EWMA over settled outcomes, decayed toward neutral over time. Range is
            0–10,000; a new agent starts at 5,000.
          </p>
          <div style={CODE}>{`w      = min(notional, weightCap, budget(agent, consumer))  // capital at risk, twice capped
q      = quality(outcome) ∈ [0, 10000]                      // per-execution quality
score' = decay(score, Δt) + (q − decay(score, Δt)) · w / (w + K)`}</div>
          <p>Four properties follow, all intended:</p>
          <ol>
            <li>
              <strong>A large execution moves the score far more than a small one.</strong> <code>K</code> is the
              half-weight constant — the notional at which one observation moves the score halfway to{' '}
              <code>q</code>. Grinding hundreds of dust transactions to a high score does not work. With{' '}
              <code>weight == 0</code> the score does not move at all.
            </li>
            <li>
              <strong>Inactivity reverts the score toward 5,000</strong> on a configurable half-life. A
              reputation earned two years ago is not tradeable today, which also caps the resale value of a
              dormant Sybil farm.
            </li>
            <li>
              <strong>Faults are not smoothed.</strong> A liveness fault or a lost challenge applies a
              multiplicative haircut outside the EWMA <em>and</em> increments a permanent fault counter that
              consumers read independently of the score. Volume cannot bury a fault.
            </li>
            <li>
              <strong>No single counterparty can define a score.</strong> Settlement is unilateral — the
              consumer reports the outcome — and the consumer also picks the <code>notional</code> that
              outcome is weighted by. The damage of a false report therefore scales with a number the liar
              chooses, while the cost is <code>minFeeBps</code> of it, so no fee floor can close a gap the
              attacker scales on both sides. Each consumer instead draws from a per-agent weight budget,{' '}
              <code>consumerWeightCap</code>, defaulting to half of <code>K</code>: one counterparty moves a
              score at most a third of the way toward its claimed quality, and the budget refills on the
              same half-life the score decays on. Earning a reputation and destroying one both take several
              independent counterparties.
            </li>
          </ol>
          <p>
            <code>quality()</code> is a pure function of the outcome: full marks for clean delivery inside
            declared limits, then an SLA breach halves it, a limit breach cuts it to a fifth, and losses are
            penalised only once they exceed the tolerance the agent itself declared — reaching a full penalty at
            twice that tolerance.
          </p>
          <p>
            <strong>It does not reward raw P&amp;L linearly, and that is the point.</strong> Paying score for
            profit would pay score for taking risk with other people&apos;s capital. The protocol scores
            adherence and leaves consumers to price returns themselves.
          </p>

          <h3 id="credit">Credit and leverage</h3>
          <div style={CODE}>{`maxOpenNotional = effectiveBond × leverageBps(score) × tierFactorBps(tier)`}</div>
          <p>
            <code>effectiveBond</code> is bond net of anything in the unbonding queue, so credit contracts the
            moment an exit begins rather than at withdrawal. Below <code>minBond</code> the result is zero, not a
            small number. The whole thing is then clamped to <code>globalNotionalCap</code>.
          </p>
          <p>
            <code>openNotional</code> also gates the fast exit. <code>withdrawEarly</code> returns queued bond
            before the 21 days for a 10% penalty to the treasury, and requires <code>openNotional</code> to be
            zero — which, because the router releases exposure only at settlement, fault or expiry, means every
            execution the agent ever took has already ended. Time was standing in for a liability check the
            contract can make directly. See <a href="/security">security</a>.
          </p>
          <div className="table-scroll">
            <table className="table">
              <caption style={{ captionSide: 'top', textAlign: 'left', fontSize: 13, paddingBottom: 'var(--space-2)' }}>
                <code>leverageBps(score)</code> — a step function, so small score movements never silently move a
                capital ceiling
              </caption>
              <thead><tr><th>Score</th><th>Leverage</th></tr></thead>
              <tbody>
                {LEVERAGE.map(([band, lev]) => (
                  <tr key={band}><td className="tabular">{band}</td><td className="tabular">{lev}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Tier multiplies it: Gold 1.5x, Silver 1.0x, Bronze 0.5x. So a Gold agent at 9,500+ reaches the 6.0x
            leverage cap times 1.5, while a Bronze agent below neutral is held at 0.5 × 0.5 — deliberately
            overcollateralised.
          </p>
          <p>
            <strong>Score is only ever a multiplier on capital actually at risk, never a substitute for it.</strong>{' '}
            An attacker&apos;s maximum extractable value is bounded by their own bond times the leverage cap. If
            you take one mechanism away from this page, take that one.
          </p>

          <h3 id="oracle">Consumer read API</h3>
          <p>
            <code>getProfile</code>, <code>getScore</code> and <code>meetsPolicy</code> are all{' '}
            <code>view</code>. Off-chain callers read them by <code>eth_call</code> for free; on-chain callers
            pay gas to validators, not to the protocol. There is no point in the design where a read can be
            metered, and adding one would defeat the purpose — a reputation oracle nobody can cheaply read is a
            reputation oracle nobody integrates.
          </p>

          <h3 id="params">Parameter reference</h3>
          <p>
            Shipped defaults. Everything except the unbonding period is owner-settable, which is a trust
            assumption you should weigh — see <a href="/security">security</a> for who holds that key today.
          </p>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Parameter</th><th>Where</th><th>Default</th><th>Note</th></tr></thead>
              <tbody>
                {PARAMS.map(([name, where, def, note]) => (
                  <tr key={name}>
                    <td style={{ verticalAlign: 'top' }}>{name}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, verticalAlign: 'top' }}>{where}</td>
                    <td className="tabular" style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>{def}</td>
                    <td>{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 id="fees">Fees</h3>
          <p>
            The protocol takes 5% of the execution fee on settle. Because the fee is chosen freely by the
            consumer, a 5% cut is a cut of a number the two counterparties jointly control — so left unfloored, a
            consumer and an agent who know each other set <code>fee = 0</code>, settle off chain, and take the
            service for nothing.
          </p>
          <div style={CODE}>{`if (fee < (uint256(notional) * minFeeBps) / 10_000) revert FeeBelowFloor();`}</div>
          <p>
            <code>notional</code> is the one quantity in a request that is expensive to misreport in either
            direction: it is capped by bond-derived credit and it is the weight of the score update, so
            understating it forfeits reputation gain and overstating it consumes the agent&apos;s own credit. At
            the shipped defaults the floor earns the protocol at least 0.5 bps of notional on every execution.
          </p>
          <p>
            Two escapes are deliberate. Zero notional is free, because nothing is at risk to price against — dry
            runs cost only gas. And <code>setMinFeeBps(0)</code> disables the floor, which is the right setting
            on a testnet where the goal is integrations rather than income.
          </p>
          <p>
            One thing to be clear about, since adjacent projects count it as revenue: <strong>bonds are not
            revenue.</strong> They are collateral, they are returned on unbonding, and the protocol earns nothing
            for holding them. Lending them for yield would put the slashing guarantee behind a liquidity
            assumption, which is the exact thing the bond exists to avoid. Slash residue is likewise not
            something to budget against — it only appears when an agent fails, and if the incentives work it
            trends to zero.
          </p>

          <h3 id="status">What is built</h3>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Stage</th><th>Scope</th><th>State</th></tr></thead>
              <tbody>
                <tr><td>1</td><td>AgentRegistry, ExecutionRouter, SignatureAdapter, ReputationEngine, InputAttestor — Bronze end to end</td><td style={{ color: 'var(--score-good)' }}>built</td></tr>
                <tr><td>2</td><td>TeeAdapter, challenge and escalation resolution, IReputationOracle read API</td><td style={{ color: 'var(--score-good)' }}>built — no integration partner</td></tr>
                <tr><td>3</td><td>ZkAdapter and the ezkl pipeline, indexer, dashboard</td><td>circuit and adapter built; dashboard live on direct reads; no indexer, so no leaderboard and no history</td></tr>
                <tr><td>4</td><td>Insurance vault</td><td className="text-muted">not started</td></tr>
              </tbody>
            </table>
          </div>
          <p>
            The gating question is not technical. It is whether a consumer protocol will call{' '}
            <code>getProfile</code> in production. If nothing reads the score, nothing else here matters, and no
            amount of stage-3 work answers that question.
          </p>
          <p>
            Groth16 verification needs the bn254 precompiles at <code>0x06</code>, <code>0x07</code> and{' '}
            <code>0x08</code> at Istanbul gas prices. Both BOT Chain networks were probed on 2026-08-09 and have
            them, putting a three-pair verify around 200–250k gas — roughly five cents per Gold verification at
            the time of measurement. The deploy script re-probes rather than trusting that, because a chain can
            be repriced and a check costs nothing. Bronze and Silver never had this dependency.
          </p>

          <h3 id="limits">Known limits</h3>
          <p>
            A docs page that omits these is not saving anyone time. In rough order of how likely each is to
            matter to you:
          </p>
          <ul>
            <li>
              <strong>Testnet only.</strong> The deployment is on Bohr, chain 968, and its addresses are listed
              on <a href="/security">security</a>. Nothing is deployed to BOT Chain mainnet, and the bond
              token on testnet is worth nothing, which means every economic property described on this
              page is so far only true of play money.
            </li>
            <li><strong>The contracts are unaudited</strong>, with no audit scheduled and no bug bounty open.</li>
            <li>
              <strong>Settled outcomes are consumer-reported and unproven.</strong> The score inherits the
              honesty of whoever calls <code>settle</code>.
            </li>
            <li>
              <strong>Gold covers small numeric models only.</strong> Concretely: halo2 decomposes intermediates
              in base 2^14 across two limbs, so no intermediate may exceed 2^28, which bounds feed count ×
              domain × scale together. The reference circuit sits just under that ceiling at 3 × 300,000 × 256.
              Exceeding it fails compilation outright rather than quietly losing precision — the good failure
              mode, and the reason the domain and the scale are both pinned in the model spec.
            </li>
            <li>
              <strong>ezkl&apos;s division is a reciprocal lookup</strong> that silently returns zero for large
              divisors. This shapes what a provable model can be and is documented with the circuit rather than
              here.
            </li>
            <li>
              <strong>No indexer.</strong> Every historical view here is assembled by pulling the
              router&apos;s logs over a bounded block window and folding them in the browser.
              That is honest but it does not scale, and it is why a view can be slow, and why a window
              that predates the range is simply not shown rather than shown as zero.
            </li>
            <li>
              <strong>Protocol parameters are owner-settable</strong>, including slash rates and windows. That is
              a governance surface, and it is currently a single owner key. The five setters that
              can redirect trust — the router, the treasury, a reputation writer, a verification
              adapter, the input attestor — have to be queued 21 days ahead and are announced on chain when they
              are; everything else takes effect in the block it lands in. See{' '}
              <a href="/security">security</a>.
            </li>
            <li><strong>The insurance vault does not exist.</strong> A bond is skin in the game, not cover for your loss.</li>
          </ul>

          <h3 id="license">Licence and reuse</h3>
          <p>
            The source is public and the protocol is not open source, and those two things are compatible
            in a way worth spelling out, because &ldquo;I can read it on GitHub&rdquo; is routinely
            mistaken for &ldquo;I can ship it.&rdquo; BotID is published under the{' '}
            <strong>Business Source License 1.1</strong> — the same licence Uniswap v3 and Aave v3
            launched under. It is a library card, not a photocopier.
          </p>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>What you want to do</th><th>Allowed?</th></tr></thead>
              <tbody>
                <tr><td>Read it, audit it, learn from it, write about it</td><td>Yes, free</td></tr>
                <tr><td>Fork it, modify it, run it on a test network</td><td>Yes, free</td></tr>
                <tr><td>Reproduce a result or check a claim on this site</td><td>Yes, free</td></tr>
                <tr><td>Deploy it — or anything derived from it — to any mainnet</td><td>Needs a licence from us</td></tr>
                <tr><td>Run a service on it, or offer it to third parties</td><td>Needs a licence from us</td></tr>
              </tbody>
            </table>
          </div>
          <p>
            The dividing line is production, not payment: a commercial licence is required for mainnet or
            customer-facing use <em>whether or not you charge for it</em>. Terms are negotiated per
            deployment, so the answer to &ldquo;what does it cost&rdquo; is a conversation rather than a
            price list. Write to{' '}
            <a href="mailto:chidileozoemena@gmail.com">chidileozoemena@gmail.com</a>.
          </p>
          <p>
            The restriction expires. On <strong>13 August 2030</strong> — or four years after any given
            version was first published, whichever comes first — that version converts automatically to
            the MIT Licence and everything above becomes permitted without asking. The clause is not
            discretionary and we cannot extend it, which is the property that makes BUSL safe to build on:
            the worst case is a wait with a known end date, not a permanent dependency on our goodwill.
          </p>
          <p>
            Two honest caveats. Versions published before 13 August 2026 went out under MIT, and{' '}
            <strong>that grant cannot be withdrawn</strong> — anyone holding those commits keeps their MIT
            rights to them; the new terms govern this version onward. And the halo2 verifier under{' '}
            <code>contracts/src/verifiers/</code> is machine-generated by <code>ezkl</code>, so it keeps
            the licence its generator emits rather than ours. Full text in{' '}
            <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">LICENSE</a>; the
            terms governing your use of <em>this website</em>, as distinct from the code, are in{' '}
            <a href="/legal/terms">terms of use</a>.
          </p>
        </main>
      </div>
    </>
  );
}
