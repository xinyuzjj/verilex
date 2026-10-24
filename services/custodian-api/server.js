/**
 * VeriLex demo custodian API (v2 — multi-asset).
 *
 * Simulates the off-chain attestation endpoints of regulated custodians /
 * trustees holding the reserves behind tokenized real-world assets.
 * In production this role is played by each asset's trustee or fund
 * administrator; here it serves deterministic demo data for a portfolio of
 * four assets, each with healthy / atrisk / breach scenarios, so the
 * compliance agent's verdicts can be demonstrated end to end:
 *
 *   GET /assets
 *   GET /assets/:assetId/attestation?scenario=healthy|atrisk|breach
 *   GET /health
 *
 * Zero dependencies (Node >= 18 built-in http only).
 */
const http = require("http");

const PORT = process.env.PORT || 8787;

const ASSETS = {
  "PROP-SG-001": {
    assetId: "PROP-SG-001",
    name: "Harbor Tower Commercial Note",
    type: "Real-estate note",
    custodian: "Meridian Trust (Singapore) Pte. Ltd.",
    trustee: "Meridian Trustees Ltd.",
    spv: "Harbor Tower SPV Pte. Ltd.",
    jurisdiction: "Singapore",
    currency: "USD",
    unitClaimUSD: 1,
    valuationUSD: 1_000_000,
    scenarios: {
      healthy: { reservesAmount: 1_025_000, licenseDays: 240, auditAgeDays: 40, sanctions: "clear", docReviewDays: 120, notes: "Reserves exceed circulating claims; all licences in force." },
      atrisk: { reservesAmount: 972_000, licenseDays: 12, auditAgeDays: 40, sanctions: "clear", docReviewDays: 120, notes: "Partial redemption in transit; custodian licence renews within 30 days." },
      breach: { reservesAmount: 881_500, licenseDays: -6, auditAgeDays: 40, sanctions: "clear", docReviewDays: 120, notes: "Custodian licence lapsed 6 days ago; reserve shortfall unexplained." },
    },
  },
  "CARB-PA-002": {
    assetId: "CARB-PA-002",
    name: "BlueCarbon Credit Pool",
    type: "Carbon credits",
    custodian: "Isthmus Fiduciaria S.A.",
    trustee: "Isthmus Trustees S.A.",
    spv: "BlueCarbon SPV S.A.",
    jurisdiction: "Panama",
    currency: "USD",
    unitClaimUSD: 1,
    valuationUSD: 500_000,
    scenarios: {
      healthy: { reservesAmount: 515_000, licenseDays: 300, auditAgeDays: 60, sanctions: "clear", docReviewDays: 90, notes: "Verified credit inventory exceeds issued units." },
      atrisk: { reservesAmount: 489_000, licenseDays: 300, auditAgeDays: 205, sanctions: "clear", docReviewDays: 90, notes: "Coverage thin and the last verification audit is stale." },
      breach: { reservesAmount: 440_000, licenseDays: 300, auditAgeDays: 60, sanctions: "flagged", docReviewDays: 90, notes: "Registry screening flagged a project counterparty; credit shortfall under review." },
    },
  },
  "TBILL-US-003": {
    assetId: "TBILL-US-003",
    name: "Tokenized T-Bill Fund",
    type: "Tokenized treasury fund",
    custodian: "Liberty Fund Services LLC",
    trustee: "Liberty Trustees LLC",
    spv: "Liberty T-Bill SPV LLC",
    jurisdiction: "United States",
    currency: "USD",
    unitClaimUSD: 1,
    valuationUSD: 2_000_000,
    scenarios: {
      healthy: { reservesAmount: 2_040_000, licenseDays: 400, auditAgeDays: 30, sanctions: "clear", docReviewDays: 200, notes: "T-bill holdings marked daily; coverage above target." },
      atrisk: { reservesAmount: 1_990_000, licenseDays: 400, auditAgeDays: 30, sanctions: "clear", docReviewDays: 200, notes: "Redemption queue briefly pushed coverage under 100%." },
      breach: { reservesAmount: 1_880_000, licenseDays: 400, auditAgeDays: 30, sanctions: "clear", docReviewDays: -45, notes: "Coverage below the 95% floor and the trust deed review is 45 days overdue." },
    },
  },
  "REIT-SG-004": {
    assetId: "REIT-SG-004",
    name: "Orchard Income REIT Units",
    type: "REIT units",
    custodian: "Meridian Trust (Singapore) Pte. Ltd.",
    trustee: "Meridian Trustees Ltd.",
    spv: "Orchard Income SPV Pte. Ltd.",
    jurisdiction: "Singapore",
    currency: "SGD", // reserves are attested in SGD; the agent converts via the SGD/USD feed
    unitClaimUSD: 1,
    valuationUSD: 1_000_000,
    scenarios: {
      healthy: { reservesAmount: 1_400_000, licenseDays: 240, auditAgeDays: 45, sanctions: "clear", docReviewDays: 150, notes: "SGD reserve account above target coverage at current FX." },
      atrisk: { reservesAmount: 1_320_000, licenseDays: 240, auditAgeDays: 45, sanctions: "clear", docReviewDays: 150, notes: "FX movement and a partial payout pulled USD coverage under 100%." },
      breach: { reservesAmount: 1_200_000, licenseDays: 20, auditAgeDays: 45, sanctions: "clear", docReviewDays: 150, notes: "SGD reserves no longer cover USD claims; licence renewal also due within 30 days." },
    },
  },
};

