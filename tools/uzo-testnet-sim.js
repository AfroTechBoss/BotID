#!/usr/bin/env node
/**
 * A small cast of testnet wallets that use Uzo Deploy (deploy.uzolabs.xyz) on Bohr testnet:
 * deploy tokens, NFT collections and tip jars through the Uzo factories, verify them through the
 * site's own API, move tokens around, mint, tip, and send a share of the tokens they deploy to one
 * outside address.
 *
 *   node tools/uzo-testnet-sim.js addresses            the wallets, and the team-list entries for them
 *   node tools/uzo-testnet-sim.js fund   --uzo <repo>  one-time: move the old BotID treasury's funds
 *                                                      here and give every actor gas and USDT
 *   node tools/uzo-testnet-sim.js round  --uzo <repo>  a few actions by a few wallets, spaced out
 *   node tools/uzo-testnet-sim.js status --uzo <repo>  balances, transaction counts, deployments
 *
 * `--uzo` is a checkout of github.com/uzolabs/uzo-deploy. Factory addresses come from its
 * config/deployments.json, and its config/team-addresses.json is a hard gate (below).
 *
 * ---------------------------------------------------------------------------------------------
 * THE TEAM-LIST GATE. Uzo's public stats and launch report count independent wallets and leave
 * out the team's own (config/team-addresses.json, read by lib/stats.ts). These wallets are the
 * team's. `fund` and `round` refuse to send anything until every one of them is on that list for
 * chain 968, so the simulation can never be counted as users.
 *
 * THE CAST. Keys come from SIM_MNEMONIC on account 1 (m/44'/60'/1'/0/i), so nothing overlaps
 * with the BotID simulation, which used account 0:
 *
 *   0         treasury   funds the actors; exempt from the cap below, never deploys or tips
 *   1 - 12    actors     each sends at most MAX_TXS transactions, ever
 *
 * THE CAP. "At most five times per wallet" is enforced on chain: an actor's nonce is the number of
 * transactions it has sent, and an actor at MAX_TXS is never picked again. A USDT tip is two
 * transactions (approve, then tip), so it counts as two. When every actor is at the cap the
 * simulation is finished and `round` says so.
 *
 * STATELESS, as before: deployments are found from the factories' Deployed events filtered on the
 * actors, holdings from balanceOf and ownerOf. A round can run anywhere, any number of times.
 * ---------------------------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { ethers } = (() => {
  try { return require('ethers'); } catch { return require('../relayer/scripts/vendor/ethers-6.17.0.umd.min.js'); }
})();

const RPC_URL = process.env.BOHR_RPC_URL || 'https://rpc.bohr.life';
const SITE_URL = (process.env.UZO_SITE_URL || 'https://deploy.uzolabs.xyz').replace(/\/$/, '');
const CHAIN_ID = 968n;
const USDT = '0x75edC9335175Fc0552D51D48439F229c10420fe3'; // @uzolabs/sdk addresses[968].usdt

/** Receives 1% to 20% of the tokens the actors deploy. Given by the owner on 2026-11-09. */
const EXTERNAL = '0xe3e5D9f7eD994A6b5f697e60218a29F3Bf98B485';

const ACTORS = 12;
const MAX_TXS = 5;
const ACTOR_GAS = ethers.parseEther('0.3');
const ACTOR_GAS_FLOOR = ethers.parseEther('0.05');
const ACTOR_USDT = 15n * 10n ** 6n;
const LOG_WINDOW = 50_000n;

// Per round: how many actions, and how long to wait between them so they do not land together.
const ACTIONS_PER_ROUND = [2, 5];
const PAUSE_SECONDS = [30, 360];

const log = (...a) => console.log(...a);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const chance = (p) => Math.random() < p;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errMsg = (e) => e.shortMessage || e.reason || e.message || String(e);
const lower = (a) => a.toLowerCase();

