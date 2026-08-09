const config = require("./config");
const { connect } = require("./chain");
const { log, sleep, retry } = require("./util");

const Status = {
  None: 0, Pending: 1, Delivered: 2, Challenged: 3,
  Finalized: 4, Settled: 5, Expired: 6, Faulted: 7,
};

/**
 * The watchtower.
 *
 * Several of the protocol's guarantees are only real if somebody actually calls the function
 * that enforces them. Nothing in `ExecutionRouter` self-executes:
 *
 *   markExpired              an agent that took work and vanished is not faulted until called.
 *                            Pays a slash bounty, so this one funds itself.
 *   slashUnresolvedChallenge a challenge that goes unanswered does nothing on its own. Anyone
 *                            may call it, but the bounty goes to the challenger, not the caller.
 *   finalize                 advances a delivery out of its challenge window so it can settle.
 *   settleDefault            stops a silent consumer holding an agent's exposure hostage.
 *
 * Run one of these per protocol deployment. It is permissionless and stateless — it re-derives
 * everything it needs from the chain on each pass — so running several is harmless beyond the
 * gas the losers waste.
 */
async function run() {
  const key = config.required("WATCHTOWER_KEY");
  const { provider, contracts } = await connect({ key });

  const tracked = new Map(); // requestId -> last seen status
  let cursor = config.startBlock ?? Math.max(0, (await provider.getBlockNumber()) - 5000);

  log.info(`watchtower online, scanning from block ${cursor}`);

  for (;;) {
    try {
      const head = await provider.getBlockNumber();
      if (head >= cursor) {
        for (const ev of await contracts.router.queryFilter(
          contracts.router.filters.ExecutionRequested(),
          cursor,
          head
        )) {
          tracked.set(ev.args.requestId, Status.Pending);
        }
        cursor = head + 1;
      }

      const nowSec = (await provider.getBlock("latest")).timestamp;

      for (const [requestId] of tracked) {
        const r = await contracts.router.getRequest(requestId);
        const status = Number(r.status);

        // Terminal states need no further attention.
        if ([Status.None, Status.Settled, Status.Expired, Status.Faulted].includes(status)) {
          tracked.delete(requestId);
          continue;
        }
        tracked.set(requestId, status);

        const act = async (label, call) => {
          try {
            const tx = await retry(call, { attempts: 3, label });
            await tx.wait(config.confirmations);
            log.info(`${label} ${requestId}`);
          } catch (e) {
            // Losing a race to another watchtower reverts; that is a success, not an error.
            log.warn(`${label} ${requestId} failed: ${e.shortMessage ?? e.message}`);
          }
        };

        if (status === Status.Pending && nowSec > Number(r.deliverBy)) {
          await act("markExpired", () => contracts.router.markExpired(requestId));
        } else if (status === Status.Delivered && nowSec >= Number(r.finalizeAt)) {
          await act("finalize", () => contracts.router.finalize(requestId));
        } else if (status === Status.Challenged && nowSec > Number(r.escalationDeadline)) {
          await act("slashUnresolvedChallenge", () =>
            contracts.router.slashUnresolvedChallenge(requestId)
          );
        } else if (status === Status.Finalized && nowSec > Number(r.settleBy)) {
          await act("settleDefault", () => contracts.router.settleDefault(requestId));
        }
      }
    } catch (e) {
      log.error(`watchtower pass failed: ${e.shortMessage ?? e.message}`);
    }

    await sleep(config.pollIntervalMs);
  }
}

module.exports = { run, Status };
