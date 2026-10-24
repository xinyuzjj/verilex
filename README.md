# VeriLex — Continuous Compliance for Tokenized Real-World Assets

**VeriLex is a compliance layer for tokenized RWAs.** A Chainlink CRE workflow
continuously sweeps a whole portfolio of tokenized assets — a real-estate note,
a carbon-credit pool, a T-bill fund, SGD-denominated REIT units — verifying each
one's off-chain backing (custodian reserves, licences, legal documents, audits,
sanctions screening) against its on-chain supply, scoring it under a versioned
policy, and anchoring the verdict on-chain. When an asset falls into **BREACH**,
its own token **freezes transfers** until compliance is restored. Compliance stops
being a PDF at issuance and becomes a live, enforceable property of the asset.

Built for the **BLI Legal Tech Hackathon 2** (RWA · LegalTech & RegTech ·
AI x Blockchain), targeting the **Chainlink CRE** bounty.

- **Live demo dashboard:** https://xinyuzjj.github.io/verilex/
- **Demo video:** https://xinyuzjj.github.io/verilex/verilex-demo-remotion.mp4

## The problem

A tokenized asset is only as trustworthy as the off-chain reserves and legal
structure behind it — but after issuance, nobody checks continuously. Reserve
accounts drain, custodian licences lapse, audits go stale, documents expire,
and the token keeps trading as if nothing changed. Holders and venues find out
last. VeriLex closes that gap: every asset, every check cycle, every control —
with the verdict enforced by the token itself.

## What it does

1. **Attest** — each asset's custodian publishes a reserve & legal attestation
   (reserves, licence validity, trust-deed hash, audit, sanctions screening).
2. **Fetch** — the CRE workflow pulls attestations with DON consensus and reads
   each token's `totalSupply()` on-chain.
3. **Convert** — foreign-currency reserves are converted with a **Chainlink
   Data Feed** price read on-chain (`FeedConsumer`), never a hardcoded rate.
4. **Evaluate** — a versioned policy engine runs 7+ checks per asset, computes
   a **0–100 compliance score**, and an analyst module narrates key risks and
   concrete remediation steps. Verdicts stay rule-based and explainable — in a
   legal setting, "the model said so" is not an audit trail.
5. **Anchor & enforce** — verdict, score, the hash of the full reasoning trail
   and the policy hash are written to `ComplianceRegistry`. Gated
   `TokenizedAsset`s consult the registry on every transfer and **freeze while
   their asset is in BREACH** (issuance and redemption are never blocked).

## The policy — `verilex-policy-2.0`

| Check | Compliant | At-risk | Breach | Score penalty (at-risk / breach) |
|---|---|---|---|---|
| Reserve coverage | ≥ 100% | 95–99.99% | < 95% | −15 / −45 |
| Custodian licence | in force | expires ≤ 30 d | lapsed | −10 / −35 |
| Sanctions screening | clear | — | flagged | — / −40 |
| Legal doc anchor | hash anchored | — | missing/invalid | — / −25 |
| Attestation freshness | ≤ 24 h | ≤ 72 h | older | −10 / −20 |
| Audit freshness | ≤ 180 d | older | — | −10 / — |
| Doc review currency | on schedule | overdue | — | −8 / — |
| Coverage drift (vs prior check) | ≤ 5 pts | > 5 pts | — | −5 / — |

Policy hash (SHA-256 of the canonical policy): `0x8eba1689e07a82d292363cdf911d6f83667658ac8e883d80ad080ed6ce03f313`.
Every on-chain report carries it, so any verdict can be re-derived and audited
against the exact rule-set that produced it.

## Contracts

| Contract | Role |
|---|---|
| `ComplianceRegistry` | Portfolio-wide verdict anchor: per-asset history (ratio, status, score, trail hash, policy hash), asset enumeration, fail-closed CRE `onReport`. |
| `TokenizedAsset` | ERC-20 per asset with RWA metadata and a **compliance gate**: transfers revert while the registry's latest verdict is BREACH. |
| `FeedConsumer` | Chainlink Data Feeds consumer (positivity, round-completeness and staleness checks) used for FX conversion. |
| `MockV3Aggregator` | Local stand-in for a Chainlink feed so the whole pipeline runs identically on a local chain. |

Local demo deployment (fresh Hardhat node, deploy order deterministic):
registry `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`, feed consumer
`0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` — see `contracts/scripts/deploy.ts`.

