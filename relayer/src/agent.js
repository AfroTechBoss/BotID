const { ethers } = require("ethers");
const config = require("./config");
const { connect } = require("./chain");
const publisher = require("./publisher");
const { loadRunner } = require("./inference");
const attest = require("./attest");
const { log, retry, Backlog } = require("./util");

/**
 * The agent-side relayer.
 *
 * Its job is narrow: watch for work addressed to one agent id, do that work honestly, and get
 * an attestation on chain before `deliverBy`. Everything it produces is checkable by someone
 * else, which is why it can be this simple.
 *
 * Two loops:
 *   - deliver     ExecutionRequested -> fetch, verify, infer, attest, deliver()
 *   - defend      ExecutionChallenged -> produce a Gold proof, resolveChallenge()
 *
 * The one thing it must never do is deliver on data it did not check. See publisher.verify().
 */
async function start(options) {
  if (options) config.apply(options);
  const key = config.operatorKey ?? config.required("OPERATOR_KEY");
  const { manifest, provider, signer, chainId, contracts } = await connect({ key });

  const agentId = config.agentId ?? (await contracts.registry.agentIdByOperator(signer.address));
  if (!agentId) throw new Error(`no agent registered for operator ${signer.address}`);

  const agent = await contracts.registry.getAgent(agentId);
  if (agent.operator.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`OPERATOR_KEY is not the operator of agent ${agentId}`);
  }

  const adapters = {
    bronze: manifest.contracts.SignatureAdapter,
    silver: manifest.contracts.TeeAdapter,
    gold: manifest.contracts.ZkAdapter,
  };
  const enclave = config.enclaveKey ? new ethers.Wallet(config.enclaveKey) : null;

  // The fixed-point shift comes off the chain, from the registration the adapter will actually
  // check against. Reading it here rather than from a local config is the difference between a
  // scale change being a deployment step and a scale change being a silent outage: every honest
  // proof for the model is rejected while the two disagree, with nothing in the logs to say so.
  const scaleBits = await modelScaleBits(contracts.zkAdapter, agent.modelCommitment, agent.tier);
  const runner = loadRunner(agent.modelCommitment, scaleBits);

  log.info(
    `agent ${agentId} | operator ${signer.address} | tier ${agent.tier} | model ${agent.modelCommitment}`
  );
  log.info(`model runner ${runner.constructor.name} | input scale ${scaleBits} bits`);

  // Keeps per-request state so a delivery that fails transiently is retried rather than lost,
  // and a delivery that fails permanently is not retried forever.
  const backlog = new Backlog();

  /**
   * Decline a request this agent cannot serve, if there is still time.
   *
   * The window is short and measured from `createdAt`, not from when we noticed — a relayer that
   * was restarting when the request landed may well have missed it. Missing it is survivable:
   * the fallback is the liveness fault this was trying to avoid, which is strictly better than
   * crashing the delivery loop over it, so this never throws.
   */
  async function declineRequest(requestId, r) {
    try {
      const window = Number(await contracts.router.rejectionWindow());
      const closesAt = Number(r.createdAt) + window;
      const nowSec = (await provider.getBlock("latest")).timestamp;
      if (nowSec > closesAt) {
        log.error(
          `${requestId} cannot be declined - rejection window closed ${nowSec - closesAt}s ago; ` +
            `this will expire as a liveness fault`
        );
        return;
      }

      const tx = await retry(() => contracts.router.reject(requestId), {
        attempts: 3,
        label: `reject ${requestId}`,
      });
      await tx.wait(config.confirmations);
      log.info(`declined ${requestId} - no fault recorded`);
    } catch (e) {
      log.error(`${requestId} reject failed: ${e.shortMessage ?? e.message}`);
    }
  }

  async function handleRequest(ev) {
    const { requestId, agentId: forAgent, inputCommitment, deliverBy, inputURI } = ev.args;
    if (forAgent !== agentId) return;

    const deadline = Number(deliverBy);
    if (deadline * 1000 <= Date.now()) {
      log.warn(`${requestId} already past deliverBy - skipping`);
      return;
    }

    await backlog.once(requestId, async () => {
      const r = await contracts.router.getRequest(requestId);
      if (Number(r.status) !== 1 /* Pending */) return;

      // 1. Fetch whatever the consumer says the inputs are, then prove to ourselves that it is
      //    what the chain committed to. Everything after this line is honest by construction.
      //
      //    Failing here is not an ordinary error. `requestExecution` is permissionless and takes
      //    `inputCommitment` on trust, so anyone may commission work against this agent over a
      //    commitment they invented, which no bundle can ever satisfy. Retrying such a request
      //    until `deliverBy` earns a liveness fault for a job that was never doable. So a bundle
      //    we cannot obtain or cannot verify is answered by declining, while the rejection
      //    window is still open. See ExecutionRouter.reject.
      let payload, bundleHex, feeds, reveals;
      try {
        payload = await publisher.fetchBundle(inputURI);
        bundleHex = payload.bundle ?? payload;
        feeds = publisher.verify(chainId, manifest.contracts.InputAttestor, bundleHex, inputCommitment);

        // The bundle commits to hashes; the model runs on numbers. `open` checks the numbers
        // served alongside it against those hashes, one by one, so a URI that pairs a correct
        // bundle with doctored values is caught here rather than proven false later.
        reveals = publisher.open(feeds, payload.readings);
      } catch (e) {
        log.warn(`${requestId} inputs unusable: ${e.shortMessage ?? e.message}`);
        await declineRequest(requestId, r);
        return;
      }

      // 2. Run the model — the circuit itself, at every tier. See inference.js.
      const { outputs, outputCommitment } = await runner.run(feeds, reveals);

      // 3. Attest at the tier the agent is registered for.
      const ctx = {
        requestId,
        agentId,
        modelCommitment: agent.modelCommitment,
        inputCommitment,
        outputCommitment,
        deliverBy: deadline,
        operator: signer.address,
      };
      const attestation = await attest.forTier(agent.tier, {
        chainId,
        adapters,
        ctx,
        operator: signer,
        enclave,
        measurement: config.measurement,
        outputs,
        reveals,
        scaleBits,
      });

      // 4. Deliver. Reverting here costs gas but nothing else; missing `deliverBy` costs a
      //    liveness slash and a fault on the permanent record, so retry aggressively.
      const tx = await retry(
        () => contracts.router.deliver(requestId, outputCommitment, bundleHex, attestation),
        { attempts: 5, label: `deliver ${requestId}` }
      );
      const receipt = await tx.wait(config.confirmations);
      log.info(
        `delivered ${requestId} (${feeds.length} feeds, tier ${agent.tier}) in block ${receipt.blockNumber}`
      );
    });
  }

  async function handleChallenge(ev) {
    const { requestId } = ev.args;
    const r = await contracts.router.getRequest(requestId);
    if (r.agentId !== agentId || Number(r.status) !== 3 /* Challenged */) return;

    if (!adapters.gold) {
      log.error(`${requestId} challenged but no Gold adapter is deployed - the bond will be slashed`);
      return;
    }

    await backlog.once(`challenge:${requestId}`, async () => {
      log.warn(`${requestId} challenged - escalating to a Gold proof`);

      // Re-derive the answer from scratch. If this does not reproduce the delivered
      // outputCommitment, the agent was wrong (or non-deterministic) and should let the
      // challenge succeed rather than try to prove something false.
      const payload = await publisher.fetchBundle(await resolveURI(contracts, requestId, provider));
      const feeds = publisher.verify(
        chainId,
        manifest.contracts.InputAttestor,
        payload.bundle ?? payload,
        r.inputCommitment
      );
      const reveals = publisher.open(feeds, payload.readings);
      const { outputs, outputCommitment } = await runner.run(feeds, reveals);

      if (outputCommitment.toLowerCase() !== r.outputCommitment.toLowerCase()) {
        log.error(
          `${requestId} re-run does not reproduce the delivered output — not contesting. ` +
            `This is a bug in the model or the delivery, and the slash is deserved.`
        );
        return;
      }

      const proof = await attest.gold(
        {
          requestId,
          agentId,
          modelCommitment: agent.modelCommitment,
          inputCommitment: r.inputCommitment,
          outputCommitment,
          deliverBy: Number(r.deliverBy),
          operator: signer.address,
        },
        { outputs, reveals, scaleBits }
      );

      const tx = await retry(() => contracts.router.resolveChallenge(requestId, proof), {
        attempts: 5,
        label: `resolveChallenge ${requestId}`,
      });
      await tx.wait(config.confirmations);
      log.info(`${requestId} challenge answered - finalized at Gold`);
    });
  }

  contracts.router.on(contracts.router.filters.ExecutionRequested(null, agentId), (...a) =>
    handleRequest(a[a.length - 1]).catch((e) => log.error(`request handler: ${e.message}`))
  );
  contracts.router.on(contracts.router.filters.ExecutionChallenged(), (...a) =>
    handleChallenge(a[a.length - 1]).catch((e) => log.error(`challenge handler: ${e.message}`))
  );

  // Catch up on anything commissioned while the process was down. Requests are only actionable
  // before `deliverBy`, so a short lookback is enough; START_BLOCK overrides it.
  const head = await provider.getBlockNumber();
  const from = config.startBlock ?? Math.max(0, head - 5000);
  for (const ev of await contracts.router.queryFilter(
    contracts.router.filters.ExecutionRequested(null, agentId),
    from,
    head
  )) {
    handleRequest(ev).catch((e) => log.error(`backfill: ${e.message}`));
  }

  log.info(`watching from block ${from}`);

  // Returned rather than blocking here. The CLI turns this back into "run until killed" by
  // awaiting `stopped`, but a library caller has its own process to run and cannot have a
  // function that never returns — an agent embedded in a larger service is a tenant, not the
  // landlord. `stop()` detaches the listeners so the provider's socket can close; work already
  // in the backlog is left to finish, because abandoning a delivery mid-flight is the one thing
  // that costs the agent a liveness fault.
  return {
    agentId,
    operator: signer.address,
    tier: Number(agent.tier),
    stop: async () => {
      // Order matters, and so does the wait. Destroying the provider cancels whatever poll is in
      // flight, and a cancelled `eth_getFilterChanges` is reported as an error even though it is
      // exactly what shutting down means — hanging up mid-sentence and then complaining the line
      // went dead. Drop the subscriptions first, yield once so the poller can retire them, and
      // treat a cancellation during teardown as the expected outcome it is.
      await contracts.router.removeAllListeners();
      provider.removeAllListeners();
      await new Promise((r) => setTimeout(r, 0));
      try {
        await provider.destroy?.();
      } catch (e) {
        if (e.code !== "UNSUPPORTED_OPERATION") throw e;
      }
    },
    stopped: new Promise(() => {}),
  };
}

