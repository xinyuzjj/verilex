import { ethers } from "hardhat";

/**
 * End-to-end demo driver: ask the VeriLex agent (HTTP) for a verdict on each
 * custodian scenario, anchor each verdict in the ComplianceRegistry via
 * submitReport, then read the on-chain state back and print it.
 *
 * Expects TOKEN_ADDRESS and REGISTRY_ADDRESS in the environment and the
 * custodian API (:8787) plus agent (:8788) already serving.
 */
async function main() {
  const tokenAddr = process.env.TOKEN_ADDRESS!;
  const registryAddr = process.env.REGISTRY_ADDRESS!;
  if (!tokenAddr || !registryAddr) throw new Error("TOKEN_ADDRESS / REGISTRY_ADDRESS required");

  const registry = await ethers.getContractAt("ComplianceRegistry", registryAddr);
  const [deployer] = await ethers.getSigners();

  for (const scenario of ["healthy", "atrisk", "breach"]) {
    const res = await fetch("http://localhost:8788/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: "PROP-SG-001", totalSupply: 1000000, scenario }),
    });
    if (!res.ok) throw new Error(`agent ${res.status} for scenario ${scenario}`);
    const report: any = await res.json();
    const tx = await registry
      .connect(deployer)
      .submitReport(tokenAddr, report.reserveRatioBps, report.statusCode, report.reportHash);
    await tx.wait();
    console.log(
      `${scenario.padEnd(8)} agent verdict=${report.status} ratio=${report.reserveRatioBps}bps hash=${report.reportHash.slice(0, 18)}… anchored tx=${tx.hash.slice(0, 18)}…`
    );
  }

  const count = await registry.reportCount(tokenAddr);
  const latest = await registry.latestReport(tokenAddr);
  console.log(`on-chain: reportCount=${count} latestStatus=${latest.status} latestRatio=${latest.reserveRatioBps}`);
  for (let i = 0; i < Number(count); i++) {
    const r = await registry.reportAt(tokenAddr, i);
    console.log(`  history[${i}] status=${r.status} ratio=${r.reserveRatioBps} reporter=${r.reporter}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
