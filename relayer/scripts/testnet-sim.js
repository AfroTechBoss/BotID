#!/usr/bin/env node
/**
 * A cast of fifteen wallets that use the Bohr testnet deployment the way a small market would,
 * one round at a time, so the interface has real, varied traffic to show.
 *
 *   node scripts/testnet-sim.js new-mnemonic   print a fresh mnemonic (store it as SIM_MNEMONIC)
 *   node scripts/testnet-sim.js wallets        list the fifteen addresses and their roles
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
 *   1 - 4    owners     each registers and bonds one Bronze agent
 *   5 - 8    operators  owner i's agent is operated by wallet i + 4; they sign and send `deliver`
 *   9 - 14   consumers  commission work, pay the fee, and grade it at settlement
 *
 * Owners and operators are distinct from consumers by construction, so SelfDealing never trips.
 *
 * WHY IT KEEPS NO STATE FILE. Scheduled runs land in fresh containers, so a local state file is
 * gone by the next round. Everything a round needs is on chain: agents are found through
 * `agentIdByOperator`, and in-flight requests through ExecutionRequested logs filtered on the six
 * consumer addresses. A round is therefore safe to run anywhere, any number of times.
 *
 * A ROUND, in order:
 *   1. top up gas and USDT from the treasury to each role's target, only by the shortfall
 *   2. register any agent that does not exist yet
 *   3. advance every in-flight request: finalize once the challenge window has closed, then
 *      settle with a randomised outcome from the consumer that commissioned it
 *   4. open a random number of new requests (sometimes none), each delivered in the same round
 *      because the input bundle is only fresh for five minutes
 *   5. read the same agents back through botidprotocol.vercel.app's public API, so the site is
 *      exercised as well as the chain
 * ---------------------------------------------------------------------------------------------
 */

const path = require('path');
const { ethers } = require('ethers');

const ABI = require(path.join(__dirname, '..', 'src', 'abi.json'));
const DEPLOYMENT = require(path.join(__dirname, '..', '..', 'contracts', 'deployments', 'bohr-968.json'));

const RPC_URL = process.env.BOHR_RPC_URL || 'https://rpc.bohr.life';
const SITE_URL = (process.env.SIM_SITE_URL || 'https://botidprotocol.vercel.app').replace(/\/$/, '');
const CHAIN_ID = 968n;

// The run stops doing anything after this instant, so a schedule that outlives its week is
// harmless even if nobody remembers to switch it off.
const SIM_UNTIL = process.env.SIM_UNTIL || '2026-10-17T23:59:59Z';

const ROLES = {
  treasury: [0],
  owners: [1, 2, 3, 4],
  operators: [5, 6, 7, 8],
  consumers: [9, 10, 11, 12, 13, 14],
};
const operatorOf = (ownerIndex) => ownerIndex + 4;

// Funding targets. With 10 BOT and 1,000 USDT in the treasury this commits 7 BOT and 960 USDT
// and leaves the rest as a float for top-ups. Bond is 150 rather than the 100 minimum so an agent
// has some credit headroom from the start.
const GAS_TARGET = ethers.parseEther('0.5');
const GAS_FLOOR = ethers.parseEther('0.1');
const BOND_USDT = 150;
const CONSUMER_USDT_TARGET = 60;
const CONSUMER_USDT_FLOOR = 5;

// Per round. Kept small and irregular on purpose: a market of six consumers does not commission
// the same number of jobs every few hours.
const MAX_NEW_REQUESTS = 4;
const IDLE_CHANCE = 0.2;
const NOTIONAL_RANGE_USDT = [10, 60];
const DELIVER_BY_SECS = 30 * 60;

// How far back to look for our own requests. Bohr makes a block about every 0.75s, so 900k
// blocks is a little over a week; the RPC caps one getLogs span at 50k.
const LOOKBACK_BLOCKS = BigInt(process.env.SIM_LOOKBACK_BLOCKS || 900_000);
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
const wait = (p) => p.then((tx) => tx.wait());
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Sign a bare digest; the attestor ecrecovers it unprefixed. See execute-once.js. */
const signDigest = (wallet, digest) => wallet.signingKey.sign(digest).serialized;

