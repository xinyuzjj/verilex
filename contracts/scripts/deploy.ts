import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // Demo RWA: fractionalized commercial real-estate note, custodian-attested.
  const initialSupply = ethers.parseUnits("1000000", 18); // 1,000,000 tokens
  const asset = await ethers.deployContract("TokenizedAsset", [
    "VeriLex Harbor Tower Note",
    "vHTN",
    "PROP-SG-001",
    "Commercial real-estate note, Harbor Tower, Singapore",
    "Singapore",
    initialSupply,
    deployer.address,
  ]);
  await asset.waitForDeployment();
  console.log("TokenizedAsset:", await asset.getAddress());

  const registry = await ethers.deployContract("ComplianceRegistry", [deployer.address]);
  await registry.waitForDeployment();
  console.log("ComplianceRegistry:", await registry.getAddress());

  // The deployer acts as reporter until a CRE workflow writer is configured.
  const tx = await registry.setReporter(deployer.address);
  await tx.wait();
  console.log("Reporter set to:", deployer.address);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
