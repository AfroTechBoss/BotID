#!/usr/bin/env node
/**
 * A cast of wallets that use the Bohr testnet deployment the way a small, imperfect market would,
 * one round at a time, so the interface has real, varied traffic to show and the unhappy paths
 * get exercised as well as the happy one.
 *
 *   node scripts/testnet-sim.js new-mnemonic   print a fresh mnemonic (store it as SIM_MNEMONIC)
 *   node scripts/testnet-sim.js wallets        list the addresses and their roles
 *   node scripts/testnet-sim.js status         balances, agents and in-flight requests
 *   node scripts/testnet-sim.js tick           play one round
 *
 * Bohr only. The chain id is checked on connect and the script refuses anything else: on
 * mainnet the bond token is real USDT, and nothing here is written to be careful with money.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CAST. Every key is derived from one mnemonic (SIM_MNEMONIC) on the standard path
 * m/44'/60'/0'/0/i, so a fresh container with only that secret reproduces every address, and no
 * key is ever written to disk or to the repository.
 *
 *   0        treasury   funded by hand; distributes BOT and USDT; signs input bundles (publisher)
 *   1 - 4    owners     own the nine agents (see AGENTS for who owns which)
 *   5 - 8    operators  of agents A to D; they sign and send `deliver`
 *   9 - 14   consumers  ordinary consumers: commission work, pay fees, grade it, expire it
 *   15       operator   of agent E, the one agent registered on the reference Gold model
 *   16 - 19  operators  of agents F to I, added 2026-10-13
 *   20 - 22  consumers  with habits of their own: a big buyer, a picky one and a challenger
 *
 * AGENTS ARE NOT CLONES. Each has a profile (PROFILES below) that sets how often it declines or
 * misses work and how its results are distributed, and its own bond. Scores on the leaderboard
 * therefore spread because the agents behave differently, not because the dice happened to fall
 * differently: a reliable agent climbs, a flaky one collects liveness faults, a risky one swings.
 *
 * Agent E exists because `challenge` reverts NotEscalatable against an agent whose model has no
 * Gold verifier, and the four label-hash agents have none. Registering one agent on the
 * deployment's reference model commitment is what makes challenges possible at all. It cannot
 * produce the halo2 proof that would answer one, so every challenge against it is lost and
 * slashed: that is the path being exercised, not a bug in the cast.
 *
 * WHY IT KEEPS NO STATE FILE. Scheduled runs land in fresh containers, so a local state file is
 * gone by the next round. Everything a round needs is on chain: agents are found through
 * `agentIdByOperator`, and in-flight requests through ExecutionRequested logs filtered on the six
 * consumer addresses. Whether a consumer goes silent on a request is a function of the request id,
 * so two rounds always agree about it. A round is safe to run anywhere, any number of times.
 *
 * A ROUND, in order:
 *   1. top up gas and USDT from the treasury, only by the shortfall; a refilled treasury simply
 *      means larger top-ups and bond increases from then on
 *   2. register any agent that does not exist yet
 *   3. bond housekeeping: restore bonds eaten by slashes, sometimes add to a bond, sometimes start
 *      unbonding a slice and later withdraw it early, sometimes pause an agent and later resume it
 *   4. advance every in-flight request to the next state the clock allows: expire undelivered
 *      work, finalize, slash unanswered challenges, settle, or settle by default for consumers
 *      that went silent
 *   5. open a random number of new requests. Most are delivered at once; some are declined by
 *      the operator, some are never delivered and left to expire, and some deliveries by agent E
 *      are challenged. How often each happens depends on the agent's profile
 *   6. read the agents back through botidprotocol.vercel.app's public API
 * ---------------------------------------------------------------------------------------------
 */

const path = require('path');
// ethers from node_modules when it is installed, otherwise the copy vendored beside this file.
// Scheduled runs land in containers whose network policy may not reach the npm registry, and a
// round that dies on `npm install` before sending anything is the least useful way to fail.
const { ethers } = (() => {
  try { return require('ethers'); } catch { return require('./vendor/ethers-6.17.0.umd.min.js'); }
})();

const ABI = require(path.join(__dirname, '..', 'src', 'abi.json'));
const DEPLOYMENT = require(path.join(__dirname, '..', '..', 'contracts', 'deployments', 'bohr-968.json'));

const RPC_URL = process.env.BOHR_RPC_URL || 'https://rpc.bohr.life';
const SITE_URL = (process.env.SIM_SITE_URL || 'https://botidprotocol.vercel.app').replace(/\/$/, '');
const CHAIN_ID = 968n;

