/**
 * VeriLex demo custodian API.
 *
 * Simulates the off-chain attestation endpoint of a regulated custodian /
 * trustee holding the reserves behind a tokenized real-world asset.
 * In production this role is played by the asset's trustee or administrator;
 * here it serves deterministic demo data with three scenarios so the
 * compliance agent's verdicts can be demonstrated end to end:
 *
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
    custodian: "Meridian Trust (Singapore) Pte. Ltd.",
    trustee: "Meridian Trustees Ltd.",
    spv: "Harbor Tower SPV Pte. Ltd.",
    jurisdiction: "Singapore",
    currency: "USD",
    unitClaimUSD: 1, // 1 token = claim on USD 1 of the underlying note
  },
};

function attestation(assetId, scenario) {
  const base = ASSETS[assetId];
  if (!base) return null;
  const now = new Date();
  const iso = (d) => d.toISOString();
  const daysFromNow = (n) => new Date(now.getTime() + n * 864e5);

  const common = {
    ...base,
    asOf: iso(now),
    valuationUSD: 1_000_000,
    legal: {
      docHash:
        "0x8f3a2b1c9d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeef",
      docType: "Trust deed + issuance memorandum (hash anchored on-chain)",
      kycProvider: "Sumsub (demo)",
      lastAudit: {
        firm: "KPMG (demo data)",
        date: iso(daysFromNow(-40)).slice(0, 10),
        opinion: "unqualified",
      },
    },
  };

  if (scenario === "atrisk") {
    return {
      ...common,
      reservesUSD: 972_000, // 97.2% coverage -> below the 100% comfort line
      reserveAccountRef: "MT-SG-ESCROW-4471",
      legal: { ...common.legal, licenseValidUntil: iso(daysFromNow(12)).slice(0, 10) },
      notes: "Partial redemption in transit; custodian licence renews within 30 days.",
    };
  }
  if (scenario === "breach") {
    return {
      ...common,
      reservesUSD: 881_500, // 88.15% coverage -> material shortfall
      reserveAccountRef: "MT-SG-ESCROW-4471",
      legal: { ...common.legal, licenseValidUntil: iso(daysFromNow(-6)).slice(0, 10) },
      notes: "Custodian licence lapsed 6 days ago; reserve shortfall unexplained.",
    };
  }
  // healthy (default)
  return {
    ...common,
    reservesUSD: 1_025_000, // 102.5% coverage
    reserveAccountRef: "MT-SG-ESCROW-4471",
    legal: { ...common.legal, licenseValidUntil: iso(daysFromNow(240)).slice(0, 10) },
    notes: "Reserves exceed circulating claims; all licences in force.",
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");

  if (url.pathname === "/health") {
    res.end(JSON.stringify({ ok: true, service: "verilex-custodian-api" }));
    return;
  }
  const m = url.pathname.match(/^\/assets\/([^/]+)\/attestation$/);
  if (m) {
    const scenario = url.searchParams.get("scenario") || "healthy";
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
  console.log(`custodian-api listening on http://localhost:${PORT}`);
});
