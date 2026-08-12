/**
 * Drives one execution all the way through the router, on a real deployment.
 *
 *   npx hardhat run scripts/execute-once.js --network bohr
 *
 * Every table in the interface that reads ExecutionRouter is empty for one reason: nothing has
 * ever been executed through it. The contracts are deployed and tested, but a passing unit test
 * and a live deployment are different claims — the test controls time, mints its own token and
 * never disagrees with the chain about a chain id. This closes that gap once, with real gas.
 *
 * Unlike seed.js this is deliberately NOT local-only. It mints nothing, prints no private keys,
 * and spends real testnet balance. It is written to be safe to run against a deployment that
 * other people are looking at, which means it never touches an agent it did not create.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT RESUMES RATHER THAN RUNS STRAIGHT THROUGH
 *
 * A non-Gold delivery opens a one-hour challenge window, and `finalize` reverts until it closes.
 * So the lifecycle cannot complete in one process without holding a node connection open for an
 * hour and hoping nothing blinks. Instead each run does as much as the chain currently permits,
 * writes where it got to, and stops. Run it again after the window and it picks up.
 *
 * It is a relay baton, not a marathon: the state lives in the file, not in the process.
 *
 *   run 1   register (if needed) -> requestExecution -> deliver   ... then wait ~1h
 *   run 2   finalize -> settle
 *
 * The state file records the requestId, so a second run never starts a second execution.
 * ---------------------------------------------------------------------------------------------
 *
 * ALMOST ONE KEY. PRIVATE_KEY is the consumer, the agent owner and the attestation publisher.
 * It cannot also be the operator: the registry enforces one agent per operator address
 * (`agentIdByOperator[operator] != 0` reverts as OperatorInUse), and on this deployment that key
 * already operates agent #1. So the script derives a second key for the operator role and sends
 * it a little gas.
 *
 * That derived key is deterministic — the same PRIVATE_KEY always produces the same operator, so
 * re-running never strands an agent behind a key nobody can reproduce. It is a hot key on a
 * testnet and nothing more; a real operator key lives wherever the model runs, which is the whole
 * reason the registry keeps operator and owner apart in the first place.
 *
 * Beyond that separation the cast is still one person: the consumer who commissions the work and
 * reports the outcome is also the owner of the agent being judged. Fine for proving the pipeline,
 * and not how any of this is meant to be run — the bond only means something when the person
 * grading the work is not the person who did it.
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };

// Bronze routes verification through SignatureAdapter, which asks only that the operator signed
// the execution context. Silver wants an enrolled enclave key and Gold a halo2 proof; on this
// deployment TeeAdapter has emitted nothing but OwnershipTransferred, so Silver cannot deliver
// at all. Bronze is the tier whose trust story is "the bond is the guarantee", and it is the one
// that needs no ceremony to exercise.
const TIER = Tier.Bronze;

// Small enough to be unmistakably a test, large enough that the score actually moves — the
// reputation engine weights an outcome by the capital that was at risk, so a dust notional would
// settle and barely register.
const NOTIONAL_USDT = 25;

// The result the consumer reports at settlement. +120 bps of a 25 USDT notional is a small win,
// chosen over a loss because the first execution on a deployment ends up in screenshots.
const REALIZED_PNL_BPS = 120;

// How long the agent is given to deliver. Generous: the two transactions are seconds apart, and
// a deadline that expires because a node was slow would fault an agent for our impatience.
const DELIVER_BY_SECS = 30 * 60;

const stateFile = (chainId) =>
  path.join(__dirname, "..", "deployments", `execute-once-${network.name}-${chainId}.json`);

const readState = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});
const writeState = (f, s) => fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");

const log = (...a) => console.log(...a);
const wait = (tx) => tx.then((t) => t.wait());

/**
 * Sign a bare 32-byte digest.
 *
 * Not `signMessage`, which prefixes "\x19Ethereum Signed Message:\n32" and produces a signature
 * that recovers to a different address than the one the contract expects. Both digests here go
 * straight into `ecrecover`, so they must be signed raw. This is the single easiest thing to get
 * wrong in this file and it fails as an opaque `InputAttestationFailed` an hour later.
 */