// The run stops doing anything after this instant, so a schedule that outlives its purpose is
// harmless even if nobody remembers to switch it off.
const SIM_UNTIL = process.env.SIM_UNTIL || '2026-11-10T23:59:59Z';

const WALLET_COUNT = 23;
const ROLES = {
  treasury: [0],
  owners: [1, 2, 3, 4],
  operators: [5, 6, 7, 8, 15, 16, 17, 18, 19],
  consumers: [9, 10, 11, 12, 13, 14, 20, 21, 22],
};

/**
 * How an agent behaves. Chances are per request; outcomes are drawn per settlement.
 *
 *   win       chance a settled result is a gain, and the range of that gain in bps
 *   loss      the range of an ordinary loss
 *   blowup    chance of a large loss, and its range
 *   sla       chance the consumer reports an SLA breach
 *   reject    chance the operator declines inside the rejection window
 *   ghost     chance the operator accepts and then never delivers (liveness fault, 2% slash)
 */
const PROFILES = {
  steady: { win: [0.7, 10, 320], loss: [10, 250], blowup: [0.05, 250, 600], sla: 0.05, reject: 0.08, ghost: 0.1 },
  reliable: { win: [0.85, 40, 250], loss: [10, 80], blowup: [0.01, 150, 300], sla: 0.01, reject: 0.03, ghost: 0.02 },
  flaky: { win: [0.6, 10, 200], loss: [20, 300], blowup: [0.05, 300, 700], sla: 0.15, reject: 0.15, ghost: 0.3 },
  risky: { win: [0.55, 150, 800], loss: [100, 500], blowup: [0.15, 500, 1200], sla: 0.05, reject: 0.05, ghost: 0.05 },
};

/**
 * The agents. `bond` is the level housekeeping keeps it at (restored after slashes); `notional` is
 * the job size consumers commission from it, still capped by its credit.
 *
 * A to E keep the operators and commitments they were registered with. F to I were added so the
 * market has a spread of behaviours and of capital: a well-capitalised reliable agent, a thinly
 * bonded flaky one sitting a slash or two from losing its credit, a risky mid-size one and a whale.
 */
const AGENTS = [
  { key: 'A', owner: 1, operator: 5, profile: 'steady', bond: 150, notional: [10, 60] },
  { key: 'B', owner: 2, operator: 6, profile: 'reliable', bond: 150, notional: [10, 60] },
  { key: 'C', owner: 3, operator: 7, profile: 'risky', bond: 150, notional: [10, 60] },
  { key: 'D', owner: 4, operator: 8, profile: 'flaky', bond: 150, notional: [10, 60] },
  { key: 'E', owner: 1, operator: 15, profile: 'steady', bond: 150, notional: [10, 60], gold: true },
  { key: 'F', owner: 2, operator: 16, profile: 'reliable', bond: 250, notional: [20, 100] },
  { key: 'G', owner: 3, operator: 17, profile: 'flaky', bond: 110, notional: [5, 40] },
  { key: 'H', owner: 4, operator: 18, profile: 'risky', bond: 200, notional: [20, 90] },
  { key: 'I', owner: 2, operator: 19, profile: 'reliable', bond: 500, notional: [50, 220] },
];
const profileOf = (a) => PROFILES[a.profile] ?? PROFILES.steady;
// A to D were registered under owner-numbered labels; kept so a re-registration after a wipe would
// produce the same commitments. Later agents are labelled by key.
const commitmentFor = (a) =>
  a.gold
    ? DEPLOYMENT.goldModel.commitment
    : ethers.id(`botid.testnet-sim.agent.${'ABCD'.includes(a.key) ? a.owner : a.key}`);
const lossToleranceFor = (a) => ({ A: 300, B: 500, C: 800, D: 1200, E: 600, F: 400, G: 1500, H: 1000, I: 250 })[a.key];

/**
 * Consumers with habits. Everyone not listed is ordinary: hires any agent with headroom, at the
 * agent's usual job size.
 *
 *   size       multiplier on the agent's usual job size
 *   minScore   only hires agents at or above this score with no faults
 *   challenge  a challenger by temperament: first in line to challenge agent E, and prefers it
 *   usdt       balance target, larger for consumers that post bonds or buy big
 */
const CONSUMERS = {
  20: { size: 2, usdt: 150 },
  21: { minScore: 5000, usdt: 60 },
  22: { challenge: true, usdt: 120 },
};
const consumerProfile = (i) => CONSUMERS[i] ?? {};

