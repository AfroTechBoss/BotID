const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  Tier,
  deployProtocol,
  fundedWallet,
  signDigest,
  executionDigest,
  buildBundle,
  BN254_P,
  SCALE_BITS,
  toField,
  revealsFor,
  commitOutputs,
  zkInstances,
  zkAttestation,
  teeAttestation,
  increaseTime,
  now,
  coder,
} = require("./helpers");

const DAY = 24 * 60 * 60;

function makeCtx(operator, overrides = {}) {
  return {
    requestId: ethers.id("req-1"),
    agentId: 1n,
    modelCommitment: ethers.id("model-v1"),
    inputCommitment: ethers.id("inputs-1"),
    outputCommitment: ethers.id("output-1"),
    deliverBy: 2_000_000_000n,
    operator,
    ...overrides,
  };
}

describe("Verification adapters", function () {
  let env, chainId;

  beforeEach(async function () {
    env = await deployProtocol();
    chainId = env.chainId;
  });

  describe("SignatureAdapter (Bronze)", function () {
    let operator, adapter;

    beforeEach(async function () {
      operator = await fundedWallet(env.owner, "1");
      adapter = env.sigAdapter;
    });

    it("reports its tier", async function () {
      expect(await adapter.tier()).to.equal(Tier.Bronze);
    });

    it("accepts a signature from the agent's operator", async function () {
      const ctx = makeCtx(operator.address);
      const sig = signDigest(operator, executionDigest(chainId, adapter.target, ctx));
      expect(await adapter.verify(ctx, sig)).to.equal(true);
    });

    it("rejects a signature from anyone else", async function () {
      const impostor = await fundedWallet(env.owner, "1");
      const ctx = makeCtx(operator.address);
      const sig = signDigest(impostor, executionDigest(chainId, adapter.target, ctx));
      expect(await adapter.verify(ctx, sig)).to.equal(false);
    });

    // Each of these is a distinct attack the v0 contract was open to.
    const mutations = {
      "a different request (replay)": { requestId: ethers.id("req-2") },
      "a different agent": { agentId: 2n },
      "a swapped model": { modelCommitment: ethers.id("model-v2") },
      "different inputs": { inputCommitment: ethers.id("inputs-2") },
      "a different output": { outputCommitment: ethers.id("output-2") },
      "a different deadline": { deliverBy: 2_000_000_001n },
    };

    for (const [label, mutation] of Object.entries(mutations)) {
      it(`rejects an attestation reused for ${label}`, async function () {
        const signed = makeCtx(operator.address);
        const sig = signDigest(operator, executionDigest(chainId, adapter.target, signed));
        const presented = makeCtx(operator.address, mutation);
        expect(await adapter.verify(presented, sig)).to.equal(false);
      });
    }

    it("rejects malformed and malleable signatures", async function () {
      const ctx = makeCtx(operator.address);
      expect(await adapter.verify(ctx, "0x")).to.equal(false);
      expect(await adapter.verify(ctx, "0x" + "11".repeat(65))).to.equal(false);

      // Flip s into the upper half of the curve order — the classic malleable twin. Assembled
      // by hand because ethers refuses to represent a non-canonical signature.
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const digest = executionDigest(chainId, adapter.target, ctx);
      const sig = ethers.Signature.from(signDigest(operator, digest));
      const twin = ethers.concat([
        sig.r,
        ethers.toBeHex(N - BigInt(sig.s), 32),
        sig.v === 27 ? "0x1c" : "0x1b",
      ]);

      expect(await adapter.verify(ctx, twin)).to.equal(false);
    });
  });

  describe("TeeAdapter (Silver)", function () {
    let enclave, measurement, adapter;

    beforeEach(async function () {
      adapter = env.teeAdapter;
      enclave = await fundedWallet(env.owner, "1");
      measurement = ethers.id("pcr0-build-abc");

      await adapter.setNotary(env.owner.address, true);
      await adapter.setMeasurement(measurement, true);
      await adapter.enroll(enclave.address, measurement, (await now()) + 6 * DAY);
    });

    const teeSign = (ctx, wallet, m) =>
      teeAttestation(
        wallet.address,
        signDigest(
          wallet,
          ethers.keccak256(
            coder.encode(
              ["bytes32", "bytes32"],
              [executionDigest(env.chainId, env.teeAdapter.target, ctx), m]
            )
          )
        )
      );

    it("accepts a signature from an enrolled enclave", async function () {
      const ctx = makeCtx(env.other.address);
      expect(await adapter.verify(ctx, teeSign(ctx, enclave, measurement))).to.equal(true);
    });

    it("rejects an unenrolled key", async function () {
      const rogue = await fundedWallet(env.owner, "1");
      const ctx = makeCtx(env.other.address);
      expect(await adapter.verify(ctx, teeSign(ctx, rogue, measurement))).to.equal(false);
    });

    it("rejects after revocation", async function () {
      const ctx = makeCtx(env.other.address);
      await adapter.revoke(enclave.address);
      expect(await adapter.verify(ctx, teeSign(ctx, enclave, measurement))).to.equal(false);
    });

    it("rejects once the enrolment expires", async function () {
      const ctx = makeCtx(env.other.address);
      await increaseTime(7 * DAY);
      expect(await adapter.verify(ctx, teeSign(ctx, enclave, measurement))).to.equal(false);
    });

    it("rejects an enrolment once its measurement is delisted", async function () {
      const ctx = makeCtx(env.other.address);
      await adapter.setMeasurement(measurement, false);
      expect(await adapter.verify(ctx, teeSign(ctx, enclave, measurement))).to.equal(false);
    });

    it("caps enrolment lifetime", async function () {
      const other = await fundedWallet(env.owner, "1");
      await expect(
        adapter.enroll(other.address, measurement, (await now()) + 30 * DAY)
      ).to.be.revertedWithCustomError(adapter, "InvalidParameter");
    });

    it("refuses to enroll against a measurement that is not allowlisted", async function () {
      const other = await fundedWallet(env.owner, "1");
      await expect(
        adapter.enroll(other.address, ethers.id("unknown-build"), (await now()) + DAY)
      ).to.be.revertedWithCustomError(adapter, "InvalidParameter");
    });

    it("only notaries may enroll or revoke", async function () {
      await expect(
        adapter.connect(env.other).revoke(enclave.address)
      ).to.be.revertedWithCustomError(adapter, "NotNotary");
    });
  });

  describe("ZkAdapter (Gold)", function () {
    const TS = 1_700_000_000;
    let adapter, feeds, reveals, outputs, ctx;

    /** Encode an attestation whose instance vector is not the one the reveals imply. */
    function tampered(reveals, instances, proof = "0xdeadbeef") {
      return coder.encode(
        ["bytes", "uint256[]", "tuple(bytes32,uint64,int256,bytes32)[]"],
        [proof, instances, reveals.map((r) => [r.feedId, r.timestamp, r.value, r.salt])]
      );
    }

    function priced(values) {
      return values.map((value, i) => ({
        feedId: ethers.id(`feed-${i}`),
        timestamp: TS,
        value,
        salt: ethers.id(`salt-${i}`),
      }));
    }

    beforeEach(async function () {
      adapter = env.zkAdapter;

      // Prices quantised at the model's declared input scale — two decimals here. The third
      // is negative on purpose: a funding rate or a spread is a perfectly ordinary input, and
      // negatives are where the field encoding earns its keep.
      feeds = priced([12_500n, 340_000n, -42n]);
      reveals = revealsFor(feeds);
      outputs = [3300n, 6700n, -12n];

      const { commitment } = buildBundle(chainId, env.attestor.target, feeds, [env.publisher]);
      ctx = makeCtx(env.other.address, {
        inputCommitment: commitment,
        outputCommitment: commitOutputs(outputs),
      });
      await adapter.setVerifier(ctx.modelCommitment, env.verifier.target, SCALE_BITS);
    });

    it("accepts a proof whose instances open to the committed inputs and outputs", async function () {
      expect(await adapter.verify(ctx, zkAttestation(reveals, outputs))).to.equal(true);
    });

    it("re-derives the consumer's input commitment from the revealed values", async function () {
      // The adapter and the attestor must agree byte for byte, or every honest Gold proof
      // fails closed. Delegating to the attestor is what makes that structural.
      expect(await adapter.inputCommitmentFor(reveals)).to.equal(ctx.inputCommitment);
    });

    it("exposes the input instances a circuit must publish", async function () {
      const expected = await adapter.expectedInputInstances(ctx.modelCommitment, reveals);
      expect(expected.map(String)).to.deep.equal(
        reveals.map((r) => toField(r.value, SCALE_BITS)).map(String)
      );
    });

    it("maps a negative reading onto the field the way ezkl does", async function () {
      const expected = await adapter.expectedInputInstances(ctx.modelCommitment, reveals);
      expect(expected[2]).to.equal(BN254_P - (42n << BigInt(SCALE_BITS)));
    });

    it("quantises input cells by the shift the model was registered with", async function () {
      // The instance cell is `value << inputScaleBits`, not the value. A model registered at a
      // different scale is a different circuit, and its proofs must not be accepted here.
      const expected = await adapter.expectedInputInstances(ctx.modelCommitment, reveals);
      expect(expected[0]).to.equal(12_500n << BigInt(SCALE_BITS));
    });

    it("rejects a proof quantised at a scale other than the registered one", async function () {
      // The failure mode this guards is silent, not adversarial: ship a circuit compiled at a
      // different `input_scale` and every honest proof would otherwise carry cells the adapter
      // has no way to recognise.
      expect(
        await adapter.verify(ctx, zkAttestation(reveals, outputs, "0xdeadbeef", SCALE_BITS + 1))
      ).to.equal(false);
    });

    it("rejects inputs the agent chose for itself", async function () {
      // The garbage-in attack at Gold: a flawless proof over a fabricated price. The reveals
      // no longer reproduce the commitment the *consumer* put in the request.
      const invented = priced([12_500n, 340_000n, 999n]);
      expect(
        await adapter.verify(ctx, zkAttestation(revealsFor(invented), outputs))
      ).to.equal(false);
    });

    it("rejects a proof whose input cells disagree with the values it reveals", async function () {
      // Reveals that hash correctly, paired with a circuit run on something else entirely.
      const instances = zkInstances(reveals, outputs);
      instances[1] += 1n;
      expect(await adapter.verify(ctx, tampered(reveals, instances))).to.equal(false);
    });

    it("rejects a correct proof paired with a more flattering result", async function () {
      const flattering = [10_000n, 0n, 0n];
      expect(await adapter.verify(ctx, zkAttestation(reveals, flattering))).to.equal(false);
    });

    it("rejects a reordered bundle", async function () {
      // Order is significant in the commitment, so a permuted input vector is a different
      // execution even though every individual reading still verifies.
      const swapped = [reveals[1], reveals[0], reveals[2]];
      expect(await adapter.verify(ctx, zkAttestation(swapped, outputs))).to.equal(false);
    });

    it("rejects a value large enough to alias onto another field element", async function () {
      // `P - 42` is a legitimate encoding of -42. A reveal of the literal integer `P - 42`
      // would produce the same instance cell, so out-of-range magnitudes are refused before
      // they are reduced.
      const huge = priced([1n << 128n, 2n, 3n]);
      const { commitment } = buildBundle(chainId, env.attestor.target, huge, [env.publisher]);
      const aliased = makeCtx(env.other.address, {
        inputCommitment: commitment,
        outputCommitment: commitOutputs(outputs),
      });
      expect(
        await adapter.verify(aliased, zkAttestation(revealsFor(huge), outputs))
      ).to.equal(false);
      await expect(
        adapter.expectedInputInstances(aliased.modelCommitment, revealsFor(huge))
      ).to.be.revertedWithCustomError(adapter, "InvalidParameter");
    });

    it("rejects an empty reveal set", async function () {
      // A circuit with no inputs proves nothing about the request it is attached to.
      expect(await adapter.verify(ctx, zkAttestation([], outputs))).to.equal(false);
    });

    it("rejects an instance vector with no output cells", async function () {
      expect(await adapter.verify(ctx, zkAttestation(reveals, []))).to.equal(false);
    });

    it("rejects when no verifier is registered for the model", async function () {
      const unknown = makeCtx(env.other.address, {
        modelCommitment: ethers.id("model-v2"),
        inputCommitment: ctx.inputCommitment,
        outputCommitment: ctx.outputCommitment,
      });
      expect(await adapter.verify(unknown, zkAttestation(reveals, outputs))).to.equal(false);
    });

    it("returns false when the verifier rejects", async function () {
      await env.verifier.setResult(false);
      expect(await adapter.verify(ctx, zkAttestation(reveals, outputs))).to.equal(false);
    });

    it("surfaces a reverting verifier as false rather than bubbling up", async function () {
      await env.verifier.setShouldRevert(true);
      expect(await adapter.verify(ctx, zkAttestation(reveals, outputs))).to.equal(false);
    });

    it("only the owner may bind a verifier or repoint the attestor", async function () {
      await expect(
        adapter.connect(env.other).setVerifier(ethers.id("m"), env.verifier.target, SCALE_BITS)
      ).to.be.revertedWithCustomError(adapter, "NotOwner");
      await expect(
        adapter.connect(env.other).setInputAttestor(env.attestor.target)
      ).to.be.revertedWithCustomError(adapter, "NotOwner");
    });

    it("refuses a shift large enough to make the quantisation overflow", async function () {
      await expect(
        adapter.setVerifier(ethers.id("m"), env.verifier.target, 65)
      ).to.be.revertedWithCustomError(adapter, "InvalidParameter");
    });
  });
});
