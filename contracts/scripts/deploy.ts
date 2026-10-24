import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // --- Chainlink Data Feeds: local mock (Sepolia would use the real feed) ---
  // SGD/USD style feed: 8 decimals, 1 SGD = 0.74 USD.
  const mock = await ethers.deployContract("MockV3Aggregator", [8, 74_000_000]);
  await mock.waitForDeployment();
  const feedConsumer = await ethers.deployContract("FeedConsumer", [await mock.getAddress(), 3600]);
  await feedConsumer.waitForDeployment();
  console.log("MockV3Aggregator:", await mock.getAddress());
  console.log("FeedConsumer:", await feedConsumer.getAddress());

  // --- Compliance registry ---
  const registry = await ethers.deployContract("ComplianceRegistry", [deployer.address]);
  await registry.waitForDeployment();
  console.log("ComplianceRegistry:", await registry.getAddress());
  const tx0 = await registry.setReporter(deployer.address);
  await tx0.wait();
  console.log("Reporter set to:", deployer.address);

  // --- The RWA portfolio ---
  const portfolio: [string, string, string, string, string, string, string][] = [
    // name, symbol, assetId, underlying, jurisdiction, supply
    ["VeriLex Harbor Tower Note", "vHTN", "PROP-SG-001", "Commercial real-estate note, Harbor Tower, Singapore", "Singapore", "1000000"],
    ["VeriLex BlueCarbon Pool", "vBCP", "CARB-PA-002", "Blue carbon credit pool, Panama", "Panama", "500000"],
    ["VeriLex T-Bill Fund", "vTBF", "TBILL-US-003", "Tokenized US T-bill fund", "United States", "2000000"],
    ["VeriLex Orchard REIT", "vORE", "REIT-SG-004", "Orchard Road retail REIT units, Singapore", "Singapore", "1000000"],
  ];
  const addresses: Record<string, string> = {};
  for (const [name, symbol, assetId, underlying, jurisdiction, supply] of portfolio) {
    const token = await ethers.deployContract("TokenizedAsset", [
      name,
      symbol,
      assetId,
      underlying,
      jurisdiction,
      ethers.parseUnits(supply, 18),
      deployer.address,
    ]);
    await token.waitForDeployment();
    const addr = await token.getAddress();
    // Wire the compliance gate: the token consults the registry on transfers.
    await (await token.setRegistry(await registry.getAddress())).wait();
    await (await token.setGateEnabled(true)).wait();
    addresses[assetId] = addr;
    console.log(`TokenizedAsset[${assetId}]:`, addr);
  }

  console.log("ADDRESSES_JSON:" + JSON.stringify({
    registry: await registry.getAddress(),
    feedConsumer: await feedConsumer.getAddress(),
    mockFeed: await mock.getAddress(),
    tokens: addresses,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