// Funding targets. Bond is 150 rather than the 100 minimum so an agent has some credit headroom,
// and so one lost challenge (20% of bond) does not drop it straight below the floor.
const GAS_TARGET = ethers.parseEther('0.5');
const GAS_FLOOR = ethers.parseEther('0.1');
const CONSUMER_USDT_TARGET = 60;
const CONSUMER_USDT_FLOOR = 5;

// Per round. Kept small and irregular on purpose.
// More agents means more work per round, or the new ones would starve the old.
const MAX_NEW_REQUESTS = 6;
const IDLE_CHANCE = 0.15;
const DELIVER_BY_SECS = 30 * 60;

// The unhappy paths not set per agent, as chances per request or per agent per round. Declines and
// missed deliveries are in PROFILES.
const CHALLENGE_CHANCE = 0.35;      // a delivery by agent E is challenged (at most one open at a time)
const SILENT_ONE_IN = 10;           // one consumer in ten never settles; settleDefault after 7 days
const EXTRA_BOND_CHANCE = 0.08;
const EXTRA_BOND_TREASURY_MIN = 300; // voluntary bond growth only when the treasury is flush
const UNBOND_CHANCE = 0.06;
const WITHDRAW_EARLY_CHANCE = 0.3;
const PAUSE_CHANCE = 0.03;
const RESUME_CHANCE = 0.6;

// How far back to look for our own requests. Bohr makes a block about every 0.75s, so 1.4M blocks
// is about twelve days: comfortably past the seven-day settlement window that settleDefault waits
// out. The RPC caps one getLogs span at 50k.
const LOOKBACK_BLOCKS = BigInt(process.env.SIM_LOOKBACK_BLOCKS || 1_400_000);
const LOG_WINDOW = 50_000n;

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
// Position-for-position from Types.sol, including None. See execute-once.js for why that matters.
const Status = ['None', 'Pending', 'Delivered', 'Challenged', 'Finalized', 'Settled', 'Expired', 'Faulted', 'Rejected'];

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
];

const log = (...a) => console.log(...a);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const chance = (p) => Math.random() < p;
const wait = (p) => p.then((tx) => tx.wait());
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errMsg = (e) => e.shortMessage || e.reason || e.message || String(e);

/** Sign a bare digest; the attestor ecrecovers it unprefixed. See execute-once.js. */
const signDigest = (wallet, digest) => wallet.signingKey.sign(digest).serialized;

/** Whether the consumer of this request goes silent. Derived, so every round agrees. */
const isSilent = (requestId) => BigInt(requestId) % BigInt(SILENT_ONE_IN) === 0n;

