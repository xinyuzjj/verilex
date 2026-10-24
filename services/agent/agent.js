/**
 * VeriLex compliance agent v2 — policy engine + analyst.
 *
 * Given a custodian attestation (off-chain reserves + legal status), the
 * token's on-chain circulating supply and, for foreign-currency reserves, a
 * Chainlink feed FX rate, the agent evaluates a versioned compliance policy
 * and produces a verdict, a 0-100 compliance score and a full reasoning
 * trail. The trail is hashed (SHA-256) and the hash — together with the
 * policy hash — is what gets anchored on-chain in the ComplianceRegistry, so
 * any verdict can be re-verified against the exact evidence and the exact
 * policy version that produced it.
 *
 * The verdict logic is deliberately explainable (no black box): every check
 * records what was observed, the threshold applied, its outcome and the
 * score penalty. An analyst module turns the trail into a risk narrative
 * with remediation steps; an optional LLM may polish wording but the
 * verdict and score never depend on it.
 *
 * Usage:
 *   HTTP:  node agent.js --serve            (POST /analyze, GET /portfolio, GET /health)
 *   CLI:   node agent.js --asset PROP-SG-001 --supply 1000000 --scenario atrisk
 *   CLI:   node agent.js --all --supplies supplies.json --scenarios scenarios.json --fx fx.json --out dir
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { narrate } = require("./analyst");

const CUSTODIAN_URL = process.env.CUSTODIAN_URL || "http://localhost:8787";
const PORT = process.env.AGENT_PORT || 8788;

// ---------------------------------------------------------------------------
// The compliance policy. Versioned and hashed: every report carries the
// policy hash, so a verdict can always be tied to the rules that made it.
// ---------------------------------------------------------------------------
const POLICY = {
  version: "verilex-policy-2.0",
  reserveCompliantBps: 10000, // >= 100.00% coverage -> compliant
  reserveAtRiskBps: 9500, // 95.00%..99.99% -> at-risk; below -> breach
  licenseExpiringDays: 30, // licence expiring within 30d -> at-risk
  auditMaxAgeDays: 180, // audit older than 180d -> at-risk
  attestationMaxAgeHours: 24, // attestation older than 24h -> at-risk; 72h -> breach
  attestationBreachAgeHours: 72,
  supplyDriftBps: 500, // coverage moving > 5pts between checks -> at-risk flag
  penalties: {
    reserve_coverage: { breach: 45, atRisk: 15 },
    custodian_licence: { breach: 35, atRisk: 10 },
    sanctions_screening: { breach: 40, atRisk: 0 },
    legal_doc_anchor: { breach: 25, atRisk: 0 },
    attestation_freshness: { breach: 20, atRisk: 10 },
    audit_freshness: { breach: 0, atRisk: 10 },
    doc_review_currency: { breach: 0, atRisk: 8 },
    supply_drift: { breach: 0, atRisk: 5 },
  },
};
const POLICY_HASH =
  "0x" + crypto.createHash("sha256").update(JSON.stringify(POLICY)).digest("hex");

const STATUS = { COMPLIANT: 1, ATRISK: 2, BREACH: 3 }; // mirrors ComplianceRegistry enum
const LEVEL_NAME = ["compliant", "at-risk", "breach"];

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 864e5);
}

function evaluate(att, ctx = {}) {
  const { totalSupply, fxRateUSD, prevRatioBps } = ctx;
  // Validate before dividing: a zero or malformed supply would otherwise
  // turn the coverage ratio into Infinity/NaN and corrupt the verdict.
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) {
    throw new Error("totalSupply must be a positive number");
  }
  if (!att || !Number.isFinite(att.reservesAmount) || att.reservesAmount < 0) {
    throw new Error("attestation reservesAmount must be a non-negative number");
  }
  if (!att.legal || !att.legal.licenseValidUntil || !att.legal.lastAudit) {
    throw new Error("attestation is missing legal status fields");
  }
  const currency = att.currency || "USD";
  let reservesUSD = att.reservesAmount;
  let fx = null;
  if (currency !== "USD") {
    if (!Number.isFinite(fxRateUSD) || fxRateUSD <= 0) {
      throw new Error(`fxRateUSD is required to convert ${currency} reserves`);
    }
    fx = { currency, rateUSD: fxRateUSD, source: "chainlink-feed" };
    reservesUSD = Math.round(att.reservesAmount * fxRateUSD);
  }

  const now = new Date();
  const checks = [];
  let worst = STATUS.COMPLIANT;
  let penalty = 0;
  const add = (check, level, observed, threshold, explanation) => {
    checks.push({ check, observed, threshold, result: LEVEL_NAME[level - 1], explanation });
    if (level > worst) worst = level;
    const p = POLICY.penalties[check] || { breach: 0, atRisk: 0 };
    penalty += level === STATUS.BREACH ? p.breach : level === STATUS.ATRISK ? p.atRisk : 0;
  };

  // 1. Reserve coverage: reserves vs circulating claims.
  const claimsUSD = totalSupply * (att.unitClaimUSD || 1);
  const ratioBps = Math.floor((reservesUSD / claimsUSD) * 10000);
  const reserveLevel =
    ratioBps >= POLICY.reserveCompliantBps
      ? STATUS.COMPLIANT
      : ratioBps >= POLICY.reserveAtRiskBps
        ? STATUS.ATRISK
        : STATUS.BREACH;
  add(
    "reserve_coverage",
    reserveLevel,
    `${(ratioBps / 100).toFixed(2)}% (reserves $${reservesUSD} vs claims $${claimsUSD})`,
    ">=100% compliant; 95-99.99% at-risk; <95% breach",
    reserveLevel === STATUS.COMPLIANT
      ? "Attested reserves fully cover the circulating token supply."
      : reserveLevel === STATUS.ATRISK
        ? "Reserves cover most claims but sit below the 100% comfort line."
        : "Material reserve shortfall: claims exceed attested reserves by more than 5%."
  );

  // 2. Custodian licence in force.
  const licUntil = new Date(att.legal.licenseValidUntil + "T00:00:00Z");
  const licDays = daysBetween(now, licUntil);
  const licLevel = licDays < 0 ? STATUS.BREACH : licDays <= POLICY.licenseExpiringDays ? STATUS.ATRISK : STATUS.COMPLIANT;
  add(
    "custodian_licence",
    licLevel,
    `valid until ${att.legal.licenseValidUntil} (${licDays} days)`,
    `expired = breach; expiring within ${POLICY.licenseExpiringDays} days = at-risk`,
    licLevel === STATUS.BREACH
      ? "The custodian's licence has lapsed; reserves are held by an unlicensed entity."
      : licLevel === STATUS.ATRISK
        ? "Custodian licence expires soon; renewal evidence should be requested."
        : "Custodian licence is in force."
  );

  // 3. Legal documentation anchored.
  const docOk = typeof att.legal.docHash === "string" && att.legal.docHash.startsWith("0x") && att.legal.docHash.length === 66;
  add(
    "legal_doc_anchor",
    docOk ? STATUS.COMPLIANT : STATUS.BREACH,
    docOk ? `doc hash ${att.legal.docHash.slice(0, 18)}…` : "missing or malformed doc hash",
    "a 32-byte hash of the trust deed / issuance memorandum must be present",
    docOk
      ? "Governing legal documents are hashed and anchored for verification."
      : "No verifiable legal document anchor was provided."
  );

  // 4. Audit freshness.
  const auditDate = new Date(att.legal.lastAudit.date + "T00:00:00Z");
  const auditAge = daysBetween(auditDate, now);
  const auditLevel = auditAge > POLICY.auditMaxAgeDays ? STATUS.ATRISK : STATUS.COMPLIANT;
  add(
    "audit_freshness",
    auditLevel,
    `last audit ${att.legal.lastAudit.date} by ${att.legal.lastAudit.firm}, opinion "${att.legal.lastAudit.opinion}" (${auditAge} days ago)`,
    `audit must be <= ${POLICY.auditMaxAgeDays} days old`,
    auditLevel === STATUS.COMPLIANT ? "Independent audit is recent." : "Audit is stale; a fresh attestation audit should be commissioned."
  );

  // 5. Attestation freshness: verdicts must rest on current evidence.
  const asOf = att.asOf ? new Date(att.asOf) : null;
  const ageHours = asOf ? Math.max(0, (now.getTime() - asOf.getTime()) / 36e5) : Infinity;
  const freshLevel =
    ageHours <= POLICY.attestationMaxAgeHours
      ? STATUS.COMPLIANT
      : ageHours <= POLICY.attestationBreachAgeHours
        ? STATUS.ATRISK
        : STATUS.BREACH;
  add(
    "attestation_freshness",
    freshLevel,
    asOf ? `attested ${ageHours.toFixed(1)}h ago` : "no attestation timestamp",
    `<= ${POLICY.attestationMaxAgeHours}h compliant; <= ${POLICY.attestationBreachAgeHours}h at-risk; older = breach`,
    freshLevel === STATUS.COMPLIANT
      ? "The attestation is current."
      : freshLevel === STATUS.ATRISK
        ? "The attestation is ageing; a fresh one should be requested."
        : "The attestation is too old to support a trustworthy verdict."
  );

  // 6. Sanctions / counterparty screening.
  const screening = att.legal.sanctionsScreening?.status || "clear";
  const sancLevel = screening === "clear" ? STATUS.COMPLIANT : STATUS.BREACH;
  add(
    "sanctions_screening",
    sancLevel,
    `screening status "${screening}" via ${att.legal.sanctionsScreening?.provider || "unknown provider"}`,
    "any flagged counterparty = breach until cleared",
    sancLevel === STATUS.COMPLIANT
      ? "No sanctioned or high-risk counterparty exposure reported."
      : "A counterparty connected to this asset has been flagged by screening."
  );

  // 7. Legal document review currency.
  if (att.legal.docReviewDue) {
    const due = new Date(att.legal.docReviewDue + "T00:00:00Z");
    const overdue = daysBetween(due, now);
    const reviewLevel = overdue > 0 ? STATUS.ATRISK : STATUS.COMPLIANT;
    add(
      "doc_review_currency",
      reviewLevel,
      overdue > 0 ? `review overdue by ${overdue} days (due ${att.legal.docReviewDue})` : `next review due ${att.legal.docReviewDue}`,
      "an overdue legal document review = at-risk",
      reviewLevel === STATUS.COMPLIANT
        ? "Legal documentation review is on schedule."
        : "The scheduled legal document review is overdue."
    );
  }

  // 8. Coverage drift vs the previous anchored check (when known).
  if (Number.isFinite(prevRatioBps)) {
    const drift = Math.abs(ratioBps - prevRatioBps);
    const driftLevel = drift > POLICY.supplyDriftBps ? STATUS.ATRISK : STATUS.COMPLIANT;
    add(
      "supply_drift",
      driftLevel,
      `coverage moved ${(drift / 100).toFixed(2)} points since the previous check (${(prevRatioBps / 100).toFixed(2)}% -> ${(ratioBps / 100).toFixed(2)}%)`,
      `movement over ${(POLICY.supplyDriftBps / 100).toFixed(0)} points between checks = at-risk`,
      driftLevel === STATUS.COMPLIANT ? "Coverage is stable versus the previous check." : "Coverage moved sharply since the previous check; the change should be reconciled."
    );
  }

  const score = Math.max(0, 100 - penalty);
  const report = {
    assetId: att.assetId,
    assetName: att.name,
    generatedAt: now.toISOString(),
    custodianAsOf: att.asOf,
    policy: { version: POLICY.version, hash: POLICY_HASH },
    totalSupply,
    claimsUSD,
    reservesUSD,
    reserveRatioBps: ratioBps,
    status: LEVEL_NAME[worst - 1],
    statusCode: worst,
    score,
    fx,
    checks,
    custodianNotes: att.notes || "",
  };
  report.analyst = narrate(report);
  report.reportHash =
    "0x" + crypto.createHash("sha256").update(JSON.stringify({ ...report, reportHash: undefined })).digest("hex");
  return report;
}

async function summarizeWithLLM(report) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content:
              "Write a 2-sentence plain-language summary of this RWA compliance report for a token holder:\n" +
              JSON.stringify(report),
          },
        ],
      }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

const lastReports = new Map(); // assetId -> latest report (for /portfolio)

async function analyze({ assetId, totalSupply, scenario, custodianUrl, fxRateUSD, prevRatioBps }) {
  const base = custodianUrl || CUSTODIAN_URL;
  const url = `${base}/assets/${encodeURIComponent(assetId)}/attestation${scenario ? `?scenario=${scenario}` : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`custodian API ${r.status}`);
  const att = await r.json();
  const prev = Number.isFinite(prevRatioBps) ? prevRatioBps : lastReports.get(assetId)?.reserveRatioBps;
  const report = evaluate(att, { totalSupply, fxRateUSD, prevRatioBps: prev });
  const summary = await summarizeWithLLM(report);
  if (summary) report.llmSummary = summary;
  lastReports.set(assetId, report);
  return report;
}

// ---------- CLI ----------
function argMap() {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf("--" + k);
    return i >= 0 ? args[i + 1] : d;
  };
  return { args, get };
}

async function cli() {
  const { args, get } = argMap();
  if (args.includes("--all")) {
    const supplies = JSON.parse(fs.readFileSync(get("supplies"), "utf8"));
    const scenarios = get("scenarios") ? JSON.parse(fs.readFileSync(get("scenarios"), "utf8")) : {};
    const fx = get("fx") ? JSON.parse(fs.readFileSync(get("fx"), "utf8")) : {};
    const outDir = get("out");
    const reports = [];
    for (const [assetId, supply] of Object.entries(supplies)) {
      const att = await (await fetch(`${CUSTODIAN_URL}/assets/${assetId}/attestation?scenario=${scenarios[assetId] || "healthy"}`)).json();
      const report = evaluate(att, { totalSupply: Number(supply), fxRateUSD: fx[att.currency] });
      report.analyst = narrate(report);
      reports.push(report);
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `report-${assetId}.json`), JSON.stringify(report, null, 2));
      }
      console.log(`${assetId}: ${report.status} score=${report.score} ratio=${report.reserveRatioBps}bps`);
    }
    if (outDir) {
      fs.writeFileSync(path.join(outDir, "portfolio.json"), JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
    }
    return;
  }
  const report = await analyze({
    assetId: get("asset", "PROP-SG-001"),
    totalSupply: Number(get("supply", "1000000")),
    scenario: get("scenario", undefined),
    custodianUrl: get("custodian", undefined),
    fxRateUSD: get("fx-rate") ? Number(get("fx-rate")) : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
}

// ---------- HTTP server ----------
function serve() {
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true, service: "verilex-agent", version: 2, policy: POLICY.version }));
      return;
    }
    if (req.method === "GET" && req.url === "/portfolio") {
      const reports = [...lastReports.values()];
      const counts = { compliant: 0, "at-risk": 0, breach: 0 };
      for (const r of reports) counts[r.status]++;
      res.end(JSON.stringify({ generatedAt: new Date().toISOString(), counts, reports }, null, 2));
      return;
    }
    if (req.method === "POST" && req.url === "/analyze") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const p = JSON.parse(body || "{}");
          // The custodian endpoint is operator configuration (env/CLI only).
          // It is deliberately NOT taken from the request body: letting any
          // caller point the agent at an arbitrary URL would turn /analyze
          // into a server-side request forgery vector.
          const report = await analyze({
            assetId: p.assetId || "PROP-SG-001",
            totalSupply: Number(p.totalSupply ?? 1000000),
            scenario: p.scenario,
            fxRateUSD: p.fxRateUSD != null ? Number(p.fxRateUSD) : undefined,
            prevRatioBps: p.prevRatioBps != null ? Number(p.prevRatioBps) : undefined,
          });
          res.end(JSON.stringify(report, null, 2));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(PORT, () => console.log(`verilex-agent v2 listening on http://localhost:${PORT}`));
}

if (require.main === module) {
  if (process.argv.includes("--serve")) serve();
  else
    cli().catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { evaluate, analyze, POLICY, POLICY_HASH, STATUS };