const FACTORY_ABI = {
  token: ['function deploy(bytes32 userSalt, string name, string symbol, uint256 initialSupply, address recipient) returns (address)'],
  nft: ['function deploy(bytes32 userSalt, (string name, string symbol, string baseURI, uint256 maxSupply, address owner, address royaltyReceiver, uint96 royaltyBps) p) returns (address)'],
  tipJar: ['function deploy(bytes32 userSalt, address recipient, string title) returns (address)'],
};
const DEPLOYED_EVENT = 'event Deployed(address indexed deployer, address indexed instance, bytes32 indexed templateId, uint16 version)';
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
  'function burn(uint256)',
];
const NFT_ABI = [
  'function owner() view returns (address)',
  'function maxSupply() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function mint(address to) returns (uint256)',
  'function mintBatch(address to, uint256 quantity) returns (uint256)',
  'function setBaseURI(string)',
  'function freezeMetadata()',
  'function metadataFrozen() view returns (bool)',
  'function transferFrom(address from, address to, uint256 tokenId)',
];
const JAR_ABI = [
  'function tipNative(string message) payable',
  'function tipToken(uint256 amount, string message)',
  'function recipient() view returns (address)',
];
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
];

// Names are built from parts so no two deployments look copy-pasted.
const WORDS = ['Amber', 'Harbor', 'Kite', 'Lumen', 'Moss', 'Nova', 'Orbit', 'Pebble', 'Quill', 'Ridge', 'Sable', 'Tide', 'Vale', 'Wren', 'Zephyr', 'Cinder', 'Delta', 'Ember', 'Fable', 'Grove'];
const KINDS = ['Coin', 'Credits', 'Points', 'Token', 'Shares'];
const COLLECTIONS = ['Sketches', 'Badges', 'Tiles', 'Portraits', 'Glyphs', 'Postcards'];
const MESSAGES = ['thanks!', 'love this', 'keep building', 'gm', 'for the coffee', 'great work', 'testing the jar', ''];

// ------------------------------------------------------------------------------------- setup

function keys(provider) {
  const phrase = (process.env.SIM_MNEMONIC || '').trim();
  if (!phrase) throw new Error('SIM_MNEMONIC is not set.');
  const m = ethers.Mnemonic.fromPhrase(phrase);
  const at = (p) => ethers.HDNodeWallet.fromMnemonic(m, p).connect(provider ?? null);
  return {
    treasury: at(`m/44'/60'/1'/0/0`),
    actors: Array.from({ length: ACTORS }, (_, i) => at(`m/44'/60'/1'/0/${i + 1}`)),
    // The BotID simulation's treasury, whose remaining funds this one starts from.
    botidTreasury: at(`m/44'/60'/0'/0/0`),
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function uzoConfig() {
  const repo = arg('--uzo');
  if (!repo) throw new Error('pass --uzo <path to a uzo-deploy checkout>');
  const deployments = JSON.parse(fs.readFileSync(path.join(repo, 'config', 'deployments.json'), 'utf8'));
  const team = JSON.parse(fs.readFileSync(path.join(repo, 'config', 'team-addresses.json'), 'utf8'));
  const testnet = deployments.chains['968'];
  if (!testnet?.factories?.token) throw new Error('uzo-deploy has no testnet factories in config/deployments.json');
  return { factories: testnet.factories, team };
}

/** Refuse to act unless every sim wallet is on Uzo's team list for chain 968. */
function teamGate(team, k) {
  const listed = new Set(
    (team.addresses ?? []).filter((t) => (t.chains ?? []).includes(968)).map((t) => lower(t.address))
  );
  const missing = [k.treasury, ...k.actors].filter((w) => !listed.has(lower(w.address)));
  if (missing.length) {
    throw new Error(
      `${missing.length} sim wallet(s) are not on uzo-deploy's config/team-addresses.json for chain 968, ` +
      `so their activity would be counted as real users. Refusing to send anything. ` +
      `Run \`node tools/uzo-testnet-sim.js addresses\` for the entries to add. Missing: ${missing.map((w) => w.address).join(', ')}`
    );
  }
}

async function connect() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`refusing: ${RPC_URL} is chain ${net.chainId}, this script is Bohr testnet (968) only`);
  return provider;
}

async function send(label, fn) {
  try {
    const tx = await fn();
    const rc = await tx.wait();
    log(`  ${label}  tx ${rc.hash}`);
    return rc;
  } catch (e) {
    log(`  ! ${label} failed: ${errMsg(e)}`);
    return null;
  }
}

// ------------------------------------------------------------------------------- discovery