function wallets(provider) {
  const phrase = (process.env.SIM_MNEMONIC || '').trim();
  if (!phrase) {
    throw new Error('SIM_MNEMONIC is not set. Run `new-mnemonic` once and store the result as a secret.');
  }
  const mnemonic = ethers.Mnemonic.fromPhrase(phrase);
  return Array.from({ length: WALLET_COUNT }, (_, i) =>
    ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${i}`).connect(provider ?? null)
  );
}

function roleOf(i) {
  for (const [role, idx] of Object.entries(ROLES)) if (idx.includes(i)) return role.replace(/s$/, '');
  return '?';
}

async function connect() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: false });
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) {
    throw new Error(`refusing to run: ${RPC_URL} is chain ${net.chainId}, this script is Bohr (968) only`);
  }
  const w = wallets(provider);
  const c = DEPLOYMENT.contracts;
  return {
    provider,
    w,
    token: new ethers.Contract(c.bondToken, ERC20, provider),
    registry: new ethers.Contract(c.AgentRegistry, ABI.AgentRegistry, provider),
    router: new ethers.Contract(c.ExecutionRouter, ABI.ExecutionRouter, provider),
    attestor: new ethers.Contract(c.InputAttestor, ABI.InputAttestor, provider),
  };
}

const decimals = Number(DEPLOYMENT.bondTokenDecimals ?? 18);
const units = (n) => ethers.parseUnits(String(n), decimals);
const fmtU = (v) => `${Number(ethers.formatUnits(v, decimals)).toFixed(2)} USDT`;
const fmtB = (v) => `${Number(ethers.formatEther(v)).toFixed(4)} BOT`;

/**
 * Send a transaction, logging rather than throwing on a revert. One agent's bad luck (a credit
 * limit, a race with another round) should cost that one action, not the rest of the round.
 */
async function attempt(label, fn) {
  try {
    const rc = await wait(fn());
    log(`  ${label}`);
    return rc;
  } catch (e) {
    log(`  ! ${label} failed: ${errMsg(e)}`);
    return null;
  }
}

async function liveAgents(ctx) {
  const out = [];
  for (const a of AGENTS) {
    const operator = ctx.w[a.operator];
    const agentId = await ctx.registry.agentIdByOperator(operator.address);
    if (agentId !== 0n) {
      out.push({ ...a, operatorWallet: operator, ownerWallet: ctx.w[a.owner], agentId });
      agentById.set(agentId.toString(), a);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------ step 1: funding

async function fund(ctx) {
  const { w, token, provider } = ctx;
  const t = w[0];
  const routerAddr = await ctx.router.getAddress();
  const registryAddr = await ctx.registry.getAddress();

  // Gas first, so every later step can pay for itself.
  for (let i = 1; i < w.length; i++) {
    const bal = await provider.getBalance(w[i].address);
    if (bal >= GAS_FLOOR) continue;
    const need = GAS_TARGET - bal;
    const have = await provider.getBalance(t.address);
    if (have < need + GAS_FLOOR) {
      log(`  ! treasury short on BOT for wallet ${i} (has ${fmtB(have)})`);
      continue;
    }
    await attempt(`gas → ${i} ${short(w[i].address)} ${fmtB(need)}`, () => t.sendTransaction({ to: w[i].address, value: need }));
  }

  // USDT for consumers: they are what keeps work flowing. Owners are funded on demand, for a
  // registration in ensureAgents and for a bond top-up in housekeeping, so the treasury's dollars
  // are not parked in an owner's wallet waiting for something to happen.
  const wants = [];
  for (const i of ROLES.consumers) {
    const bal = await token.balanceOf(w[i].address);
    const target = units(consumerProfile(i).usdt ?? CONSUMER_USDT_TARGET);
    // A consumer that posts challenge bonds is topped up before it runs dry, not after.
    const floor = consumerProfile(i).challenge ? units(60) : units(CONSUMER_USDT_FLOOR);
    if (bal < floor) wants.push([i, target - bal]);
  }
  for (const [i, amt] of wants) {
    const have = await token.balanceOf(t.address);
    if (have < amt) {
      log(`  ! treasury short on USDT for wallet ${i} (has ${fmtU(have)}, needs ${fmtU(amt)})`);
      continue;
    }
    await attempt(`usdt → ${i} ${short(w[i].address)} ${fmtU(amt)}`, () => token.connect(t).transfer(w[i].address, amt));
  }

  // One-time approvals. Owners approve the registry for bonding; consumers approve the router
  // for fees and challenge bonds. MaxUint256 is fine on a testnet token with no value.
  for (const i of ROLES.owners) {
    if ((await token.allowance(w[i].address, registryAddr)) === 0n &&
        (await provider.getBalance(w[i].address)) >= GAS_FLOOR) {
      await attempt(`approve registry from ${i}`, () => token.connect(w[i]).approve(registryAddr, ethers.MaxUint256));
    }
  }
  for (const i of ROLES.consumers) {
    if ((await token.allowance(w[i].address, routerAddr)) === 0n &&
        (await provider.getBalance(w[i].address)) >= GAS_FLOOR) {
      await attempt(`approve router from ${i}`, () => token.connect(w[i]).approve(routerAddr, ethers.MaxUint256));
    }
  }
}

// ------------------------------------------------------------------------- step 2: agents

async function ensureAgents(ctx) {
  const { w, registry } = ctx;
  // Cheapest first, so a treasury that cannot cover every new agent still gets some registered.
  for (const a of [...AGENTS].sort((x, y) => x.bond - y.bond)) {
    const op = w[a.operator];
    if ((await registry.agentIdByOperator(op.address)) !== 0n) continue;
    const owner = w[a.owner];
    if (!(await ensureUsdt(ctx, owner, units(a.bond)))) {
      log(`  ! agent ${a.key} cannot be bonded yet: the treasury cannot fund its ${a.bond} USDT bond`);
      continue;
    }
    await attempt(
      `registered agent ${a.key} (${a.profile}, owner ${a.owner}, operator ${a.operator}${a.gold ? ', reference Gold model' : ''}), bond ${a.bond} USDT`,
      () => registry.connect(owner).registerAgent(op.address, commitmentFor(a), Tier.Bronze, lossToleranceFor(a), units(a.bond))
    );
  }
  return liveAgents(ctx);
}

// --------------------------------------------------------------- step 3: bond housekeeping

/** Make sure `who` holds `amount`, moving the shortfall from the treasury. False if it cannot. */
async function ensureUsdt(ctx, who, amount) {
  const bal = await ctx.token.balanceOf(who.address);
  if (bal >= amount) return true;
  const gap = amount - bal;
  const have = await ctx.token.balanceOf(ctx.w[0].address);
  if (have < gap) return false;
  return !!(await attempt(`usdt → ${short(who.address)} ${fmtU(gap)} for bond`, () => ctx.token.connect(ctx.w[0]).transfer(who.address, gap)));
}

async function housekeeping(ctx, agents) {
  const { registry, provider } = ctx;
  const now = BigInt((await provider.getBlock('latest')).timestamp);
  for (const a of agents) {
    const rec = await registry.getAgent(a.agentId);
    const owner = a.ownerWallet;
    const effective = rec.bond > rec.unbondingAmount ? rec.bond - rec.unbondingAmount : 0n;

    // Restore a bond that slashes or unbonding have pushed under the working level, so the agent
    // keeps credit. This is what a refilled treasury ends up paying for.
    if (effective < units(a.bond)) {
      const top = units(a.bond) - effective + units(randInt(0, 20));
      if (await ensureUsdt(ctx, owner, top)) {
        await attempt(`bond top-up agent ${a.key} #${a.agentId} +${fmtU(top)}`, () => registry.connect(owner).increaseBond(a.agentId, top));
      } else {
        log(`  ! agent ${a.key} bond is ${fmtU(effective)} and the treasury cannot fund restoring it`);
      }
    } else if (chance(EXTRA_BOND_CHANCE) && (await ctx.token.balanceOf(ctx.w[0].address)) >= units(EXTRA_BOND_TREASURY_MIN)) {
      const extra = units(randInt(10, 40));
      if (await ensureUsdt(ctx, owner, extra)) {
        await attempt(`extra bond agent ${a.key} #${a.agentId} +${fmtU(extra)}`, () => registry.connect(owner).increaseBond(a.agentId, extra));
      }
    }

    // Unbonding: start a small slice now and then; take it out early (paying the 10% toll) once the
    // agent has nothing open, or normally if the 21 days have somehow elapsed.
    if (rec.unbondingAmount === 0n) {
      if (chance(UNBOND_CHANCE) && effective >= units(a.bond + 20)) {
        const slice = units(randInt(10, 20));
        try {
          await registry.connect(owner).startUnbonding.staticCall(a.agentId, slice);
          await attempt(`start unbonding agent ${a.key} #${a.agentId} ${fmtU(slice)}`, () => registry.connect(owner).startUnbonding(a.agentId, slice));
        } catch (e) {
          log(`  skip unbonding agent ${a.key}: ${errMsg(e)}`);
        }
      }
    } else if (now >= rec.unbondingAt) {
      await attempt(`withdraw unbonded ${fmtU(rec.unbondingAmount)} from agent ${a.key}`, () => registry.connect(owner).withdraw(a.agentId));
    } else if (rec.openNotional === 0n && chance(WITHDRAW_EARLY_CHANCE)) {
      await attempt(`withdraw early ${fmtU(rec.unbondingAmount)} from agent ${a.key} (10% toll)`, () => registry.connect(owner).withdrawEarly(a.agentId));
    }

    // Pausing. A paused agent has no credit, so no new work lands on it; work already open still
    // runs to completion.
    if (!rec.active) {
      if (chance(RESUME_CHANCE)) await attempt(`resume agent ${a.key} #${a.agentId}`, () => registry.connect(owner).setActive(a.agentId, true));
    } else if (chance(PAUSE_CHANCE)) {
      await attempt(`pause agent ${a.key} #${a.agentId}`, () => registry.connect(owner).setActive(a.agentId, false));
    }
  }
}

