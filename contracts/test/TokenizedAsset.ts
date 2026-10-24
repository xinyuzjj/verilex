import { expect } from "chai";
import { ethers } from "hardhat";

describe("TokenizedAsset", function () {
  async function deploy() {
    const [owner, alice] = await ethers.getSigners();
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
    return { asset, owner, alice, supply };
  }

  it("stores the RWA metadata and mints the initial supply to the owner", async function () {
    const { asset, owner, supply } = await deploy();
    expect(await asset.assetId()).to.equal("PROP-SG-001");
    expect(await asset.jurisdiction()).to.equal("Singapore");
    expect(await asset.totalSupply()).to.equal(supply);
    expect(await asset.balanceOf(owner.address)).to.equal(supply);
  });

  it("lets only the owner mint", async function () {
    const { asset, alice } = await deploy();
    await expect(asset.connect(alice).mint(alice.address, 1n)).to.be.revertedWithCustomError(
      asset,
      "OwnableUnauthorizedAccount"
    );
    await asset.mint(alice.address, ethers.parseUnits("5", 18));
    expect(await asset.balanceOf(alice.address)).to.equal(ethers.parseUnits("5", 18));
  });

  it("lets a holder burn their own tokens", async function () {
    const { asset, owner, supply } = await deploy();
    await asset.burn(ethers.parseUnits("100", 18));
    expect(await asset.balanceOf(owner.address)).to.equal(supply - ethers.parseUnits("100", 18));
    expect(await asset.totalSupply()).to.equal(supply - ethers.parseUnits("100", 18));
  });
});