function wallets(provider) {
  const phrase = (process.env.SIM_MNEMONIC || '').trim();
  if (!phrase) {
    throw new Error('SIM_MNEMONIC is not set. Run `new-mnemonic` once and store the result as a secret.');
  }
  const mnemonic = ethers.Mnemonic.fromPhrase(phrase);
  return Array.from({ length: 15 }, (_, i) =>
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
    log(`  gas → ${i} ${short(w[i].address)} ${fmtB(need)}`);
    await wait(t.sendTransaction({ to: w[i].address, value: need }));
  }

  // USDT for owners that have not bonded yet, and for consumers that are running low.
  const wants = [];
  for (const i of ROLES.owners) {
    const agentId = await ctx.registry.agentIdByOperator(w[operatorOf(i)].address);
    if (agentId !== 0n) continue;
    const bal = await token.balanceOf(w[i].address);
    if (bal < units(BOND_USDT)) wants.push([i, units(BOND_USDT) - bal]);
  }
  for (const i of ROLES.consumers) {
    const bal = await token.balanceOf(w[i].address);
    if (bal < units(CONSUMER_USDT_FLOOR)) wants.push([i, units(CONSUMER_USDT_TARGET) - bal]);
  }
  for (const [i, amt] of wants) {
    const have = await token.balanceOf(t.address);
    if (have < amt) {
      log(`  ! treasury short on USDT for wallet ${i} (has ${fmtU(have)}, needs ${fmtU(amt)})`);
      continue;
    }
    log(`  usdt → ${i} ${short(w[i].address)} ${fmtU(amt)}`);
    await wait(token.connect(t).transfer(w[i].address, amt));
  }

  // One-time approvals. Owners approve the registry for bonding; consumers approve the router
  // for fees. MaxUint256 is fine on a testnet token with no value.
  for (const i of ROLES.owners) {
    if ((await token.allowance(w[i].address, registryAddr)) === 0n &&
        (await provider.getBalance(w[i].address)) >= GAS_FLOOR) {
      await wait(token.connect(w[i]).approve(registryAddr, ethers.MaxUint256));
    }
  }
  for (const i of ROLES.consumers) {
    if ((await token.allowance(w[i].address, routerAddr)) === 0n &&
        (await provider.getBalance(w[i].address)) >= GAS_FLOOR) {
      await wait(token.connect(w[i]).approve(routerAddr, ethers.MaxUint256));
    }
  }
}

// ------------------------------------------------------------------------- step 2: agents

async function ensureAgents(ctx) {
  const { w, registry, token } = ctx;
  const agents = [];
  for (const i of ROLES.owners) {
    const op = w[operatorOf(i)];
    let agentId = await registry.agentIdByOperator(op.address);
    if (agentId === 0n) {
      const bal = await token.balanceOf(w[i].address);
      if (bal < units(BOND_USDT)) {
        log(`  ! owner ${i} cannot bond yet (has ${fmtU(bal)})`);
        continue;
      }
      // A label hash, not a real model commitment: Bronze never opens it. Loss tolerance varies
      // per agent so the four do not look identical on the leaderboard.
      const commitment = ethers.id(`botid.testnet-sim.agent.${i}`);
      const tolerance = [300, 500, 800, 1200][ROLES.owners.indexOf(i)];
      log(`  registering agent for owner ${i}, operator ${operatorOf(i)}, bond ${BOND_USDT} USDT`);
      await wait(registry.connect(w[i]).registerAgent(op.address, commitment, Tier.Bronze, tolerance, units(BOND_USDT)));
      agentId = await registry.agentIdByOperator(op.address);
    }
    agents.push({ ownerIndex: i, operator: op, agentId });
  }
  return agents;
}

// ---------------------------------------------------------------- step 3: in-flight requests

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
function randomOutcome() {
  const r = Math.random();
  const realizedPnlBps = r < 0.7 ? randInt(10, 320) : r < 0.95 ? -randInt(10, 250) : -randInt(250, 600);
  return { realizedPnlBps, slaBreached: Math.random() < 0.05, limitBreached: false };
}