// ---------------------------------------------------------------- step 4: in-flight requests

async function findOurRequests(ctx) {
  const { router, provider, w } = ctx;
  const head = BigInt(await provider.getBlockNumber());
  const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
  const consumerTopics = ROLES.consumers.map((i) => ethers.zeroPadValue(w[i].address, 32));
  const topic0 = router.interface.getEvent('ExecutionRequested').topicHash;
  const ids = [];
  for (let lo = from; lo <= head; lo += LOG_WINDOW) {
    const hi = lo + LOG_WINDOW - 1n < head ? lo + LOG_WINDOW - 1n : head;
    const logs = await provider.getLogs({
      address: await router.getAddress(),
      fromBlock: lo,
      toBlock: hi,
      topics: [topic0, null, null, consumerTopics],
    });
    for (const l of logs) ids.push(l.topics[1]);
  }
  return ids;
}

/**
 * A plausible outcome rather than a constant: mostly modest wins, some losses, the occasional
 * SLA breach. Skewed positive because these agents are not trying to lose, but not so positive
 * that every score converges on the same ceiling.
 */
function randomOutcome(profile = PROFILES.steady) {
  const [winP, winLo, winHi] = profile.win;
  const [blowP, blowLo, blowHi] = profile.blowup;
  const r = Math.random();
  const realizedPnlBps =
    r < winP ? randInt(winLo, winHi) : r < 1 - blowP ? -randInt(profile.loss[0], profile.loss[1]) : -randInt(blowLo, blowHi);
  return { realizedPnlBps, slaBreached: Math.random() < profile.sla, limitBreached: false };
}

