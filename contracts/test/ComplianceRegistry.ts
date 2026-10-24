import { expect } from "chai";
import { ethers } from "hardhat";

// Status enum mirrors ComplianceRegistry.Status (Unknown = 0).
const Status = { Compliant: 1, AtRisk: 2, Breach: 3 } as const;
const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);
const POLICY = "0x" + "11".repeat(32);

describe("ComplianceRegistry v2", function () {
  async function deploy() {
    const [owner, reporter, forwarder, stranger] = await ethers.getSigners();
    const registry = await ethers.deployContract("ComplianceRegistry", [owner.address]);
    const token = await ethers.deployContract("TokenizedAsset", [
      "VeriLex Harbor Tower Note",
      "vHTN",
      "PROP-SG-001",
      "Commercial real-estate note, Harbor Tower, Singapore",
      "Singapore",
      ethers.parseUnits("1000000", 18),
      owner.address,
    ]);
    return { registry, token, owner, reporter, forwarder, stranger };
  }

  describe("access control", function () {
    it("rejects reports from accounts that are neither reporter nor owner", async function () {
      const { registry, token, stranger } = await deploy();
      await expect(
        registry.connect(stranger).submitReport(await token.getAddress(), 10250, Status.Compliant, 97, HASH_A, POLICY)
      ).to.be.revertedWith("not reporter");
    });

    it("rejects zero addresses and out-of-range input", async function () {
      const { registry, token } = await deploy();
      await expect(registry.setReporter(ethers.ZeroAddress)).to.be.revertedWith("zero reporter");
      await expect(registry.setForwarder(ethers.ZeroAddress)).to.be.revertedWith("zero forwarder");
      const addr = await token.getAddress();
      await expect(registry.submitReport(addr, 10000, 0, 50, HASH_A, POLICY)).to.be.revertedWith("unknown status");
      await expect(registry.submitReport(addr, 10000, Status.Compliant, 101, HASH_A, POLICY)).to.be.revertedWith(
        "score out of range"
      );
      await expect(
        registry.submitReport(ethers.ZeroAddress, 10000, Status.Compliant, 50, HASH_A, POLICY)
      ).to.be.revertedWith("zero token");
    });
  });

  describe("onReport (CRE delivery path)", function () {
    function encodeReport(token: string, ratio: number, status: number, score: number, hash: string) {
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint8", "uint256", "bytes32", "bytes32"],
        [token, ratio, status, score, hash, POLICY]
      );
    }

    it("fails closed before a forwarder is configured, even for the owner", async function () {
      const { registry, token, owner } = await deploy();
      const payload = encodeReport(await token.getAddress(), 10250, Status.Compliant, 97, HASH_A);
      await expect(registry.connect(owner).onReport("0x", payload)).to.be.revertedWith("not forwarder");
    });

    it("accepts reports from the configured forwarder only, with score and policy", async function () {
      const { registry, token, forwarder, stranger } = await deploy();
      await registry.setForwarder(forwarder.address);
      const payload = encodeReport(await token.getAddress(), 9720, Status.AtRisk, 68, HASH_B);
      await expect(registry.connect(stranger).onReport("0x", payload)).to.be.revertedWith("not forwarder");
      await registry.connect(forwarder).onReport("0x", payload);
      const latest = await registry.latestReport(await token.getAddress());
      expect(latest.status).to.equal(Status.AtRisk);
      expect(latest.reserveRatioBps).to.equal(9720);
      expect(latest.score).to.equal(68);
      expect(latest.policyHash).to.equal(POLICY);
      expect(latest.reporter).to.equal(forwarder.address);
    });
  });

  describe("portfolio bookkeeping", function () {
    it("registers each asset once, in first-seen order", async function () {
      const { registry, token, owner } = await deploy();
      const token2 = await ethers.deployContract("TokenizedAsset", [
        "VeriLex BlueCarbon Pool",
        "vBCP",
        "CARB-PA-002",
        "Blue carbon credits, Panama",
        "Panama",
        ethers.parseUnits("500000", 18),
        owner.address,
      ]);
      const a1 = await token.getAddress();
      const a2 = await token2.getAddress();
      await registry.submitReport(a1, 10250, Status.Compliant, 97, HASH_A, POLICY);
      await registry.submitReport(a2, 8815, Status.Breach, 31, HASH_B, POLICY);
      await registry.submitReport(a1, 9900, Status.AtRisk, 74, HASH_A, POLICY);
      expect(await registry.assetCount()).to.equal(2);
      expect(await registry.assets(0)).to.equal(a1);
      expect(await registry.assets(1)).to.equal(a2);
      expect(await registry.latestStatus(a2)).to.equal(Status.Breach);
    });

    it("invariant: N reports produce exactly N immutable history entries with matching scores", async function () {
      const { registry, token } = await deploy();
      const addr = await token.getAddress();
      let seed = 7;
      const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
      const inputs: { ratio: number; status: number; score: number }[] = [];
      for (let i = 0; i < 25; i++) {
        const ratio = 8000 + (next() % 5000);
        const status = ratio >= 10000 ? Status.Compliant : ratio >= 9500 ? Status.AtRisk : Status.Breach;
        const score = next() % 101;
        inputs.push({ ratio, status, score });
        await registry.submitReport(addr, ratio, status, score, HASH_A, POLICY);
      }
      expect(await registry.reportCount(addr)).to.equal(inputs.length);
      for (let i = 0; i < inputs.length; i++) {
        const r = await registry.reportAt(addr, i);
        expect(r.reserveRatioBps).to.equal(inputs[i].ratio);
        expect(r.status).to.equal(inputs[i].status);
        expect(r.score).to.equal(inputs[i].score);
      }
    });
  });
});
