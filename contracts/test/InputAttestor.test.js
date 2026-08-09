const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployProtocol, buildBundle, fundedWallet, now, coder, signDigest, feedDigest } = require("./helpers");

describe("InputAttestor", function () {
  let env, attestor, chainId, ts;

  beforeEach(async function () {
    env = await deployProtocol();
    attestor = env.attestor;
    chainId = env.chainId;
    ts = await now();
  });

  const feed = (ts, value = "px-1") => ({
    feedId: ethers.id("BOT/USD"),
    valueHash: ethers.id(value),
    timestamp: ts,
  });

  it("accepts a quorum-signed, fresh bundle matching the commitment", async function () {
    const { bundle, commitment } = buildBundle(chainId, attestor.target, [feed(ts)], [env.publisher]);
    expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(true);
  });

  it("rejects a bundle that does not hash to the committed value", async function () {
    // The core attack: the agent runs on data of its own choosing and proves it flawlessly.
    const honest = buildBundle(chainId, attestor.target, [feed(ts, "real")], [env.publisher]);
    const forged = buildBundle(chainId, attestor.target, [feed(ts, "fake")], [env.publisher]);

    expect(await attestor.verifyInputs(honest.commitment, forged.bundle, ts)).to.equal(false);
  });

  it("rejects readings signed by a non-publisher", async function () {
    const impostor = await fundedWallet(env.owner, "1");
    const { bundle, commitment } = buildBundle(chainId, attestor.target, [feed(ts)], [impostor]);
    expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(false);
  });

  it("rejects stale readings", async function () {
    const { bundle, commitment } = buildBundle(
      chainId,
      attestor.target,
      [feed(ts - 6 * 60)],
      [env.publisher]
    );
    expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(false);
  });

  it("rejects readings from the future", async function () {
    const { bundle, commitment } = buildBundle(chainId, attestor.target, [feed(ts + 60)], [env.publisher]);
    expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(false);
  });

  it("rejects an empty bundle", async function () {
    const empty = coder.encode(["tuple(bytes32,bytes32,uint64,bytes[])[]"], [[]]);
    expect(await attestor.verifyInputs(ethers.ZeroHash, empty, ts)).to.equal(false);
  });

  it("rejects malformed signatures without reverting", async function () {
    const f = feed(ts);
    const encoded = [[f.feedId, f.valueHash, f.timestamp, ["0x1234"]]];
    const bundle = coder.encode(["tuple(bytes32,bytes32,uint64,bytes[])[]"], [encoded]);
    const commitment = ethers.keccak256(
      coder.encode(["bytes32[]"], [[feedDigest(chainId, attestor.target, f)]])
    );
    expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(false);
  });

  describe("quorum", function () {
    let p2, p3;

    beforeEach(async function () {
      p2 = await fundedWallet(env.owner, "1");
      p3 = await fundedWallet(env.owner, "1");
      await attestor.setPublisher(p2.address, true);
      await attestor.setPublisher(p3.address, true);
      await attestor.setQuorum(2, 5 * 60);
    });

    it("accepts two distinct publishers", async function () {
      const { bundle, commitment } = buildBundle(chainId, attestor.target, [feed(ts)], [env.publisher, p2]);
      expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(true);
    });

    it("rejects a single publisher below quorum", async function () {
      const { bundle, commitment } = buildBundle(chainId, attestor.target, [feed(ts)], [env.publisher]);
      expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(false);
    });

    it("rejects one publisher signing twice to fake a quorum", async function () {
      const f = feed(ts);
      const digest = feedDigest(chainId, attestor.target, f);
      const sig = signDigest(env.publisher, digest);
      const bundle = coder.encode(
        ["tuple(bytes32,bytes32,uint64,bytes[])[]"],
        [[[f.feedId, f.valueHash, f.timestamp, [sig, sig]]]]
      );
      const commitment = ethers.keccak256(coder.encode(["bytes32[]"], [[digest]]));

      expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(false);
    });

    it("requires quorum on every feed in the bundle, not just the first", async function () {
      const f1 = feed(ts, "a");
      const f2 = feed(ts, "b");
      const d1 = feedDigest(chainId, attestor.target, f1);
      const d2 = feedDigest(chainId, attestor.target, f2);
      const sorted = [env.publisher, p2].sort((a, b) =>
        a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
      );

      const bundle = coder.encode(
        ["tuple(bytes32,bytes32,uint64,bytes[])[]"],
        [
          [
            [f1.feedId, f1.valueHash, f1.timestamp, sorted.map((p) => signDigest(p, d1))],
            [f2.feedId, f2.valueHash, f2.timestamp, [signDigest(sorted[0], d2)]], // short
          ],
        ]
      );
      const commitment = ethers.keccak256(coder.encode(["bytes32[]"], [[d1, d2]]));

      expect(await attestor.verifyInputs(commitment, bundle, ts)).to.equal(false);
    });

    it("cannot set a quorum larger than the publisher set", async function () {
      await expect(attestor.setQuorum(99, 300)).to.be.revertedWithCustomError(
        attestor,
        "InvalidParameter"
      );
    });
  });

  it("binds the commitment to this attestor and chain", async function () {
    // A bundle committed against a different attestor address must not verify here.
    const other = await (await ethers.getContractFactory("InputAttestor")).deploy(env.owner.address);
    const { bundle } = buildBundle(chainId, attestor.target, [feed(ts)], [env.publisher]);
    const foreign = buildBundle(chainId, other.target, [feed(ts)], [env.publisher]);

    expect(await attestor.verifyInputs(foreign.commitment, bundle, ts)).to.equal(false);
  });
});
