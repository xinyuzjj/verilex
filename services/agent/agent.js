/**
 * VeriLex compliance agent — analysis core.
 *
 * Given a custodian attestation (off-chain reserves + legal status) and the
 * token's on-chain circulating supply, the agent evaluates a transparent rule
 * set and produces a verdict with a full reasoning trail. The trail is hashed
 * (SHA-256) and the hash is what the Chainlink CRE workflow anchors on-chain
 * in the ComplianceRegistry, so any verdict can be re-verified against the
 * exact evidence the agent saw.
 *
 * The verdict logic is deliberately explainable (no black box): every check
 * records what was observed, the threshold applied, and the outcome. If an
 * OPENAI_API_KEY is configured, the agent additionally asks an LLM to write a
 * plain-language summary of the trail; the verdict itself never depends on
 * the LLM.
 *
 * Usage:
 *   HTTP:  node agent.js --serve            (POST /analyze, GET /health)
 *   CLI:   node agent.js --asset PROP-SG-001 --supply 1000000 --scenario atrisk
 */
const http = require("http");
const crypto = require("crypto");

const CUSTODIAN_URL = process.env.CUSTODIAN_URL || "http://localhost:8787";
const PORT = process.env.AGENT_PORT || 8788;

// Thresholds (basis points where applicable)
const RULES = {
  reserveCompliantBps: 10000, // >= 100.00% coverage -> compliant
  reserveAtRiskBps: 9500, // 95.00%..99.99% -> at risk; below -> breach
  licenseExpiringDays: 30, // licence expiring within 30d -> at risk
  auditMaxAgeDays: 180, // audit older than 180d -> at risk
};

const STATUS = { COMPLIANT: 1, ATRISK: 2, BREACH: 3 }; // mirrors ComplianceRegistry enum

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 864e5);
}