/** Every instance an actor deployed, by template, from the factories' Deployed events. */
async function findDeployments(provider, factories, actors) {
  const iface = new ethers.Interface([DEPLOYED_EVENT]);
  const topic0 = iface.getEvent('Deployed').topicHash;
  const byAddr = Object.fromEntries(Object.entries(factories).map(([kind, f]) => [lower(f.address), kind]));
  const from = BigInt(Math.min(...Object.values(factories).map((f) => f.deployBlock)));
  const head = BigInt(await provider.getBlockNumber());
  const deployers = actors.map((w) => ethers.zeroPadValue(w.address, 32));
  const out = { token: [], nft: [], tipJar: [] };
  for (let lo = from; lo <= head; lo += LOG_WINDOW) {
    const hi = lo + LOG_WINDOW - 1n < head ? lo + LOG_WINDOW - 1n : head;
    const logs = await provider.getLogs({
      address: Object.values(factories).map((f) => f.address),
      fromBlock: lo,
      toBlock: hi,
      topics: [topic0, deployers],
    });
    for (const l of logs) {
      const kind = byAddr[lower(l.address)];
      const ev = iface.parseLog(l);
      if (kind) out[kind].push({ address: ev.args.instance, deployer: ev.args.deployer });
    }
  }
  return out;
}

// --------------------------------------------------------------------------------- actions

const salt = () => ethers.hexlify(ethers.randomBytes(32));

