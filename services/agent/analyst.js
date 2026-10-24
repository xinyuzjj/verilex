/**
 * VeriLex AI analyst — turns a rule-engine report into a readable risk
 * narrative with concrete remediation steps.
 *
 * The verdict and the score always come from the transparent rule engine;
 * this module only explains them. It works fully offline with deterministic
 * templates; when an LLM key is configured the agent may additionally polish
 * the wording, but the structured content below is what gets hashed and
 * anchored, so it never depends on a model.
 */

const REMEDIATION = {
  reserve_coverage:
    "Top up the reserve account to restore coverage to at least 100%, or reduce circulating supply via redemption until coverage recovers.",
  custodian_licence:
    "Obtain and publish the custodian's licence renewal evidence; if the licence has lapsed, migrate custody to a licensed trustee.",
  legal_doc_anchor:
    "Anchor the current trust deed / issuance memorandum hash and publish the document reference for verification.",
  audit_freshness: "Commission a fresh reserve attestation audit and publish the signed report.",
  attestation_freshness:
    "Restore the custodian's attestation feed; verdicts based on stale evidence should be treated as provisional.",
  sanctions_screening:
    "Freeze onboarding for the flagged counterparty, run enhanced due diligence and file the required regulatory reports before clearing.",
  doc_review_currency: "Complete the scheduled legal document review and record the reviewer sign-off.",
  supply_drift:
    "Reconcile the supply change against issuance/redemption records before the next scheduled check.",
};

function narrate(report) {
  const failed = report.checks.filter((c) => c.result !== "compliant");
  const headline =
    `${report.assetName} is ${report.status.toUpperCase()} ` +
    `(compliance score ${report.score}/100, reserve coverage ${(report.reserveRatioBps / 100).toFixed(2)}%).`;
  const risks = failed.map((c) => `${c.check}: ${c.explanation}`);
  const remediations = failed.map((c) => REMEDIATION[c.check]).filter(Boolean);
  const outlook =
    report.status === "compliant"
      ? "No action required. The asset remains under continuous monitoring; the next scheduled check will re-verify every control."
      : report.status === "at-risk"
        ? "No immediate holder action is required, but the flagged controls should be remediated before the next check cycle; a downgrade to BREACH freezes transfers on gated tokens."
        : "Immediate attention required. While the BREACH verdict stands, transfers of the gated token are frozen on-chain; remediation and a fresh compliant verdict are needed to lift the freeze.";
  return { headline, risks, remediations, outlook };
}

module.exports = { narrate, REMEDIATION };
