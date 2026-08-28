const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  domain,
  EXECUTION_TYPEHASH,
  FEED_TYPEHASH,
  EXECUTION_TYPES,
  FEED_TYPES,
  executionDigest,
  feedDigest,
  signDigest,
  buildBundle,
  deployProtocol,
  registerAgent,
  E18,
  now,
} = require("./helpers");

/**
 * Everything the `\x19\x01` envelope is supposed to buy, asserted rather than assumed.
 *
 * The rest of the suite goes through `helpers.js`, which means it proves the contracts agree with
 * `ethers.TypedDataEncoder` — necessary but not sufficient. Two things could still be true and
 * nowhere tested: the field lists could have drifted from the strings the contracts hash, and a
 * wallet asked to sign the *rendered* message could produce different bytes from a wallet asked to
 * sign the digest. This file closes both.
 */
describe("EIP-712", () => {
  let env;

  beforeEach(async () => {
    env = await deployProtocol();
  });

  const probe = (overrides = {}) => ({
    requestId: ethers.id("probe/request"),
    agentId: 1n,
    modelCommitment: ethers.id("probe/model"),
    inputCommitment: ethers.id("probe/input"),
    outputCommitment: ethers.id("probe/output"),
    deliverBy: 1234n,
    operator: "0x000000000000000000000000000000000000dEaD",
    ...overrides,
  });

  describe("type strings", () => {
    /**
     * The typehashes are constants in Solidity and derived from field lists in JavaScript. That
     * asymmetry is deliberate — it is what makes the mirror independent — and it means a drift in
     * either direction has to be caught here or not at all.
     */
    it("derives the same Execution typehash the contracts hash", async () => {
      const encoded = ethers.TypedDataEncoder.from(EXECUTION_TYPES).encodeType("Execution");
      expect(encoded).to.equal(
        "Execution(bytes32 requestId,uint256 agentId,bytes32 modelCommitment," +
          "bytes32 inputCommitment,bytes32 outputCommitment,uint64 deliverBy)"
      );
      expect(ethers.keccak256(ethers.toUtf8Bytes(encoded))).to.equal(EXECUTION_TYPEHASH);
    });

    it("derives the FeedReading typehash the attestor declares", async () => {
      const encoded = ethers.TypedDataEncoder.from(FEED_TYPES).encodeType("FeedReading");
      expect(encoded).to.equal(
        "FeedReading(bytes32 feedId,bytes32 valueHash,uint64 timestamp)"
      );
      expect(ethers.keccak256(ethers.toUtf8Bytes(encoded))).to.equal(FEED_TYPEHASH);
      expect(await env.attestor.FEED_TYPEHASH()).to.equal(FEED_TYPEHASH);
    });
  });

  describe("domain", () => {
    /**
     * `Digest` stores the name and version pre-hashed; `eip712Domain()` returns them as strings.
     * Nothing in the compiler ties the two together, so `keccak256("BotID")` and the literal
     * `"BotID"` could drift apart and every signature would still verify — against a domain no
     * tool could reconstruct. Rebuilding the separator from what ERC-5267 advertises is the only
     * check that they still describe the same domain.
     */
    for (const name of ["attestor", "sigAdapter", "teeAdapter"]) {
      it(`${name} advertises a domain that rebuilds its own separator`, async () => {
        const contract = env[name];
        const [fields, dName, dVersion, chainId, verifying, salt, extensions] =
          await contract.eip712Domain();

        expect(fields).to.equal("0x0f");
        expect(dName).to.equal(DOMAIN_NAME);
        expect(dVersion).to.equal(DOMAIN_VERSION);
        expect(chainId).to.equal(env.chainId);
        expect(verifying).to.equal(contract.target);
        expect(salt).to.equal(ethers.ZeroHash);
        expect(extensions).to.deep.equal([]);

        const rebuilt = ethers.TypedDataEncoder.hashDomain({
          name: dName,
          version: dVersion,
          chainId,
          verifyingContract: verifying,
        });
        expect(await contract.DOMAIN_SEPARATOR()).to.equal(rebuilt);
        expect(rebuilt).to.equal(
          ethers.TypedDataEncoder.hashDomain(domain(env.chainId, contract.target))
        );
      });
    }

    /** The verifying contract is in the domain now, not the struct. It still binds. */
    it("gives each adapter a different separator for the same message", async () => {
      const sig = await env.sigAdapter.DOMAIN_SEPARATOR();
      const tee = await env.teeAdapter.DOMAIN_SEPARATOR();
      expect(sig).to.not.equal(tee);

      const ctx = probe();
      expect(await env.sigAdapter.executionDigest(ctx)).to.not.equal(
        await env.teeAdapter.executionDigest(ctx)
      );
    });
  });

  describe("digests", () => {
    it("matches the off-chain execution mirror at every adapter", async () => {
      const ctx = probe();
      for (const name of ["sigAdapter", "teeAdapter"]) {
        expect(await env[name].executionDigest(ctx)).to.equal(
          executionDigest(env.chainId, env[name].target, ctx)
        );
      }
    });

    it("matches the off-chain feed mirror", async () => {
      const feed = {
        feedId: ethers.id("probe/feed"),
        valueHash: ethers.id("probe/value"),
        timestamp: 99n,
      };
      expect(
        await env.attestor.feedDigest(feed.feedId, feed.valueHash, feed.timestamp)
      ).to.equal(feedDigest(env.chainId, env.attestor.target, feed));
    });

    /** Every field is in the struct hash, so changing any one of them changes the digest. */
    it("changes when any signed field changes", async () => {
      const base = await env.sigAdapter.executionDigest(probe());
      const variants = {
        requestId: ethers.id("other/request"),
        agentId: 2n,
        modelCommitment: ethers.id("other/model"),
        inputCommitment: ethers.id("other/input"),
        outputCommitment: ethers.id("other/output"),
        deliverBy: 1235n,
      };
      for (const [field, value] of Object.entries(variants)) {
        expect(
          await env.sigAdapter.executionDigest(probe({ [field]: value })),
          `${field} is not bound`
        ).to.not.equal(base);
      }
    });

    /**
     * `operator` is the one context field outside the signed struct, and deliberately so: the
     * adapter recovers a signer and compares it to `ctx.operator`, so signing it would be asking
     * the key to attest to its own identity. Recording it here keeps the omission a decision.
     */
    it("does not sign the operator, which the adapter compares instead", async () => {
      const base = await env.sigAdapter.executionDigest(probe());
      const other = await env.sigAdapter.executionDigest(
        probe({ operator: "0x000000000000000000000000000000000000bEEF" })
      );
      expect(other).to.equal(base);
    });
  });

  describe("signing", () => {
    /**
     * The claim the whole change rests on: a hardware wallet shown a rendered `Execution` and a
     * hot key handed the digest produce identical bytes. If this failed, the envelope would be
     * cosmetic — operators could see what they were approving, but only by signing something the
     * adapter would reject.
     */
    it("signTypedData over the message equals signDigest over the digest", async () => {
      const wallet = ethers.Wallet.createRandom();
      const ctx = probe({ operator: wallet.address });

      const typed = await wallet.signTypedData(
        domain(env.chainId, env.sigAdapter.target),
        EXECUTION_TYPES,
        {
          requestId: ctx.requestId,
          agentId: ctx.agentId,
          modelCommitment: ctx.modelCommitment,
          inputCommitment: ctx.inputCommitment,
          outputCommitment: ctx.outputCommitment,
          deliverBy: ctx.deliverBy,
        }
      );

      const raw = signDigest(wallet, await env.sigAdapter.executionDigest(ctx));
      expect(typed).to.equal(raw);
      expect(await env.sigAdapter.verify(ctx, typed)).to.equal(true);
    });

    it("accepts a feed reading signed as typed data", async () => {
      const feed = {
        feedId: ethers.id("probe/feed"),
        valueHash: ethers.id("probe/value"),
        timestamp: BigInt(await now()),
      };
      const typed = await env.publisher.signTypedData(
        domain(env.chainId, env.attestor.target),
        FEED_TYPES,
        feed
      );
      const raw = signDigest(env.publisher, feedDigest(env.chainId, env.attestor.target, feed));
      expect(typed).to.equal(raw);
    });

    /**
     * The envelope earns its keep here. A signature made for the Bronze adapter used to be a
     * signature over a hash that named its verifier inside the struct; it now names it in the
     * domain. Either way it must not travel — this asserts the property survived the move.
     */
    it("does not let a Bronze signature verify at the TEE adapter's domain", async () => {
      const wallet = ethers.Wallet.createRandom();
      const ctx = probe({ operator: wallet.address });
      const sig = signDigest(wallet, await env.sigAdapter.executionDigest(ctx));

      expect(await env.sigAdapter.verify(ctx, sig)).to.equal(true);
      // Same bytes, different domain: recovery yields a stranger, not the operator.
      const recovered = ethers.recoverAddress(await env.teeAdapter.executionDigest(ctx), sig);
      expect(recovered).to.not.equal(wallet.address);
    });

    /** End to end: the real delivery path, with a signature made the way a wallet would make it. */
    it("delivers an execution signed as typed data", async () => {
      const { agentId, operator, model } = await registerAgent(env);

      const ts = await now();
      const feeds = [
        {
          feedId: ethers.id("BOT/USD"),
          value: 12_500n,
          salt: ethers.id("salt/eip712"),
          timestamp: ts,
        },
      ];
      const { bundle, commitment } = buildBundle(env.chainId, env.attestor.target, feeds, [
        env.publisher,
      ]);

      const deliverBy = ts + 3600;
      const notional = E18(100_000);
      const fee = (notional * (await env.router.minFeeBps())) / 10_000n;

      const receipt = await (
        await env.router
          .connect(env.consumer)
          .requestExecution(agentId, commitment, notional, fee, deliverBy, "")
      ).wait();
      const requestId = receipt.logs
        .map((l) => {
          try {
            return env.router.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "ExecutionRequested").args.requestId;

      const outputCommitment = ethers.id("output/probe");
      const attestation = await operator.signTypedData(
        domain(env.chainId, env.sigAdapter.target),
        EXECUTION_TYPES,
        {
          requestId,
          agentId,
          modelCommitment: model,
          inputCommitment: commitment,
          outputCommitment,
          deliverBy,
        }
      );

      await expect(
        env.router.connect(operator).deliver(requestId, outputCommitment, bundle, attestation)
      ).to.emit(env.router, "ExecutionDelivered");
    });
  });
});