async function verify(address, txHash) {
  try {
    const res = await fetch(`${SITE_URL}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: Number(CHAIN_ID), address, txHash }),
      signal: AbortSignal.timeout(70_000),
    });
    const body = await res.text();
    log(`    verify ${short(address)} → ${res.status} ${body.slice(0, 160)}`);
  } catch (e) {
    log(`    verify ${short(address)} → failed (${e.cause?.code || e.message})`);
  }
}

const instanceFrom = (rc) => {
  const iface = new ethers.Interface([DEPLOYED_EVENT]);
  for (const l of rc.logs) {
    try { return iface.parseLog(l).args.instance; } catch { /* not ours */ }
  }
  return null;
};

function buildActions(w, ctx, txsLeft) {
  const { k, deps, holdings } = ctx;
  const others = k.actors.filter((a) => a !== w);
  const acts = [];
  const add = (weight, name, run) => acts.push({ weight, name, run });

  add(2, 'deploy token', async () => {
    const name = `${pick(WORDS)} ${pick(KINDS)}`;
    const symbol = name.split(' ').map((p) => p.slice(0, 3)).join('').toUpperCase().slice(0, 6);
    const supply = BigInt(randInt(1, 999)) * 10n ** BigInt(randInt(3, 9)) * 10n ** 18n;
    const f = new ethers.Contract(ctx.factories.token.address, FACTORY_ABI.token, w);
    const rc = await send(`${short(w.address)} deploys token "${name}" (${symbol})`, () => f.deploy(salt(), name, symbol, supply, w.address));
    if (rc) await verify(instanceFrom(rc), rc.hash);
  });

  add(1.2, 'deploy NFT collection', async () => {
    const name = `${pick(WORDS)} ${pick(COLLECTIONS)}`;
    const royalty = chance(0.5);
    const p = {
      name,
      symbol: name.split(' ').map((x) => x[0]).join('').toUpperCase(),
      baseURI: `ipfs://sim-${Math.random().toString(36).slice(2, 10)}/`,
      maxSupply: BigInt(pick([50, 100, 250, 500, 1000])),
      owner: w.address,
      royaltyReceiver: royalty ? w.address : ethers.ZeroAddress,
      royaltyBps: royalty ? BigInt(randInt(1, 10) * 100) : 0n,
    };
    const f = new ethers.Contract(ctx.factories.nft.address, FACTORY_ABI.nft, w);
    const rc = await send(`${short(w.address)} deploys NFT collection "${name}"${royalty ? `, ${Number(p.royaltyBps) / 100}% royalty` : ''}`, () => f.deploy(salt(), p));
    if (rc) await verify(instanceFrom(rc), rc.hash);
  });

  add(1, 'deploy tip jar', async () => {
    const recipient = chance(0.6) ? w.address : pick(others).address;
    const title = `${pick(WORDS)}'s tip jar`;
    const f = new ethers.Contract(ctx.factories.tipJar.address, FACTORY_ABI.tipJar, w);
    const rc = await send(`${short(w.address)} deploys tip jar "${title}" for ${short(recipient)}`, () => f.deploy(salt(), recipient, title));
    if (rc) await verify(instanceFrom(rc), rc.hash);
  });

  const held = holdings.tokens.get(lower(w.address)) ?? [];
  if (held.length) {
    // Weighted up, because sending to the outside address is the owner's explicit ask.
    add(4, 'send tokens to the outside address', async () => {
      const t = pick(held);
      const pct = randInt(1, 20);
      const amount = (t.balance * BigInt(pct)) / 100n;
      const c = new ethers.Contract(t.address, TOKEN_ABI, w);
      await send(`${short(w.address)} sends ${pct}% of its ${t.symbol} to ${short(EXTERNAL)}`, () => c.transfer(EXTERNAL, amount));
    });
    add(1.5, 'send tokens to another actor', async () => {
      const t = pick(held);
      const to = pick(others);
      const pct = randInt(1, 20);
      const c = new ethers.Contract(t.address, TOKEN_ABI, w);
      await send(`${short(w.address)} sends ${pct}% of its ${t.symbol} to ${short(to.address)}`, () => c.transfer(to.address, (t.balance * BigInt(pct)) / 100n));
    });
    add(0.7, 'burn tokens', async () => {
      const t = pick(held);
      const pct = randInt(1, 10);
      const c = new ethers.Contract(t.address, TOKEN_ABI, w);
      await send(`${short(w.address)} burns ${pct}% of its ${t.symbol}`, () => c.burn((t.balance * BigInt(pct)) / 100n));
    });
  }

  const owned = holdings.collections.get(lower(w.address)) ?? [];
  const mintable = owned.filter((c) => c.minted < c.max);
  if (mintable.length) {
    add(2, 'mint NFTs', async () => {
      const col = pick(mintable);
      const c = new ethers.Contract(col.address, NFT_ABI, w);
      const to = chance(0.6) ? w.address : pick(others).address;
      const room = Number(col.max - col.minted);
      if (chance(0.5) && room > 1) {
        const q = Math.min(room, randInt(2, 10));
        await send(`${short(w.address)} batch-mints ${q} from ${short(col.address)} to ${short(to)}`, () => c.mintBatch(to, q));
      } else {
        await send(`${short(w.address)} mints 1 from ${short(col.address)} to ${short(to)}`, () => c.mint(to));
      }
    });
  }
  const unfrozen = owned.filter((c) => !c.frozen);
  if (unfrozen.length) {
    add(0.6, 'update NFT metadata', async () => {
      const col = pick(unfrozen);
      const c = new ethers.Contract(col.address, NFT_ABI, w);
      if (chance(0.3)) await send(`${short(w.address)} freezes metadata on ${short(col.address)}`, () => c.freezeMetadata());
      else await send(`${short(w.address)} updates base URI on ${short(col.address)}`, () => c.setBaseURI(`ipfs://sim-${Math.random().toString(36).slice(2, 10)}/`));
    });
  }
  const nfts = holdings.nfts.get(lower(w.address)) ?? [];
  if (nfts.length) {
    add(1, 'transfer an NFT', async () => {
      const n = pick(nfts);
      const to = pick(others);
      const c = new ethers.Contract(n.collection, NFT_ABI, w);
      await send(`${short(w.address)} sends NFT #${n.id} of ${short(n.collection)} to ${short(to.address)}`, () => c.transferFrom(w.address, to.address, n.id));
    });
  }

  const jars = deps.tipJar.filter((j) => lower(j.deployer) !== lower(w.address));
  if (jars.length) {
    add(1.5, 'tip in BOT', async () => {
      const j = pick(jars);
      const value = ethers.parseEther((rand(0.002, 0.03)).toFixed(4));
      const c = new ethers.Contract(j.address, JAR_ABI, w);
      const msg = pick(MESSAGES);
      await send(`${short(w.address)} tips ${ethers.formatEther(value)} BOT to jar ${short(j.address)}${msg ? ` "${msg}"` : ''}`, () => c.tipNative(msg, { value }));
    });
    if (txsLeft >= 2 && holdings.usdt.get(lower(w.address)) >= 10n ** 6n) {
      add(1.2, 'tip in USDT', async () => {
        const j = pick(jars);
        const amount = BigInt(randInt(1, 5)) * 10n ** 6n;
        const msg = pick(MESSAGES);
        const usdt = new ethers.Contract(USDT, ERC20, w);
        if (!(await send(`${short(w.address)} approves ${Number(amount) / 1e6} USDT for jar ${short(j.address)}`, () => usdt.approve(j.address, amount)))) return;
        const c = new ethers.Contract(j.address, JAR_ABI, w);
        await send(`${short(w.address)} tips ${Number(amount) / 1e6} USDT to jar ${short(j.address)}${msg ? ` "${msg}"` : ''}`, () => c.tipToken(amount, msg));
      });
    }
  }
  return acts;
}