function evaluate(att, totalSupply) {
  // Validate before dividing: a zero or malformed supply would otherwise
  // turn the coverage ratio into Infinity/NaN and corrupt the verdict.
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) {
    throw new Error("totalSupply must be a positive number");
  }
  if (!att || !Number.isFinite(att.reservesUSD) || att.reservesUSD < 0) {
    throw new Error("attestation reservesUSD must be a non-negative number");
  }
  if (!att.legal || !att.legal.licenseValidUntil || !att.legal.lastAudit) {
    throw new Error("attestation is missing legal status fields");
  }
  const now = new Date();
  const checks = [];
  let worst = STATUS.COMPLIANT;

  const raise = (level) => {
    if (level > worst) worst = level;
  };

  // 1. Reserve coverage: reserves vs circulating claims.
  const claimsUSD = totalSupply * (att.unitClaimUSD || 1);
  const ratioBps = Math.floor((att.reservesUSD / claimsUSD) * 10000);
  const reserveLevel =
    ratioBps >= RULES.reserveCompliantBps
      ? STATUS.COMPLIANT
      : ratioBps >= RULES.reserveAtRiskBps
        ? STATUS.ATRISK
        : STATUS.BREACH;
  checks.push({
    check: "reserve_coverage",
    observed: `${(ratioBps / 100).toFixed(2)}% (reserves $${att.reservesUSD} vs claims $${claimsUSD})`,
    threshold: `>=100% compliant; 95-99.99% at-risk; <95% breach`,
    result: ["compliant", "at-risk", "breach"][reserveLevel - 1],
    explanation:
      reserveLevel === STATUS.COMPLIANT
        ? "Attested reserves fully cover the circulating token supply."
        : reserveLevel === STATUS.ATRISK
          ? "Reserves cover most claims but sit below the 100% comfort line."
          : "Material reserve shortfall: claims exceed attested reserves by more than 5%.",
  });
  raise(reserveLevel);

  // 2. Custodian licence in force.
  const licUntil = new Date(att.legal.licenseValidUntil + "T00:00:00Z");
  const licDays = daysBetween(now, licUntil);
  const licLevel = licDays < 0 ? STATUS.BREACH : licDays <= RULES.licenseExpiringDays ? STATUS.ATRISK : STATUS.COMPLIANT;
  checks.push({
    check: "custodian_licence",
    observed: `valid until ${att.legal.licenseValidUntil} (${licDays} days)`,
    threshold: `expired = breach; expiring within ${RULES.licenseExpiringDays} days = at-risk`,
    result: ["compliant", "at-risk", "breach"][licLevel - 1],
    explanation:
      licLevel === STATUS.BREACH
        ? "The custodian's licence has lapsed; reserves are held by an unlicensed entity."
        : licLevel === STATUS.ATRISK
          ? "Custodian licence expires soon; renewal evidence should be requested."
          : "Custodian licence is in force.",
  });
  raise(licLevel);

  // 3. Legal documentation anchored.
  const docOk = typeof att.legal.docHash === "string" && att.legal.docHash.startsWith("0x") && att.legal.docHash.length === 66;
  const docLevel = docOk ? STATUS.COMPLIANT : STATUS.BREACH;
  checks.push({
    check: "legal_doc_anchor",
    observed: docOk ? `doc hash ${att.legal.docHash.slice(0, 18)}…` : "missing or malformed doc hash",
    threshold: "a 32-byte hash of the trust deed / issuance memorandum must be present",
    result: ["compliant", "at-risk", "breach"][docLevel - 1],
    explanation: docOk
      ? "Governing legal documents are hashed and anchored for verification."
      : "No verifiable legal document anchor was provided.",
  });
  raise(docLevel);

  // 4. Audit freshness.
  const auditDate = new Date(att.legal.lastAudit.date + "T00:00:00Z");
  const auditAge = daysBetween(auditDate, now);
  const auditLevel = auditAge > RULES.auditMaxAgeDays ? STATUS.ATRISK : STATUS.COMPLIANT;
  checks.push({
    check: "audit_freshness",
    observed: `last audit ${att.legal.lastAudit.date} by ${att.legal.lastAudit.firm}, opinion "${att.legal.lastAudit.opinion}" (${auditAge} days ago)`,
    threshold: `audit must be <= ${RULES.auditMaxAgeDays} days old`,
    result: ["compliant", "at-risk", "breach"][auditLevel - 1],
    explanation: auditLevel === STATUS.COMPLIANT ? "Independent audit is recent." : "Audit is stale; a fresh attestation audit should be commissioned.",
  });
  raise(auditLevel);

  const statusName = ["compliant", "at-risk", "breach"][worst - 1];
  const report = {
    assetId: att.assetId,
    assetName: att.name,
    generatedAt: now.toISOString(),
    custodianAsOf: att.asOf,
    totalSupply,
    claimsUSD,
    reservesUSD: att.reservesUSD,
    reserveRatioBps: ratioBps,
    status: statusName,
    statusCode: worst,
    checks,
    custodianNotes: att.notes || "",
  };
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

async function analyze({ assetId, totalSupply, scenario, custodianUrl }) {
  const base = custodianUrl || CUSTODIAN_URL;
  const url = `${base}/assets/${encodeURIComponent(assetId)}/attestation${scenario ? `?scenario=${scenario}` : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`custodian API ${r.status}`);
  const att = await r.json();
  const report = evaluate(att, totalSupply);
  const summary = await summarizeWithLLM(report);
  if (summary) report.llmSummary = summary;
  return report;
}

// ---------- CLI ----------
async function cli() {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf("--" + k);
    return i >= 0 ? args[i + 1] : d;
  };
  const report = await analyze({
    assetId: get("asset", "PROP-SG-001"),
    totalSupply: Number(get("supply", "1000000")),
    scenario: get("scenario", undefined),
    custodianUrl: get("custodian", undefined),
  });
  console.log(JSON.stringify(report, null, 2));
}

// ---------- HTTP server ----------
function serve() {
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true, service: "verilex-agent" }));
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
  server.listen(PORT, () => console.log(`verilex-agent listening on http://localhost:${PORT}`));
}

if (process.argv.includes("--serve")) serve();
else cli().catch((e) => {
  console.error(e);
  process.exit(1);
});

module.exports = { evaluate, analyze, STATUS, RULES };
