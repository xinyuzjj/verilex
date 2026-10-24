# VeriLex — AI Compliance Agent for Tokenized Real-World Assets

VeriLex continuously verifies that a tokenized real-world asset (RWA) stays
compliant: its circulating token supply must be backed by custodian-attested
reserves, its custodian must be licensed, its governing legal documents must
be anchored and verifiable, and its audits must be fresh. A **Chainlink CRE
workflow** performs the check end to end — fetching off-chain attestations,
reading on-chain supply, evaluating a transparent rule set, and anchoring the
verdict in a smart contract where anyone can verify it.

Built for the **BLI Legal Tech Hackathon 2** (tracks: RWA · LegalTech &
RegTech · AI × Blockchain) and the **Chainlink CRE bounty**.

## The problem

RWA tokenization is only as trustworthy as its off-chain promises. Today,
reserve and legal-compliance checks are manual, periodic, and opaque — a
lapsed custodian licence or a reserve shortfall can stay hidden until the
next audit PDF, months later. Investors and regulators have no continuous,
trustless way to know that a token is still fully backed and legally sound.

## How it works

1. **Cron trigger** — the CRE workflow fires on schedule.
2. **HTTP capability** — fetches the custodian's attestation (reserves,
   licence validity, legal document hash, last audit) with DON consensus
   over every parsed field.
3. **EVM read** — reads `totalSupply()` of the `TokenizedAsset` contract.
4. **Agent evaluation** — a transparent rule set (reserve coverage ≥ 100%,
   licence in force, legal doc anchored, audit ≤ 180 days old) produces a
   verdict — COMPLIANT / AT-RISK / BREACH — plus a reasoning trail that is
   hashed (keccak256).
5. **EVM write** — a DON-signed report carrying
   `(token, reserveRatioBps, status, reportHash)` is delivered to the
   `ComplianceRegistry` contract via `onReport()`, creating a permanent,
   publicly verifiable compliance history.

The same evaluation logic also runs as a standalone agent service
(`services/agent`), which powers the demo dashboard and can optionally use
an LLM to draft a plain-language summary (the verdict itself never depends
on the LLM).

## Repository layout

| Path | Contents |
| --- | --- |
| `contracts/` | Hardhat project: `TokenizedAsset` (ERC-20 RWA) and `ComplianceRegistry` (verdict anchor implementing the Chainlink `onReport` receiver pattern) |
| `cre/` | Chainlink CRE project: the `compliance-workflow` (TypeScript) |
| `services/custodian-api/` | Simulated custodian attestation API with healthy / at-risk / breach scenarios |
| `services/agent/` | Standalone compliance agent (rule engine + reasoning trail + report hash), CLI and HTTP modes |
| `web/` | Demo dashboard (scenario switcher, verdict, reserve ratio, reasoning trail) |

## Quick start (local demo)

Prerequisites: Node 20+, Bun 1.x, the [CRE CLI](https://docs.chain.link/cre),
a Chainlink Platform account (`cre login`).

```bash
# 1. Contracts on a local chain masquerading as Sepolia (chainId 11155111)
cd contracts && npm install && npx hardhat node          # terminal 1
npx hardhat run scripts/deploy.ts --network localhost    # terminal 2
#    -> copy the two addresses into cre/compliance-workflow/config.staging.json

# 2. Custodian attestation API (demo data)
node services/custodian-api/server.js                    # :8787

# 3. Standalone agent + dashboard (optional, no CRE account needed)
node services/agent/agent.js --serve                     # :8788
#    open web/index.html via any static server

# 4. The CRE workflow itself
cd cre/compliance-workflow && bun install
cd .. && cre workflow simulate compliance-workflow --target staging-settings
#    staging target RPC points at the local chain (see cre/project.yaml);
#    try scenarios by setting "scenario": "atrisk" | "breach" in the config
```

For a public-testnet run, point the `production-settings` RPC in
`cre/project.yaml` at Sepolia, deploy the contracts with
`--network sepolia`, set the registry's forwarder to the Chainlink Keystone
forwarder on Sepolia, and simulate with `--target production-settings`
(add `--broadcast` to send real transactions).

## Design notes

- **Explainable, not black-box.** Every verdict ships with the evidence:
  what was observed, the threshold applied, and the outcome per check.
- **Trust-minimized anchoring.** Only the verdict, ratio and trail hash go
  on-chain; the full trail stays off-chain and can be re-hashed by anyone
  to verify it matches the anchored hash.
- **Demo data honesty.** The custodian is simulated (real custodians expose
  similar attestation APIs); everything else — contracts, agent, CRE
  workflow — is real and runnable.

## License

MIT