function weighted(acts) {
  const total = acts.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of acts) if ((r -= a.weight) < 0) return a;
  return acts[acts.length - 1];
}

async function readHoldings(provider, k, deps) {
  const tokens = new Map();
  const collections = new Map();
  const nfts = new Map();
  const usdt = new Map();
  const usdtC = new ethers.Contract(USDT, ERC20, provider);
  for (const w of k.actors) {
    usdt.set(lower(w.address), await usdtC.balanceOf(w.address));
    const held = [];
    for (const t of deps.token) {
      const c = new ethers.Contract(t.address, TOKEN_ABI, provider);
      const balance = await c.balanceOf(w.address);
      if (balance > 0n) held.push({ address: t.address, balance, symbol: await c.symbol() });
    }
    tokens.set(lower(w.address), held);
  }
  for (const col of deps.nft) {
    const c = new ethers.Contract(col.address, NFT_ABI, provider);
    const [owner, max, minted] = await Promise.all([c.owner(), c.maxSupply(), c.totalMinted()]);
    const frozen = await c.metadataFrozen().catch(() => false);
    const list = collections.get(lower(owner)) ?? [];
    list.push({ address: col.address, max, minted, frozen });
    collections.set(lower(owner), list);
    // Token ids are probed rather than assumed to start at 0 or 1.
    for (let id = 0n; id <= minted && id <= 300n; id++) {
      const holder = await c.ownerOf(id).catch(() => null);
      if (!holder) continue;
      const l = nfts.get(lower(holder)) ?? [];
      l.push({ collection: col.address, id });
      nfts.set(lower(holder), l);
    }
  }
  return { tokens, collections, nfts, usdt };
}

async function touchSite(deps) {
  const paths = ['/api/stats?network=testnet', '/api/deployments?network=testnet', '/api/tips?network=testnet'];
  const all = [...deps.token, ...deps.nft, ...deps.tipJar];
  if (all.length) paths.push(`/manage/${pick(all).address}?network=testnet`);
  if (deps.tipJar.length) paths.push(`/tip/${pick(deps.tipJar).address}?network=testnet`);
  for (const p of paths) {
    try {
      const res = await fetch(SITE_URL + p, { signal: AbortSignal.timeout(20_000) });
      log(`  GET ${p} → ${res.status}`);
    } catch (e) {
      log(`  GET ${p} → failed (${e.cause?.code || e.message})`);
    }
  }
}

// -------------------------------------------------------------------------------- commands