async function advance(ctx) {
  const { router, provider, w } = ctx;
  const byAddress = new Map(ROLES.consumers.map((i) => [w[i].address.toLowerCase(), w[i]]));
  const ids = await findOurRequests(ctx);
  const now = BigInt((await provider.getBlock('latest')).timestamp);
  const counts = {};
  for (const id of ids) {
    let req = await router.getRequest(id);
    let status = Status[Number(req.status)];
    if (status === 'Delivered' && now >= req.finalizeAt) {
      // Anyone may finalize; the consumer does it so the treasury's gas is not the only gas used.
      const consumer = byAddress.get(req.consumer.toLowerCase());
      log(`  finalize ${id.slice(0, 10)}…`);
      await wait(router.connect(consumer ?? w[0]).finalize(id));
      req = await router.getRequest(id);
      status = Status[Number(req.status)];
    }
    if (status === 'Finalized') {
      const consumer = byAddress.get(req.consumer.toLowerCase());
      if (consumer && now <= req.settleBy) {
        const outcome = randomOutcome();
        log(`  settle   ${id.slice(0, 10)}… agent #${req.agentId} at ${outcome.realizedPnlBps} bps${outcome.slaBreached ? ' (SLA breached)' : ''}`);
        await wait(router.connect(consumer).settle(id, outcome));
        status = 'Settled';
      }
    }
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

// ------------------------------------------------------------------------ step 4: new work

async function openRequests(ctx, agents) {
  const { w, registry, router, attestor, token, provider } = ctx;
  const treasury = w[0];

  if (!(await attestor.publishers(treasury.address))) {
    log(`  ! wallet 0 (${treasury.address}) is not an InputAttestor publisher, so it cannot sign`);
    log(`    input bundles and no new work can be opened. From the deployer key, run:`);
    log(`    PUBLISHER=${treasury.address} npx hardhat run scripts/set-publisher.js --network bohr`);
    return 0;
  }
  if (!agents.length) return 0;
  if (Math.random() < IDLE_CHANCE) {
    log('  quiet round: no new requests');
    return 0;
  }

  const n = randInt(1, MAX_NEW_REQUESTS);
  const minFeeBps = await router.minFeeBps();
  let opened = 0;
  for (let k = 0; k < n; k++) {
    const consumer = w[pick(ROLES.consumers)];
    const agent = pick(agents);
    const profile = await registry.getProfile(agent.agentId);
    const headroom = profile.maxOpenNotional - profile.openNotional;
    let notional = units(randInt(...NOTIONAL_RANGE_USDT));
    if (notional > headroom) notional = headroom;
    if (notional < units(1)) {
      log(`  agent #${agent.agentId} has no credit headroom left, skipping`);
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

    log(`  request  agent #${agent.agentId} by ${short(consumer.address)}: ${fmtU(notional)}, fee ${fmtU(fee)}`);
    const rc = await wait(router.connect(consumer).requestExecution(agent.agentId, inputCommitment, notional, fee, deliverBy, ''));
    const ev = rc.logs
      .map((l) => { try { return router.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === 'ExecutionRequested');
    const requestId = ev.args.requestId;

    const outputCommitment = ethers.id(`output:${requestId}`);
    const agentRec = await registry.getAgent(agent.agentId);
    const attestation = await agent.operator.signTypedData(
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
    log(`  deliver  ${requestId.slice(0, 10)}… by operator ${short(agent.operator.address)}`);
    await wait(router.connect(agent.operator).deliver(requestId, outputCommitment, bundle, attestation));
    opened++;
  }
  return opened;
}

// --------------------------------------------------------------------- step 5: the site

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
    const p = await registry.getProfile(a.agentId);
    log(`  #${a.agentId} score ${p.score} · settled ${p.settledExecutions} · faults ${p.faults} · bond ${fmtU(p.bond)} · open ${fmtU(p.openNotional)} / ${fmtU(p.maxOpenNotional)}`);
  }
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
    const agents = [];
    for (const i of ROLES.owners) {
      const id = await ctx.registry.agentIdByOperator(ctx.w[operatorOf(i)].address);
      if (id !== 0n) agents.push({ ownerIndex: i, operator: ctx.w[operatorOf(i)], agentId: id });
    }
    await printStatus(ctx, agents);
    log('\nrequests', await advanceDryRun(ctx));
    return;
  }

  if (cmd !== 'tick') throw new Error(`unknown command ${cmd}`);

  log(`round at ${new Date().toISOString()} on Bohr (968)`);
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
  log(`  ${agents.map((a) => '#' + a.agentId).join(', ') || 'none yet'}`);
  log('\n3. in-flight');
  log('  ', await advance(ctx));
  log('\n4. new work');
  log(`  opened ${await openRequests(ctx, agents)}`);
  log('\n5. site');
  await touchSite(agents);
  await printStatus(ctx, agents);
}

async function advanceDryRun(ctx) {
  const counts = {};
  for (const id of await findOurRequests(ctx)) {
    const s = Status[Number((await ctx.router.getRequest(id)).status)];
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exitCode = 1;
});