## Security model

- **Fail-closed reporting.** `ComplianceRegistry.onReport` rejects *every*
  caller until the owner configures the Chainlink forwarder. A compliance
  anchor must never silently accept unauthenticated verdicts because setup is
  incomplete.
- **Least authority.** Direct report submission is limited to a single
  configured reporter (or the owner); zero-address and `Unknown`-status /
  out-of-range-score inputs are rejected on-chain.
- **No SSRF via the agent API.** The agent's custodian endpoint is operator
  configuration; it is never taken from an `/analyze` request body.
- **Input validation before arithmetic.** Supplies, reserves and legal fields
  are validated before any ratio is computed, including the FX path
  (foreign-currency attestations without a feed rate are rejected, never
  silently treated as USD).
- **Feed hygiene.** Prices must be positive, from a completed round, and fresh
  within a configured staleness bound.
- **The gate cannot trap funds.** Only wallet-to-wallet transfers are gated;
  the issuer can always mint and holders can always burn (redeem), even in
  BREACH.
- **Static analysis.** Slither (102 detectors) reports no vulnerabilities;
  three informational findings were reviewed and are by design (partial tuple
  use in the feed consumer, a timestamp comparison that *is* the staleness
  check, and an interface-inheritance style note).

## Testing

**27 automated tests, all passing.**

- Contracts (Hardhat, 16): reporter/forwarder access control, fail-closed
  `onReport`, score & policy anchoring, asset enumeration, a 25-step
  property-style invariant walk over report history, the gate (freeze on
  breach, issuance/redemption exempt, unfreeze on recovery, owner-only
  rewiring), and feed consumer behaviour (conversion, updates, stale and
  non-positive price rejection).
- Agent (node:test, 11): scenario verdicts and score math for the real demo
  data, coverage boundaries (100.00 / 99.99 / 95.00 / 94.99), SGD feed
  conversion and the missing-rate rejection, sanctions flag → breach, stale
  attestation → breach, overdue doc review, coverage-drift flagging, hash
  stability and input validation.

## Run it locally

```bash
# 1. Local chain (masquerades as Sepolia, chainId 11155111, for the CRE config)
cd contracts && npx hardhat node

# 2. Services (custodian attestations on :8787, agent on :8788)
cd ../services && node custodian-api/server.js
node agent/agent.js --serve

# 3. Deploy the portfolio + run the full demo (board, freeze, recovery)
cd ../contracts && npx hardhat run scripts/deploy.ts --network localhost
ADDRESSES_JSON=<from deploy output> npx hardhat run scripts/submit-demo-reports.ts --network localhost

# 4. Dashboard (data files are generated by step 3 into web/demo-data/)
npx serve ../web   # or open the live GitHub Pages demo
```

Tests: `cd contracts && npx hardhat test` and `node --test services/agent/agent.test.js`.

## Chainlink CRE — simulated successfully with the official CLI

The CRE workflow in `cre/compliance-workflow/` is original TypeScript written
against the official CRE SDK; it type-checks cleanly (`tsc --noEmit`). On
2026-10-24 it was executed for real with the official CLI:

```
cre workflow simulate compliance-workflow --target staging-settings --non-interactive --trigger-index 0
```

Result (full log: `cre/simulation-log-2026-10-24.txt`): all four assets were
evaluated inside the workflow — PROP-SG-001 COMPLIANT 100 (102.50%),
CARB-PA-002 COMPLIANT 100 (103.00%), TBILL-US-003 COMPLIANT 100 (102.00%),
REIT-SG-004 COMPLIANT 100 (103.60%, with the SGD/USD conversion performed
inside the workflow from the Chainlink feed) — each producing its report hash
and a simulated registry write. The staging target points the Sepolia chain
selector at the local masquerade chain and the custodian API at localhost, so
the verdicts match the locally executed pipeline exactly. Deployment access
for the organization has been requested from Chainlink and is under review;
it is not required for simulation.

## Repository layout

```
contracts/   Hardhat project: registry, gated token, feed consumer, mock feed,
             16 tests, deploy + end-to-end demo scripts
cre/         Chainlink CRE workflow (TypeScript, multi-asset portfolio sweep)
services/    Custodian attestation API (4 assets × 3 scenarios) and the
             compliance agent: policy engine, analyst, HTTP + CLI
web/         Portfolio dashboard (data generated by the real pipeline run)
```

License: MIT.