/** The sim's agent behind an on-chain agent id, for settling with that agent's profile. */
const agentById = new Map();

async function advance(ctx) {
  const { router, provider, w } = ctx;
  const byAddress = new Map(ROLES.consumers.map((i) => [w[i].address.toLowerCase(), w[i]]));
  const anyConsumer = () => w[pick(ROLES.consumers)];
  const ids = await findOurRequests(ctx);
  const now = BigInt((await provider.getBlock('latest')).timestamp);
  const counts = {};
  for (const id of ids) {
    let req = await router.getRequest(id);
    let status = Status[Number(req.status)];
    const tag = id.slice(0, 10) + '…';
    const consumer = byAddress.get(req.consumer.toLowerCase());

    if (status === 'Pending' && now > req.deliverBy) {
      // Permissionless, and the caller collects the bounty, so any consumer will do it.
      if (await attempt(`expire   ${tag} agent #${req.agentId} never delivered`, () => router.connect(anyConsumer()).markExpired(id))) status = 'Expired';
    } else if (status === 'Delivered' && now >= req.finalizeAt) {
      if (await attempt(`finalize ${tag}`, () => router.connect(consumer ?? w[0]).finalize(id))) {
        req = await router.getRequest(id);
        status = Status[Number(req.status)];
      }
    } else if (status === 'Challenged' && now > req.escalationDeadline) {
      const challenger = byAddress.get(req.challenger.toLowerCase()) ?? anyConsumer();
      if (await attempt(`slash    ${tag} agent #${req.agentId} did not answer its challenge`, () => router.connect(challenger).slashUnresolvedChallenge(id))) status = 'Faulted';
    }

    if (status === 'Finalized') {
      if (now > req.settleBy) {
        if (await attempt(`settle by default ${tag} (consumer stayed silent)`, () => router.connect(anyConsumer()).settleDefault(id))) status = 'Settled';
      } else if (consumer && !isSilent(id)) {
        const outcome = randomOutcome(profileOf(agentById.get(req.agentId.toString()) ?? {}));
        if (await attempt(
          `settle   ${tag} agent #${req.agentId} at ${outcome.realizedPnlBps} bps${outcome.slaBreached ? ' (SLA breached)' : ''}`,
          () => router.connect(consumer).settle(id, outcome)
        )) status = 'Settled';
      }
    }
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

// ------------------------------------------------------------------------ step 5: new work

async function openRequests(ctx, agents, counts) {
  const { w, registry, router, attestor, token, provider } = ctx;
  const treasury = w[0];

  if (!(await attestor.publishers(treasury.address))) {
    log(`  ! wallet 0 (${treasury.address}) is not an InputAttestor publisher, so it cannot sign`);
    log(`    input bundles and no new work can be opened. From the deployer key, run:`);
    log(`    PUBLISHER=${treasury.address} npx hardhat run scripts/set-publisher.js --network bohr`);
    return 0;
  }
  if (!agents.length) return 0;
  if (chance(IDLE_CHANCE)) {
    log('  quiet round: no new requests');
    return 0;
  }

  const n = randInt(1, MAX_NEW_REQUESTS);
  const minFeeBps = await router.minFeeBps();
  const challengeBond = await router.challengeBondAmount();
  let challengesOpen = counts.Challenged || 0;
  let opened = 0;
  for (let k = 0; k < n; k++) {
    const ci = pick(ROLES.consumers);
    const consumer = w[ci];
    const habits = consumerProfile(ci);
    let pool = agents;
    if (habits.minScore !== undefined) {
      const ok = [];
      for (const a of agents) {
        const p = await registry.getProfile(a.agentId);
        if (Number(p.score) >= habits.minScore && Number(p.faults) === 0) ok.push(a);
      }
      if (!ok.length) {
        log(`  picky consumer ${short(consumer.address)} found no agent at score ${habits.minScore} with no faults`);
        continue;
      }
      pool = ok;
    }
    // The challenger hires agent E half the time, because E is the one it can challenge.
    const gold = agents.find((a) => a.gold);
    const agent = habits.challenge && gold && chance(0.5) ? gold : pick(pool);
    const profile = await registry.getProfile(agent.agentId);
    const headroom = profile.maxOpenNotional > profile.openNotional ? profile.maxOpenNotional - profile.openNotional : 0n;
    let notional = units(Math.round(randInt(...agent.notional) * (habits.size ?? 1)));
    if (notional > headroom) notional = headroom;
    if (notional < units(1)) {
      log(`  agent ${agent.key} #${agent.agentId} has no credit headroom${profile.active ? '' : ' (paused)'}, skipping`);
      continue;
    }
    // Rounded up, then a random tip on top so fees are not all exactly the floor.
    const floor = (notional * BigInt(minFeeBps) + 9999n) / 10000n;
    const fee = floor + (floor * BigInt(randInt(0, 50))) / 100n;
    if ((await token.balanceOf(consumer.address)) < fee) {
      log(`  consumer ${short(consumer.address)} cannot cover a ${fmtU(fee)} fee, skipping`);
      continue;
    }

    // Fresh input bundle, signed by the treasury as publisher. See execute-once.js.
    const block = await provider.getBlock('latest');
    const timestamp = BigInt(block.timestamp);
    const feedId = ethers.id(`botid.testnet-sim.feed.${pick(['eth-usd', 'btc-usd', 'bot-usd', 'funding-rate'])}`);
    const valueHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['string', 'uint256'], ['reading', BigInt(Date.now())])
    );
    const digest = await attestor.feedDigest(feedId, valueHash, timestamp);
    const feed = { feedId, valueHash, timestamp, signatures: [signDigest(treasury, digest)] };
    const bundle = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(bytes32 feedId,bytes32 valueHash,uint64 timestamp,bytes[] signatures)[]'],
      [[feed]]
    );
    const inputCommitment = await attestor.commit([feed]);
    const deliverBy = timestamp + BigInt(DELIVER_BY_SECS);

    const rc = await attempt(
      `request  agent ${agent.key} #${agent.agentId} by ${short(consumer.address)}: ${fmtU(notional)}, fee ${fmtU(fee)}`,
      () => router.connect(consumer).requestExecution(agent.agentId, inputCommitment, notional, fee, deliverBy, '')
    );
    if (!rc) continue;
    opened++;
    const ev = rc.logs
      .map((l) => { try { return router.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === 'ExecutionRequested');
    const requestId = ev.args.requestId;
    const tag = requestId.slice(0, 10) + '…';

    // The operator's choice, made now: decline, go dark, or deliver.
    const behaviour = profileOf(agent);
    const roll = Math.random();
    if (roll < behaviour.reject) {
      await attempt(`reject   ${tag} declined by operator ${short(agent.operatorWallet.address)}`, () => router.connect(agent.operatorWallet).reject(requestId));
      continue;
    }
    if (roll < behaviour.reject + behaviour.ghost) {
      log(`  ghost    ${tag} operator will not deliver; it expires after ${DELIVER_BY_SECS / 60} min`);
      continue;
    }

    const outputCommitment = ethers.id(`output:${requestId}`);
    const agentRec = await registry.getAgent(agent.agentId);
    const attestation = await agent.operatorWallet.signTypedData(
      { name: 'BotID', version: '1', chainId: CHAIN_ID, verifyingContract: DEPLOYMENT.contracts.SignatureAdapter },
      {
        Execution: [
          { name: 'requestId', type: 'bytes32' },
          { name: 'agentId', type: 'uint256' },
          { name: 'modelCommitment', type: 'bytes32' },
          { name: 'inputCommitment', type: 'bytes32' },
          { name: 'outputCommitment', type: 'bytes32' },
          { name: 'deliverBy', type: 'uint64' },
        ],
      },
      { requestId, agentId: agent.agentId, modelCommitment: agentRec.modelCommitment, inputCommitment, outputCommitment, deliverBy }
    );
    const delivered = await attempt(
      `deliver  ${tag} by operator ${short(agent.operatorWallet.address)}`,
      () => router.connect(agent.operatorWallet).deliver(requestId, outputCommitment, bundle, attestation)
    );

    // Challenges: only agent E can be challenged, one at a time, by a consumer who can post the bond.
    if (delivered && agent.gold && challengesOpen === 0 && chance(CHALLENGE_CHANCE)) {
      const challengers = [];
      for (const i of ROLES.consumers) {
        if ((await token.balanceOf(w[i].address)) >= challengeBond) challengers.push(i);
      }
      if (!challengers.length) {
        log(`  no consumer can post the ${fmtU(challengeBond)} challenge bond`);
      } else {
        // The challenger by temperament goes first when it can afford to.
        const keen = challengers.find((i) => consumerProfile(i).challenge);
        const challenger = w[keen ?? pick(challengers)];
        if (await attempt(
          `challenge ${tag} by ${short(challenger.address)}, bond ${fmtU(challengeBond)}`,
          () => router.connect(challenger).challenge(requestId)
        )) challengesOpen++;
      }
    }
  }
  return opened;
}

// --------------------------------------------------------------------- step 6: the site

async function touchSite(agents) {
  for (const a of agents) {
    for (const p of [`/api/agents/${a.agentId}?network=bohr`, `/api/agents/${a.agentId}/policy?network=bohr&minScore=5000&minTier=bronze`]) {
      try {
        const res = await fetch(SITE_URL + p, { signal: AbortSignal.timeout(15_000) });
        log(`  GET ${p} → ${res.status}`);
      } catch (e) {
        log(`  GET ${p} → failed (${e.cause?.code || e.message})`);
      }
    }
  }
}

// ----------------------------------------------------------------------------- commands

async function printStatus(ctx, agents) {
  const { w, token, provider, registry } = ctx;
  log('\nwallets');
  for (let i = 0; i < w.length; i++) {
    const [b, u] = await Promise.all([provider.getBalance(w[i].address), token.balanceOf(w[i].address)]);
    log(`  ${String(i).padStart(2)} ${roleOf(i).padEnd(9)} ${w[i].address}  ${fmtB(b).padStart(14)}  ${fmtU(u).padStart(14)}`);
  }
  log('\nagents');
  for (const a of agents) {
    const [p, rec] = await Promise.all([registry.getProfile(a.agentId), registry.getAgent(a.agentId)]);
    log(
      `  ${a.key} #${a.agentId} ${a.profile}${a.gold ? ' (gold model)' : ''} score ${p.score} · settled ${p.settledExecutions} · faults ${p.faults}` +
      ` · bond ${fmtU(p.bond)}${rec.unbondingAmount ? ` (unbonding ${fmtU(rec.unbondingAmount)})` : ''}` +
      ` · open ${fmtU(p.openNotional)} / ${fmtU(p.maxOpenNotional)}${p.active ? '' : ' · PAUSED'}`
    );
  }
}

async function countRequests(ctx) {
  const counts = {};
  for (const id of await findOurRequests(ctx)) {
    const s = Status[Number((await ctx.router.getRequest(id)).status)];
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

async function main() {
  const cmd = process.argv[2] || 'tick';

  if (cmd === 'new-mnemonic') {
    log(ethers.Wallet.createRandom().mnemonic.phrase);
    return;
  }
  if (cmd === 'wallets') {
    wallets().forEach((x, i) => log(`${String(i).padStart(2)} ${roleOf(i).padEnd(9)} ${x.address}`));
    return;
  }

  if (cmd === 'tick' && Date.now() > Date.parse(SIM_UNTIL)) {
    log(`simulation window ended at ${SIM_UNTIL}; nothing to do`);
    return;
  }

  const ctx = await connect();

  if (cmd === 'status') {
    await printStatus(ctx, await liveAgents(ctx));
    log('\nrequests', await countRequests(ctx));
    return;
  }

  if (cmd !== 'tick') throw new Error(`unknown command ${cmd}`);

  log(`round at ${new Date().toISOString()} on Bohr (968), running until ${SIM_UNTIL}`);
  const t = ctx.w[0];
  const [tb, tu] = await Promise.all([ctx.provider.getBalance(t.address), ctx.token.balanceOf(t.address)]);
  log(`treasury ${t.address}: ${fmtB(tb)}, ${fmtU(tu)}`);
  if (tb === 0n) {
    log(`treasury has no BOT for gas. Fund ${t.address} on Bohr and the next round will start.`);
    return;
  }

  log('\n1. funding');
  await fund(ctx);
  log('\n2. agents');
  const agents = await ensureAgents(ctx);
  log(`  ${agents.map((a) => `${a.key} #${a.agentId}`).join(', ') || 'none yet'}`);
  log('\n3. bonds');
  await housekeeping(ctx, agents);
  log('\n4. in-flight');
  const counts = await advance(ctx);
  log('  ', counts);
  log('\n5. new work');
  log(`  opened ${await openRequests(ctx, agents, counts)}`);
  log('\n6. site');
  await touchSite(agents);
  await printStatus(ctx, agents);
}

main().catch((e) => {
  console.error(errMsg(e));
  process.exitCode = 1;
});