const signDigest = (wallet, digest) => wallet.signingKey.sign(digest).serialized;

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = net.chainId;

  const manifest = path.join(
    __dirname, "..", "deployments", `${network.name}-${chainId}.json`
  );
  if (!fs.existsSync(manifest)) throw new Error(`no manifest at ${manifest}`);
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));

  // A Wallet built from the key rather than a hardhat signer, because raw-digest signing is not
  // something a JSON-RPC signer can do — eth_sign would add the prefix described above.
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is not set");
  const me = new ethers.Wallet(process.env.PRIVATE_KEY.trim(), ethers.provider);

  // The operator, derived rather than configured. Hashing the key with a fixed label gives the
  // same address on every run without asking anyone to store a second secret, and without it ever
  // being written to the state file — the file records the address, which is public anyway.
  const operator = new ethers.Wallet(
    ethers.keccak256(
      ethers.solidityPacked(["bytes32", "string"], [me.privateKey, "botid.execute-once.operator.v1"])
    ),
    ethers.provider
  );

  log(`consumer    ${me.address}`);
  log(`operator    ${operator.address} (derived)`);
  log(`network     ${network.name} (${chainId})`);

  const at = (name, key) => ethers.getContractAt(name, m.contracts[key ?? name], me);

  // Spelled out rather than loaded from an artifact. The repo's own IERC20 is a three-function
  // interface with no `approve`, and MockERC20 is only what gets deployed when no BOND_TOKEN was
  // supplied — so neither name is safe to assume against an arbitrary deployment. Four functions
  // of standard ERC-20 work against whatever is actually there.
  const token = new ethers.Contract(
    m.contracts.bondToken,
    [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function decimals() view returns (uint8)",
    ],
    me
  );
  const registry = await at("AgentRegistry");
  const attestor = await at("InputAttestor");
  const router = await at("ExecutionRouter");

  const decimals = Number(m.bondTokenDecimals ?? 18);
  const units = (n) => ethers.parseUnits(String(n), decimals);
  const fmt = (v) => `${ethers.formatUnits(v, decimals)} USDT`;

  // Fail early and in English. Every one of these reverts deep inside a call otherwise, and
  // "execution reverted" an hour into a lifecycle is a bad way to learn you were short on gas.
  const publisherOk = await attestor.publishers(me.address);
  if (!publisherOk) {
    throw new Error(
      `${me.address} is not an attestation publisher on this deployment, so it cannot sign the ` +
      `input bundle. Either run this from the publisher's key, or have the InputAttestor owner ` +
      `call setPublisher(${me.address}, true).`
    );
  }

  const state = readState(stateFile(chainId));

  // ------------------------------------------------------------------ phase A: an agent to hire
  //
  // Only ever an agent this script registered. Reusing someone else's agent would put their bond
  // behind our test and move their score, which is not ours to spend.
  if (!state.agentId) {
    const minBond = await registry.minBond();
    const balance = await token.balanceOf(me.address);
    if (balance < minBond) {
      throw new Error(`need ${fmt(minBond)} to bond, have ${fmt(balance)}`);
    }

    const allowance = await token.allowance(me.address, await registry.getAddress());
    if (allowance < minBond) {
      log(`approving registry for ${fmt(minBond)}…`);
      await wait(token.approve(await registry.getAddress(), ethers.MaxUint256));
    }

    // A hash of a label, not a real commitment. A production commitment binds weights, verifying
    // key and declared limits; Bronze never opens it, so a label is honest about what it is.
    const modelCommitment = ethers.id(`botid.execute-once.${chainId}.${Date.now()}`);

    log(`registering a Bronze agent, bond ${fmt(minBond)}…`);
    const rc = await wait(
      registry.registerAgent(operator.address, modelCommitment, TIER, 500, minBond)
    );
    const ev = rc.logs
      .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "AgentRegistered");
    if (!ev) throw new Error("registered, but no AgentRegistered event found");

    state.agentId = ev.args.agentId.toString();
    state.operator = operator.address;
    state.modelCommitment = modelCommitment;
    writeState(stateFile(chainId), state);
    log(`  agent #${state.agentId}`);
  } else {
    log(`agent       #${state.agentId} (from a previous run)`);
  }

  const agentId = BigInt(state.agentId);
  const agent = await registry.getAgent(agentId);

  // The operator pays for its own `deliver`, so it needs gas of its own. Topped up only when it
  // is short, and only by the shortfall — this is a throwaway key and anything sent to it that
  // it does not spend is stranded there.
  //
  // Gated on there being a delivery left to make. A resumed run is waiting out the challenge
  // window and the operator does nothing in it, so topping it back up to the floor there is a
  // transaction that buys nothing — refilling the tank of a car that has already arrived.
  const GAS_FLOOR = ethers.parseEther("0.05");
  const opGas = state.requestId ? GAS_FLOOR : await ethers.provider.getBalance(operator.address);
  if (opGas < GAS_FLOOR) {
    log(`funding the operator with ${ethers.formatEther(GAS_FLOOR - opGas)} for gas…`);
    await wait(me.sendTransaction({ to: operator.address, value: GAS_FLOOR - opGas }));
  }

  // ------------------------------------------------------- phase B: request, and phase C: deliver
  if (!state.requestId) {
    const notional = units(NOTIONAL_USDT);
    const profile = await registry.getProfile(agentId);
    if (notional > profile.maxOpenNotional - agent.openNotional) {
      throw new Error(
        `notional ${fmt(notional)} exceeds the agent's remaining credit ` +
        `(${fmt(profile.maxOpenNotional - agent.openNotional)})`
      );
    }

    // Rounded up. The contract's floor is a truncating integer division, so a fee computed the
    // same way lands exactly on the boundary and any rounding the other direction reverts.
    const minFeeBps = await router.minFeeBps();
    const fee = (notional * BigInt(minFeeBps) + 9999n) / 10000n;

    const routerAddr = await router.getAddress();
    if ((await token.allowance(me.address, routerAddr)) < fee) {
      log(`approving router for the fee…`);
      await wait(token.approve(routerAddr, ethers.MaxUint256));
    }

    // The input bundle: one feed reading, signed by the publisher.
    //
    // Timestamped `now` and used immediately, because the attestor measures freshness against the
    // request's own createdAt with a five-minute ceiling. A bundle prepared and then sat on fails
    // as an attestation error rather than as a timeout, which reads like a signing bug.
    const block = await ethers.provider.getBlock("latest");
    const timestamp = BigInt(block.timestamp);
    const feedId = ethers.id("botid.execute-once.feed");
    const valueHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["reference-reading", 1n])
    );

    // Digest and commitment both come from the contract rather than being rebuilt here. The
    // typehashes are on chain; recomputing them in JavaScript is a second source of truth that
    // only ever gets to be wrong.
    const feedDigest = await attestor.feedDigest(feedId, valueHash, timestamp);
    const feed = {
      feedId,
      valueHash,
      timestamp,
      signatures: [signDigest(me, feedDigest)],
    };
    const bundle = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32 feedId,bytes32 valueHash,uint64 timestamp,bytes[] signatures)[]"],
      [[feed]]
    );
    const inputCommitment = await attestor.commit([feed]);

    const deliverBy = timestamp + BigInt(DELIVER_BY_SECS);

    log(`requesting: notional ${fmt(notional)}, fee ${fmt(fee)}…`);
    const rc = await wait(
      router.requestExecution(agentId, inputCommitment, notional, fee, deliverBy, "")
    );
    const ev = rc.logs
      .map((l) => { try { return router.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ExecutionRequested");
    if (!ev) throw new Error("requested, but no ExecutionRequested event found");

    state.requestId = ev.args.requestId;
    writeState(stateFile(chainId), state);
    log(`  requestId ${state.requestId}`);

    // Deliver immediately, in the same run. The freshness ceiling is five minutes and the two
    // transactions are seconds apart, so splitting them across runs would be inviting a failure
    // that has nothing to teach us.
    const outputCommitment = ethers.id(`output:${state.requestId}`);
    const ctx = {
      requestId: state.requestId,
      agentId,
      modelCommitment: agent.modelCommitment,
      inputCommitment,
      outputCommitment,
      deliverBy,
      operator: operator.address,
    };
    const execDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "address", "bytes32", "uint256", "bytes32", "bytes32", "bytes32", "uint64"],
        [
          ethers.id(
            "Execution(bytes32 requestId,uint256 agentId,bytes32 modelCommitment,bytes32 inputCommitment,bytes32 outputCommitment,uint64 deliverBy)"
          ),
          chainId,
          m.contracts.SignatureAdapter,
          ctx.requestId,
          ctx.agentId,
          ctx.modelCommitment,
          ctx.inputCommitment,
          ctx.outputCommitment,
          ctx.deliverBy,
        ]
      )
    );

    // Sent from the operator, and signed by it. `deliver` checks msg.sender against the agent's
    // operator and the adapter checks the signature recovers to the same address, so both the
    // sender and the signer have to be that key — the consumer cannot deliver on the agent's
    // behalf even though it owns it.
    log(`delivering…`);
    await wait(
      router
        .connect(operator)
        .deliver(state.requestId, outputCommitment, bundle, signDigest(operator, execDigest))
    );
    state.outputCommitment = outputCommitment;
    writeState(stateFile(chainId), state);
    log(`  delivered`);
  } else {
    log(`request     ${state.requestId} (from a previous run)`);
  }

  // ------------------------------------------------------ phase D: finalize, and phase E: settle
  const req = await router.getRequest(state.requestId);
  // Copied position-for-position from Types.sol, including None. Leaving None out shifts every
  // name one place to the left, which is the kind of error that reads as an event rather than as a
  // bug: a delivered request reports itself Challenged, and the finalize gate silently waits on a
  // status the request will never hold. An enum is an ordering, so it has to be transcribed whole.
  const Status = {
    None: 0,
    Pending: 1,
    Delivered: 2,
    Challenged: 3,
    Finalized: 4,
    Settled: 5,
    Expired: 6,
    Faulted: 7,
  };

  if (Number(req.status) === Status.Delivered) {
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    if (now < req.finalizeAt) {
      const mins = Number(req.finalizeAt - now) / 60;
      log("");
      log(`The challenge window is still open for ${mins.toFixed(1)} more minutes.`);
      log(`Nothing is stuck — this is the protocol working. Run this again after that and it`);
      log(`will finalize and settle. Progress is saved in ${path.basename(stateFile(chainId))}.`);
      return;
    }
    log(`finalizing…`);
    await wait(router.finalize(state.requestId));
  }

  const after = await router.getRequest(state.requestId);
  if (Number(after.status) === Status.Finalized) {
    log(`settling at ${REALIZED_PNL_BPS >= 0 ? "+" : ""}${REALIZED_PNL_BPS} bps…`);
    await wait(
      router.settle(state.requestId, {
        realizedPnlBps: REALIZED_PNL_BPS,
        slaBreached: false,
        limitBreached: false,
      })
    );
  }

  const final = await router.getRequest(state.requestId);
  const profile = await registry.getProfile(agentId);
  log("");
  log(`status      ${Object.keys(Status)[Number(final.status)]}`);
  log(`agent #${state.agentId} score ${profile.score} · settled ${profile.settledExecutions} · faults ${profile.faults}`);
  log("");
  log(`The interface should now show this on the overview feed, the leaderboard and`);
  log(`/agents/${state.agentId}. If it does not, that is an interface bug and not a chain one.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
