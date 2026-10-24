import { expect } from "chai";
import { ethers } from "hardhat";

// Status enum mirrors ComplianceRegistry.Status (Unknown = 0).
const Status = { Compliant: 1, AtRisk: 2, Breach: 3 } as const;
const HASH_A = "0x" + "aa".repeat(32);
const HASH_B = "0x" + "bb".repeat(32);

describe("ComplianceRegistry", function () {
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
        registry.connect(stranger).submitReport(await token.getAddress(), 10250, Status.Compliant, HASH_A)
      ).to.be.revertedWith("not reporter");
    });

    it("accepts reports from the configured reporter", async function () {
      const { registry, token, reporter } = await deploy();
      await registry.setReporter(reporter.address);
      await expect(
        registry.connect(reporter).submitReport(await token.getAddress(), 10250, Status.Compliant, HASH_A)
      ).to.emit(registry, "ReportSubmitted");
    });

    it("rejects zero addresses for reporter and forwarder", async function () {
      const { registry } = await deploy();
      await expect(registry.setReporter(ethers.ZeroAddress)).to.be.revertedWith("zero reporter");
      await expect(registry.setForwarder(ethers.ZeroAddress)).to.be.revertedWith("zero forwarder");
    });

    it("lets only the owner reconfigure reporter and forwarder", async function () {
      const { registry, reporter, stranger } = await deploy();
      await expect(registry.connect(stranger).setReporter(reporter.address)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("onReport (CRE delivery path)", function () {
    function encodeReport(token: string, ratio: number, status: number, hash: string) {
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint8", "bytes32"],
        [token, ratio, status, hash]
      );
    }

    it("fails closed before a forwarder is configured, even for the owner", async function () {
      const { registry, token, owner } = await deploy();
      const payload = encodeReport(await token.getAddress(), 10250, Status.Compliant, HASH_A);
      await expect(registry.connect(owner).onReport("0x", payload)).to.be.revertedWith("not forwarder");
    });

    it("accepts reports from the configured forwarder only", async function () {
      const { registry, token, forwarder, stranger } = await deploy();
      await registry.setForwarder(forwarder.address);
      const payload = encodeReport(await token.getAddress(), 9720, Status.AtRisk, HASH_B);
      await expect(registry.connect(stranger).onReport("0x", payload)).to.be.revertedWith("not forwarder");
      await registry.connect(forwarder).onReport("0x", payload);
      const latest = await registry.latestReport(await token.getAddress());
      expect(latest.status).to.equal(Status.AtRisk);
      expect(latest.reserveRatioBps).to.equal(9720);
      expect(latest.reporter).to.equal(forwarder.address);
    });
  });

  describe("recording and history", function () {
    it("rejects the Unknown status and the zero token address", async function () {
      const { registry, token } = await deploy();
      await expect(
        registry.submitReport(await token.getAddress(), 10000, 0, HASH_A)
      ).to.be.revertedWith("unknown status");
      await expect(registry.submitReport(ethers.ZeroAddress, 10000, Status.Compliant, HASH_A)).to.be.revertedWith(
        "zero token"
      );
    });

    it("keeps an append-only history and the latest pointer in sync", async function () {
      const { registry, token } = await deploy();
      const addr = await token.getAddress();
      await registry.submitReport(addr, 10250, Status.Compliant, HASH_A);
      await registry.submitReport(addr, 8815, Status.Breach, HASH_B);
      expect(await registry.reportCount(addr)).to.equal(2);
      const first = await registry.reportAt(addr, 0);
      expect(first.status).to.equal(Status.Compliant);
      expect(first.reportHash).to.equal(HASH_A);
      const latest = await registry.latestReport(addr);
      expect(latest.status).to.equal(Status.Breach);
      expect(latest.reportHash).to.equal(HASH_B);
    });

    it("invariant: N submitted reports produce exactly N immutable history entries", async function () {
      const { registry, token } = await deploy();
      const addr = await token.getAddress();
      // Deterministic pseudo-random walk over ratios and statuses.
      let seed = 42;
      const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
      const inputs: { ratio: number; status: number }[] = [];
      for (let i = 0; i < 25; i++) {
        const ratio = 8000 + (next() % 5000); // 80.00% .. 129.99%
        const status = ratio >= 10000 ? Status.Compliant : ratio >= 9500 ? Status.AtRisk : Status.Breach;
        inputs.push({ ratio, status });
        await registry.submitReport(addr, ratio, status, HASH_A);
      }
      expect(await registry.reportCount(addr)).to.equal(inputs.length);
      for (let i = 0; i < inputs.length; i++) {
        const r = await registry.reportAt(addr, i);
        expect(r.reserveRatioBps).to.equal(inputs[i].ratio);
        expect(r.status).to.equal(inputs[i].status);
      }
      const latest = await registry.latestReport(addr);
      expect(latest.reserveRatioBps).to.equal(inputs[inputs.length - 1].ratio);
    });
  });

  describe("end-to-end verdict anchoring (the three demo scenarios)", function () {
    it("anchors healthy / at-risk / breach verdicts for the same asset", async function () {
      const { registry, token, reporter } = await deploy();
      const addr = await token.getAddress();
      await registry.setReporter(reporter.address);
      const scenarios = [
        { ratio: 10250, status: Status.Compliant },
        { ratio: 9720, status: Status.AtRisk },
        { ratio: 8815, status: Status.Breach },
      ];
      for (const s of scenarios) {
        await registry.connect(reporter).submitReport(addr, s.ratio, s.status, HASH_A);
        const latest = await registry.latestReport(addr);
        expect(latest.status).to.equal(s.status);
        expect(latest.reserveRatioBps).to.equal(s.ratio);
      }
      expect(await registry.reportCount(addr)).to.equal(3);
    });
  });
});
