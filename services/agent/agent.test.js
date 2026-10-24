/**
 * Unit tests for the VeriLex compliance agent v2 (policy engine).
 * Run: node --test services/agent/agent.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, POLICY_HASH, STATUS } = require("./agent");

const isoDay = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => isoDay(new Date(Date.now() + n * 864e5));

function attestation(over = {}) {
  const base = {
    assetId: "PROP-SG-001",
    name: "Harbor Tower Commercial Note",
    asOf: new Date().toISOString(),
    currency: "USD",
    reservesAmount: 1_025_000,
    unitClaimUSD: 1,
    legal: {
      licenseValidUntil: daysFromNow(240),
      docHash: "0x8f3a2b1c9d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeef",
      docReviewDue: daysFromNow(120),
      sanctionsScreening: { provider: "Elliptic (demo)", status: "clear" },
      lastAudit: { firm: "KPMG (demo data)", date: daysFromNow(-40), opinion: "unqualified" },
    },
    notes: "",
  };
  const merged = { ...base, ...over, legal: { ...base.legal, ...(over.legal || {}) } };
  return merged;
}

const SUPPLY = 1_000_000;

// The v2 evaluate signature is evaluate(att, { totalSupply, fxRateUSD, prevRatioBps }).
const ev = (att, ctx = {}) => evaluate(att, { totalSupply: SUPPLY, ...ctx });

test("healthy scenario -> COMPLIANT at 10250 bps with score 100 and seven checks", () => {
  const r = ev(attestation());
  assert.equal(r.statusCode, STATUS.COMPLIANT);
  assert.equal(r.reserveRatioBps, 10250);
  assert.equal(r.score, 100);
  assert.equal(r.checks.length, 7);
  assert.equal(r.policy.hash, POLICY_HASH);
  assert.ok(r.analyst.headline.includes("COMPLIANT"));
});

test("at-risk: 97.2% coverage + licence expiring in 12 days -> AT-RISK, score 75", () => {
  const r = ev(attestation({ reservesAmount: 972_000, legal: { licenseValidUntil: daysFromNow(12) } }));
  assert.equal(r.statusCode, STATUS.ATRISK);
  assert.equal(r.reserveRatioBps, 9720);
  assert.equal(r.score, 75);
});

test("breach: 88.15% coverage + lapsed licence -> BREACH, score 20", () => {
  const r = ev(attestation({ reservesAmount: 881_500, legal: { licenseValidUntil: daysFromNow(-6) } }));
  assert.equal(r.statusCode, STATUS.BREACH);
  assert.equal(r.score, 20);
});

test("coverage boundaries: 100.00 / 99.99 / 95.00 / 94.99", () => {
  const cases = [
    [1_000_000, STATUS.COMPLIANT],
    [999_900, STATUS.ATRISK],
    [950_000, STATUS.ATRISK],
    [949_900, STATUS.BREACH],
  ];
  for (const [reserves, expected] of cases) {
    assert.equal(ev(attestation({ reservesAmount: reserves })).statusCode, expected, `reserves ${reserves}`);
  }
});

test("SGD reserves are converted with the feed FX rate; without a rate it throws", () => {
  const sgd = attestation({ currency: "SGD", reservesAmount: 1_400_000 });
  const r = ev(sgd, { fxRateUSD: 0.74 });
  assert.equal(r.reservesUSD, 1_036_000);
  assert.equal(r.reserveRatioBps, 10360);
  assert.equal(r.statusCode, STATUS.COMPLIANT);
  assert.equal(r.fx.rateUSD, 0.74);
  assert.throws(() => ev(sgd), /fxRateUSD/);
});

test("flagged sanctions screening -> BREACH even with full reserves", () => {
  const r = ev(attestation({ legal: { sanctionsScreening: { provider: "Elliptic (demo)", status: "flagged" } } }));
  assert.equal(r.statusCode, STATUS.BREACH);
  assert.equal(r.score, 60);
  assert.ok(r.analyst.remediations.some((s) => s.includes("Freeze onboarding")));
});

test("stale attestation (4 days old) -> BREACH via attestation_freshness", () => {
  const r = ev(attestation({ asOf: new Date(Date.now() - 4 * 864e5).toISOString() }));
  assert.equal(r.statusCode, STATUS.BREACH);
  assert.equal(r.checks.find((c) => c.check === "attestation_freshness").result, "breach");
});

test("overdue legal doc review -> AT-RISK with a small penalty", () => {
  const r = ev(attestation({ legal: { docReviewDue: daysFromNow(-10) } }));
  assert.equal(r.statusCode, STATUS.ATRISK);
  assert.equal(r.score, 92);
});

test("coverage drift vs previous check adds the supply_drift check", () => {
  const r = ev(attestation({ reservesAmount: 960_000 }), { prevRatioBps: 10250 });
  const drift = r.checks.find((c) => c.check === "supply_drift");
  assert.ok(drift);
  assert.equal(drift.result, "at-risk");
  assert.equal(r.checks.length, 8);
});

test("missing doc hash -> BREACH; stale audit alone -> AT-RISK", () => {
  assert.equal(ev(attestation({ legal: { docHash: "0x1234" } })).statusCode, STATUS.BREACH);
  const stale = ev(attestation({ legal: { lastAudit: { firm: "KPMG (demo data)", date: daysFromNow(-200), opinion: "unqualified" } } }));
  assert.equal(stale.statusCode, STATUS.ATRISK);
});

test("report hash format, policy hash stability, input validation", () => {
  const a = ev(attestation());
  const b = ev(attestation({ reservesAmount: 900_000 }));
  assert.match(a.reportHash, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a.reportHash, b.reportHash);
  assert.equal(a.policy.hash, b.policy.hash);
  assert.throws(() => evaluate(attestation(), { totalSupply: 0 }), /totalSupply/);
  assert.throws(() => ev(attestation({ reservesAmount: -5 })), /reservesAmount/);
  const broken = attestation();
  delete broken.legal;
  assert.throws(() => ev(broken), /legal/);
});