function attestation(assetId, scenario) {
  const base = ASSETS[assetId];
  if (!base) return null;
  const s = base.scenarios[scenario];
  const now = new Date();
  const iso = (d) => d.toISOString();
  const daysFromNow = (n) => new Date(now.getTime() + n * 864e5);
  const { scenarios, ...meta } = base;
  return {
    ...meta,
    asOf: iso(now),
    reservesAmount: s.reservesAmount,
    reserveAccountRef: `ESCROW-${assetId}`,
    legal: {
      docHash: "0x8f3a2b1c9d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeef",
      docType: "Trust deed + issuance memorandum (hash anchored on-chain)",
      licenseValidUntil: iso(daysFromNow(s.licenseDays)).slice(0, 10),
      docReviewDue: iso(daysFromNow(s.docReviewDays)).slice(0, 10),
      sanctionsScreening: { provider: "Elliptic (demo)", status: s.sanctions },
      kycProvider: "Sumsub (demo)",
      lastAudit: {
        firm: "KPMG (demo data)",
        date: iso(daysFromNow(-s.auditAgeDays)).slice(0, 10),
        opinion: "unqualified",
      },
    },
    notes: s.notes,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");

  if (url.pathname === "/health") {
    res.end(JSON.stringify({ ok: true, service: "verilex-custodian-api", version: 2 }));
    return;
  }
  if (url.pathname === "/assets") {
    const list = Object.values(ASSETS).map(({ scenarios, ...meta }) => meta);
    res.end(JSON.stringify(list, null, 2));
    return;
  }
  const m = url.pathname.match(/^\/assets\/([^/]+)\/attestation$/);
  if (m) {
    const scenario = url.searchParams.get("scenario") || "healthy";
    // Reject unknown scenarios instead of silently serving the healthy one:
    // a typo must never make a demo (or a check) report the wrong state.
    if (!["healthy", "atrisk", "breach"].includes(scenario)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `unknown scenario: ${scenario}` }));
      return;
    }
    const data = attestation(decodeURIComponent(m[1]), scenario);
    if (!data) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unknown asset" }));
      return;
    }
    res.end(JSON.stringify(data, null, 2));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`custodian-api v2 listening on http://localhost:${PORT}`);
});

module.exports = { ASSETS, attestation };