async function fund(provider, k) {
  const usdt = new ethers.Contract(USDT, ERC20, provider);
  const t = k.treasury;

  // One-time move of whatever the BotID treasury has left. Plain transfers: no BotID contract is
  // called. Keeps a little BOT behind so the old wallet can still pay for a transfer later.
  const oldUsdt = await usdt.balanceOf(k.botidTreasury.address);
  if (oldUsdt > 0n) {
    await send(`BotID treasury → sim treasury ${Number(oldUsdt) / 1e6} USDT`, () => usdt.connect(k.botidTreasury).transfer(t.address, oldUsdt));
  }
  const keep = ethers.parseEther('0.05');
  const oldBot = await provider.getBalance(k.botidTreasury.address);
  if (oldBot > keep + ethers.parseEther('0.01')) {
    const value = oldBot - keep;
    await send(`BotID treasury → sim treasury ${ethers.formatEther(value)} BOT`, () => k.botidTreasury.sendTransaction({ to: t.address, value }));
  }

  for (const w of k.actors) {
    const bal = await provider.getBalance(w.address);
    if (bal < ACTOR_GAS_FLOOR) {
      await send(`gas → ${short(w.address)} ${ethers.formatEther(ACTOR_GAS - bal)} BOT`, () => t.sendTransaction({ to: w.address, value: ACTOR_GAS - bal }));
    }
    const ub = await usdt.balanceOf(w.address);
    const nonce = await provider.getTransactionCount(w.address);
    // Only actors with room for a USDT tip (two transactions) need USDT.
    if (ub < 10n ** 6n && nonce <= MAX_TXS - 2) {
      await send(`usdt → ${short(w.address)} ${Number(ACTOR_USDT) / 1e6} USDT`, () => usdt.connect(t).transfer(w.address, ACTOR_USDT));
    }
  }
}

async function round(provider, k, factories) {
  const counts = await Promise.all(k.actors.map((w) => provider.getTransactionCount(w.address)));
  const eligible = k.actors.filter((_, i) => counts[i] < MAX_TXS);
  log(`actors with room left: ${eligible.length} of ${ACTORS} (cap ${MAX_TXS} transactions each)`);
  if (!eligible.length) {
    log('every actor has reached its cap; the simulation is finished.');
    return;
  }
  const n = Math.min(randInt(...ACTIONS_PER_ROUND), eligible.length);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const s = randInt(...PAUSE_SECONDS);
      log(`  … waiting ${s}s`);
      await sleep(s);
    }
    // Re-read each time: the last action may have deployed something this one can use.
    const deps = await findDeployments(provider, factories, k.actors);
    const holdings = await readHoldings(provider, k, deps);
    const live = [];
    for (const w of k.actors) {
      const used = await provider.getTransactionCount(w.address);
      if (used < MAX_TXS && (await provider.getBalance(w.address)) >= ACTOR_GAS_FLOOR / 5n) live.push({ w, left: MAX_TXS - used });
    }
    if (!live.length) break;
    const { w, left } = pick(live);
    const action = weighted(buildActions(w, { k, deps, holdings, factories }, left));
    log(`\naction ${i + 1}/${n}: ${short(w.address)} (${left} tx left) → ${action.name}`);
    await action.run();
  }
  await touchSite(await findDeployments(provider, factories, k.actors));
}

async function status(provider, k, factories) {
  const usdt = new ethers.Contract(USDT, ERC20, provider);
  log(`treasury ${k.treasury.address}  ${ethers.formatEther(await provider.getBalance(k.treasury.address))} BOT  ${Number(await usdt.balanceOf(k.treasury.address)) / 1e6} USDT`);
  for (const w of k.actors) {
    const [n, b, u] = await Promise.all([provider.getTransactionCount(w.address), provider.getBalance(w.address), usdt.balanceOf(w.address)]);
    log(`  ${w.address}  ${n}/${MAX_TXS} tx  ${Number(ethers.formatEther(b)).toFixed(4)} BOT  ${Number(u) / 1e6} USDT`);
  }
  const deps = await findDeployments(provider, factories, k.actors);
  log(`deployments: ${deps.token.length} tokens, ${deps.nft.length} NFT collections, ${deps.tipJar.length} tip jars`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'addresses') {
    const k = keys();
    const entries = [
      { address: k.treasury.address, label: 'Testnet simulation treasury', chains: [968] },
      ...k.actors.map((w, i) => ({ address: w.address, label: `Testnet simulation ${i + 1}`, chains: [968] })),
    ];
    log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!['fund', 'round', 'status'].includes(cmd)) throw new Error('usage: addresses | fund | round | status  (--uzo <repo>)');
  const provider = await connect();
  const k = keys(provider);
  const { factories, team } = uzoConfig();
  if (cmd === 'status') return status(provider, k, factories);
  teamGate(team, k);
  if (cmd === 'fund') return fund(provider, k);
  return round(provider, k, factories);
}

main().catch((e) => {
  console.error(errMsg(e));
  process.exitCode = 1;
});
