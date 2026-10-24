import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * VeriLex v2 end-to-end demo driver.
 *
 * Act 1 — portfolio board: evaluate four assets through the agent (custodian
 *   attestations + on-chain supply + Chainlink feed FX for the SGD asset),
 *   anchor every verdict in the ComplianceRegistry, write dashboard data.
 * Act 2 — the freeze: push PROP-SG-001 into BREACH, show a wallet transfer
 *   reverting on the compliance gate, then restore a compliant verdict and
 *   show the same transfer succeeding.
 *
 * Expects ADDRESSES_JSON (from deploy.ts output) in the environment and the
 * custodian API (:8787) plus agent v2 (:8788) already serving.
 */

const AGENT = "http://localhost:8788";

async function analyze(body: Record<string, unknown>) {
  const res = await fetch(`${AGENT}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const cfg = JSON.parse(process.env.ADDRESSES_JSON!);
  const registry = await ethers.getContractAt("ComplianceRegistry", cfg.registry);
  const feed = await ethers.getContractAt("FeedConsumer", cfg.feedConsumer);
  const [deployer, alice] = await ethers.getSigners();

  const [price] = await feed.latestPrice();
  const fxSGD = Number(price) / 1e8;
  console.log(`SGD/USD feed price: ${fxSGD}`);

  const boardPlan: Record<string, string> = {
    "PROP-SG-001": "healthy",
    "CARB-PA-002": "atrisk",
    "TBILL-US-003": "healthy",
    "REIT-SG-004": "atrisk",
  };

  const outDir = path.join(__dirname, "..", "..", "web", "demo-data");
  fs.mkdirSync(outDir, { recursive: true });
  const latestReports: Record<string, unknown> = {};

  async function evaluateAndAnchor(assetId: string, scenario: string) {
    const tokenAddr = cfg.tokens[assetId];
    const token = await ethers.getContractAt("TokenizedAsset", tokenAddr);
    const supply = Number((await token.totalSupply()) / 10n ** 18n);
    const report: any = await analyze({
      assetId,
      totalSupply: supply,
      scenario,
      fxRateUSD: assetId === "REIT-SG-004" ? fxSGD : undefined,
    });
    const tx = await registry.submitReport(
      tokenAddr,
      report.reserveRatioBps,
      report.statusCode,
      report.score,
      report.reportHash,
      report.policy.hash
    );
    await tx.wait();
    console.log(
      `${assetId} [${scenario}] -> ${report.status} score=${report.score} ratio=${report.reserveRatioBps}bps anchored`
    );
    latestReports[assetId] = report;
    fs.writeFileSync(path.join(outDir, `report-${assetId}.json`), JSON.stringify(report, null, 2));
    return report;
  }

  // ---- Act 1: the portfolio board ----
  for (const [assetId, scenario] of Object.entries(boardPlan)) {
    await evaluateAndAnchor(assetId, scenario);
  }

  // ---- Act 2: breach freezes the token; recovery unfreezes it ----
  const propAddr = cfg.tokens["PROP-SG-001"];
  const prop = await ethers.getContractAt("TokenizedAsset", propAddr);
  const freezeLog: string[] = [];
  await evaluateAndAnchor("PROP-SG-001", "breach");
  try {
    const t = await prop.connect(deployer).transfer(alice.address, ethers.parseUnits("1", 18));
    await t.wait();
    freezeLog.push("UNEXPECTED: transfer succeeded during breach");
  } catch (e: any) {
    freezeLog.push(`transfer during BREACH reverted: ${String(e.message || e).slice(0, 110)}`);
  }
  await evaluateAndAnchor("PROP-SG-001", "healthy");
  const okTx = await prop.connect(deployer).transfer(alice.address, ethers.parseUnits("1", 18));
  await okTx.wait();
  freezeLog.push("transfer succeeds again once the verdict clears BREACH (the sharp coverage swing is flagged by the drift check, then clears)");
  // One more check at the recovered coverage: the drift flag clears and the
  // asset is back to a clean COMPLIANT verdict.
  await evaluateAndAnchor("PROP-SG-001", "healthy");
  for (const line of freezeLog) console.log("FREEZE-DEMO:", line);
  fs.writeFileSync(path.join(outDir, "freeze-demo.json"), JSON.stringify({ log: freezeLog }, null, 2));

  // ---- Final on-chain readback + portfolio data ----
  fs.writeFileSync(
    path.join(outDir, "portfolio.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), reports: Object.values(latestReports) }, null, 2)
  );
  console.log(`on-chain assetCount=${await registry.assetCount()}`);
  for (const [assetId, addr] of Object.entries(cfg.tokens)) {
    const latest = await registry.latestReport(addr as string);
    console.log(
      `  ${assetId}: status=${latest.status} score=${latest.score} ratio=${latest.reserveRatioBps} reports=${await registry.reportCount(addr as string)}`
    );
  }
  console.log("demo-data written to", outDir);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