/** The CLI's entrypoint: start, then stay up until the process is killed. */
async function run(options) {
  const handle = await start(options);
  await handle.stopped;
}

/**
 * The `inputScaleBits` the model is registered at on `ZkAdapter`.
 *
 * Every tier needs it, not just Gold: the runner quantises by it, and a Bronze delivery whose
 * outputs were computed at the wrong scale is a commitment the agent cannot defend when it is
 * challenged. An unregistered model is fatal at Gold and a warning below it — a Bronze agent can
 * run and deliver honestly today and be registered before anyone challenges it.
 */
async function modelScaleBits(zkAdapter, modelCommitment, tier) {
  const gold = Number(tier) === 3;
  if (!zkAdapter) {
    if (gold) throw new Error("agent is registered at Gold but no ZkAdapter is deployed");
    log.warn("no ZkAdapter deployed — assuming input scale 0, which no dividing model can use");
    return 0;
  }

  const model = await zkAdapter.modelFor(modelCommitment);
  if (model.verifier === ethers.ZeroAddress) {
    const msg = `model ${modelCommitment} has no verifier registered on ZkAdapter`;
    if (gold) throw new Error(`${msg} — Gold deliveries would be rejected`);
    log.warn(`${msg} — this agent cannot answer a challenge until it is`);
  }
  return Number(model.inputScaleBits);
}

/**
 * `inputURI` is event data, not storage — recovering it for an old request means going back to
 * the log that announced it.
 */
async function resolveURI(contracts, requestId, provider) {
  const head = await provider.getBlockNumber();
  const logs = await contracts.router.queryFilter(
    contracts.router.filters.ExecutionRequested(requestId),
    Math.max(0, head - 50_000),
    head
  );
  if (!logs.length) throw new Error(`cannot recover inputURI for ${requestId}`);
  return logs[0].args.inputURI;
}

module.exports = { run, start };
