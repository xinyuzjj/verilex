import { expect } from "chai";
import { ethers } from "hardhat";

const Status = { Compliant: 1, AtRisk: 2, Breach: 3 } as const;
const HASH = "0x" + "aa".repeat(32);
const POLICY = "0x" + "11".repeat(32);

describe("TokenizedAsset", function () {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const supply = ethers.parseUnits("1000000", 18);
    const asset = await ethers.deployContract("TokenizedAsset", [
      "VeriLex Harbor Tower Note",
      "vHTN",
      "PROP-SG-001",
      "Commercial real-estate note, Harbor Tower, Singapore",
      "Singapore",
      supply,
      owner.address,
    ]);
    return { asset, owner, alice, bob, supply };
  }

  it("stores the RWA metadata and mints the initial supply to the owner", async function () {
    const { asset, owner, supply } = await deploy();
    expect(await asset.assetId()).to.equal("PROP-SG-001");
    expect(await asset.jurisdiction()).to.equal("Singapore");
    expect(await asset.totalSupply()).to.equal(supply);
    expect(await asset.balanceOf(owner.address)).to.equal(supply);
  });

  it("lets only the owner mint, and any holder burn their own tokens", async function () {
    const { asset, owner, alice, supply } = await deploy();
    await expect(asset.connect(alice).mint(alice.address, 1n)).to.be.revertedWithCustomError(
      asset,
      "OwnableUnauthorizedAccount"
    );
    await asset.burn(ethers.parseUnits("100", 18));
    expect(await asset.totalSupply()).to.equal(supply - ethers.parseUnits("100", 18));
  });

  describe("compliance gate", function () {
    async function gated() {
      const ctx = await deploy();
      const registry = await ethers.deployContract("ComplianceRegistry", [ctx.owner.address]);
      await ctx.asset.setRegistry(await registry.getAddress());
      await ctx.asset.setGateEnabled(true);
      // Give Alice a balance to move around.
      await ctx.asset.transfer(ctx.alice.address, ethers.parseUnits("1000", 18));
      return { ...ctx, registry };
    }

    it("lets transfers pass while the asset is compliant or at-risk", async function () {
      const { asset, alice, bob, registry } = await gated();
      const addr = await asset.getAddress();
      await registry.submitReport(addr, 10250, Status.Compliant, 97, HASH, POLICY);
      await asset.connect(alice).transfer(bob.address, ethers.parseUnits("10", 18));
      await registry.submitReport(addr, 9720, Status.AtRisk, 68, HASH, POLICY);
      await asset.connect(alice).transfer(bob.address, ethers.parseUnits("10", 18));
      expect(await asset.balanceOf(bob.address)).to.equal(ethers.parseUnits("20", 18));
    });

    it("freezes wallet-to-wallet transfers while the asset is in breach", async function () {
      const { asset, alice, bob, registry } = await gated();
      await registry.submitReport(await asset.getAddress(), 8815, Status.Breach, 31, HASH, POLICY);
      await expect(asset.connect(alice).transfer(bob.address, 1n)).to.be.revertedWith(
        "compliance freeze: asset in breach"
      );
    });

    it("never gates issuance or redemption, even in breach", async function () {
      const { asset, alice, owner, registry } = await gated();
      await registry.submitReport(await asset.getAddress(), 8815, Status.Breach, 31, HASH, POLICY);
      await asset.mint(owner.address, ethers.parseUnits("5", 18)); // issuance passes
      await asset.connect(alice).burn(ethers.parseUnits("5", 18)); // redemption passes
      expect(await asset.balanceOf(alice.address)).to.equal(ethers.parseUnits("995", 18));
    });

    it("unfreezes when a later verdict clears the breach, and only the owner can rewire the gate", async function () {
      const { asset, alice, bob, registry } = await gated();
      const addr = await asset.getAddress();
      await registry.submitReport(addr, 8815, Status.Breach, 31, HASH, POLICY);
      await registry.submitReport(addr, 10100, Status.Compliant, 90, HASH, POLICY);
      await asset.connect(alice).transfer(bob.address, ethers.parseUnits("3", 18));
      await expect(asset.connect(alice).setGateEnabled(false)).to.be.revertedWithCustomError(
        asset,
        "OwnableUnauthorizedAccount"
      );
    });
  });
});
