/**
 * VeriLex compliance workflow v2 (Chainlink CRE, TypeScript).
 *
 * On a cron schedule this workflow sweeps a whole portfolio of tokenized
 * real-world assets. For each asset it:
 *   1. Fetches the custodian's attestation (reserves + legal status) over
 *      HTTP, with DON consensus over the parsed fields.
 *   2. Reads the token's totalSupply() on-chain via the EVM capability, and —
 *      for foreign-currency reserves — the Chainlink Data Feed price via the
 *      FeedConsumer contract, converting reserves to USD on-chain data only.
 *   3. Evaluates the versioned compliance policy (verilex-policy-2.0, the
 *      same rules and penalties as the off-chain VeriLex agent) producing a
 *      verdict and a 0-100 compliance score with a reasoning trail.
 *   4. Anchors the verdict on-chain: a DON-signed report carrying
 *      (token, reserveRatioBps, status, score, reportHash, policyHash) is
 *      delivered to ComplianceRegistry via onReport(). Gated tokens read
 *      the anchored status and freeze their own transfers on BREACH.
 */
import {
  CronCapability,
  HTTPClient,
  EVMClient,
  getNetwork,
  handler,
  ConsensusAggregationByFields,
  median,
  identical,
  encodeCallMsg,
  bytesToHex,
  hexToBase64,
  TxStatus,
  LATEST_BLOCK_NUMBER,
  type Runtime,
  type HTTPSendRequester,
  Runner,
} from "@chainlink/cre-sdk"
import {
  type Address,
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  zeroAddress,
  keccak256,
  stringToHex,
  formatUnits,
} from "viem"
import { z } from "zod"

const configSchema = z.object({
  schedule: z.string(),
  custodianApiBaseUrl: z.string(),
  scenario: z.string().optional(),
  chainSelectorName: z.string(),
  assets: z.array(z.object({ assetId: z.string(), tokenAddress: z.string() })),
  feedConsumerAddress: z.string(),
  registryAddress: z.string(),
  gasLimit: z.string(),
  writeEnabled: z.boolean(),
})

type Config = z.infer<typeof configSchema>

// SHA-256 of the canonical policy document (services/agent/agent.js POLICY).
// Anchored with every verdict so a score can be tied to the exact rules.
const POLICY_HASH = "0x8eba1689e07a82d292363cdf911d6f83667658ac8e883d80ad080ed6ce03f313"
const POLICY_VERSION = "verilex-policy-2.0"

// Flat, consensus-friendly view of a custodian attestation.
type AttestationData = {
  reservesAmount: number
  currencyCode: string
  licenseDaysRemaining: number
  auditAgeDays: number
  docHashOk: number // 1 = legal doc hash present and well-formed
  sanctionsFlag: number // 1 = a counterparty was flagged by screening
  docReviewOverdueDays: number // > 0 = the legal doc review is overdue
  attestationAgeHours: number
  unitClaimUSD: number
  docHash: string
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

type FetchArgs = Config & { assetId: string }

const fetchAttestation = (sendRequester: HTTPSendRequester, args: FetchArgs): AttestationData => {
  const url = args.scenario
    ? `${args.custodianApiBaseUrl}/assets/${args.assetId}/attestation?scenario=${args.scenario}`
    : `${args.custodianApiBaseUrl}/assets/${args.assetId}/attestation`
  const resp = sendRequester.sendRequest({ url, method: "GET" as const }).result()
  if (resp.statusCode !== 200) {
    throw new Error(`Custodian API returned status ${resp.statusCode}`)
  }
  const body = JSON.parse(new TextDecoder().decode(resp.body))
  const now = Date.now()
  const licenseDaysRemaining = Math.floor(
    (new Date(body.legal.licenseValidUntil + "T00:00:00Z").getTime() - now) / DAY_MS
  )
  const auditAgeDays = Math.floor(
    (now - new Date(body.legal.lastAudit.date + "T00:00:00Z").getTime()) / DAY_MS
  )
  const docReviewOverdueDays = body.legal.docReviewDue
    ? Math.floor((now - new Date(body.legal.docReviewDue + "T00:00:00Z").getTime()) / DAY_MS)
    : 0
  const attestationAgeHours = body.asOf
    ? Math.max(0, Math.floor((now - new Date(body.asOf).getTime()) / HOUR_MS))
    : 9999
  const docHash: string = body.legal.docHash ?? ""
  return {
    reservesAmount: body.reservesAmount,
    currencyCode: body.currency ?? "USD",
    licenseDaysRemaining,
    auditAgeDays,
    docHashOk: /^0x[0-9a-fA-F]{64}$/.test(docHash) ? 1 : 0,
    sanctionsFlag: body.legal.sanctionsScreening?.status === "clear" ? 0 : 1,
    docReviewOverdueDays,
    attestationAgeHours,
    unitClaimUSD: body.unitClaimUSD ?? 1,
    docHash,
  }
}

// Status codes mirror ComplianceRegistry.Status (0 is unused/Unknown).
const COMPLIANT = 1
const ATRISK = 2
const BREACH = 3

// Score penalties — identical to the agent's verilex-policy-2.0 table.
const PENALTIES: Record<string, { breach: number; atRisk: number }> = {
  reserve_coverage: { breach: 45, atRisk: 15 },
  custodian_licence: { breach: 35, atRisk: 10 },
  sanctions_screening: { breach: 40, atRisk: 0 },
  legal_doc_anchor: { breach: 25, atRisk: 0 },
  attestation_freshness: { breach: 20, atRisk: 10 },
  audit_freshness: { breach: 0, atRisk: 10 },
  doc_review_currency: { breach: 0, atRisk: 8 },
}

const evaluateAsset = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  assetId: string,
  tokenAddress: string
): string => {
  const config = runtime.config

  // 1. Custodian attestation via HTTP capability (DON consensus per field).
  const httpClient = new HTTPClient()
  const att = httpClient
    .sendRequest(
      runtime,
      fetchAttestation,
      ConsensusAggregationByFields<AttestationData>({
        reservesAmount: median,
        currencyCode: identical,
        licenseDaysRemaining: median,
        auditAgeDays: median,
        docHashOk: median,
        sanctionsFlag: median,
        docReviewOverdueDays: median,
        attestationAgeHours: median,
        unitClaimUSD: median,
        docHash: identical,
      })
    )({ ...config, assetId })
    .result()

  // 2a. On-chain circulating supply via EVM capability.
  const erc20Abi = parseAbi(["function totalSupply() view returns (uint256)"])
  const supplyCall = encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" })
  const supplyResp = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: tokenAddress as Address, data: supplyCall }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result()
  const supplyRaw = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "totalSupply",
    data: bytesToHex(supplyResp.data),
  }) as bigint
  const supply = Number(formatUnits(supplyRaw, 18))

  // 2b. FX conversion through the Chainlink Data Feed consumer (if needed).
  let reservesUSD = att.reservesAmount
  let fxRate: number | null = null
  if (att.currencyCode !== "USD") {
    const feedAbi = parseAbi([
      "function latestPrice() view returns (int256 price, uint256 updatedAt)",
      "function decimals() view returns (uint8)",
    ])
    const priceResp = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: config.feedConsumerAddress as Address,
          data: encodeFunctionData({ abi: feedAbi, functionName: "latestPrice" }),
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result()
    const [price] = decodeFunctionResult({
      abi: feedAbi,
      functionName: "latestPrice",
      data: bytesToHex(priceResp.data),
    }) as unknown as [bigint, bigint]
    const decResp = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: config.feedConsumerAddress as Address,
          data: encodeFunctionData({ abi: feedAbi, functionName: "decimals" }),
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result()
    const feedDecimals = decodeFunctionResult({
      abi: feedAbi,
      functionName: "decimals",
      data: bytesToHex(decResp.data),
    }) as number
    fxRate = Number(price) / 10 ** feedDecimals
    reservesUSD = Math.round(att.reservesAmount * fxRate)
    runtime.log(`[${assetId}] FX ${att.currencyCode}/USD=${fxRate} via Chainlink feed -> reservesUSD=$${reservesUSD}`)
  }

  // 3. Evaluate verilex-policy-2.0 (mirrors services/agent/agent.js).
  const claimsUSD = supply * att.unitClaimUSD
  const ratioBps = claimsUSD > 0 ? Math.floor((reservesUSD / claimsUSD) * 10000) : 0
  let status = COMPLIANT
  let penalty = 0
  const checks: Record<string, unknown>[] = []
  const raise = (check: string, level: number, observed: Record<string, unknown>) => {
    checks.push({ check, ...observed, result: level })
    if (level > status) status = level
    const p = PENALTIES[check]
    if (p) penalty += level === BREACH ? p.breach : level === ATRISK ? p.atRisk : 0
  }

  raise("reserve_coverage", ratioBps >= 10000 ? COMPLIANT : ratioBps >= 9500 ? ATRISK : BREACH, { reserveRatioBps: ratioBps })
  raise("custodian_licence", att.licenseDaysRemaining < 0 ? BREACH : att.licenseDaysRemaining <= 30 ? ATRISK : COMPLIANT, { licenseDaysRemaining: att.licenseDaysRemaining })
  raise("legal_doc_anchor", att.docHashOk >= 0.5 ? COMPLIANT : BREACH, { docHash: att.docHash })
  raise("audit_freshness", att.auditAgeDays > 180 ? ATRISK : COMPLIANT, { auditAgeDays: att.auditAgeDays })
  raise("attestation_freshness", att.attestationAgeHours <= 24 ? COMPLIANT : att.attestationAgeHours <= 72 ? ATRISK : BREACH, { attestationAgeHours: att.attestationAgeHours })
  raise("sanctions_screening", att.sanctionsFlag >= 0.5 ? BREACH : COMPLIANT, { sanctionsFlag: att.sanctionsFlag })
  raise("doc_review_currency", att.docReviewOverdueDays > 0 ? ATRISK : COMPLIANT, { docReviewOverdueDays: att.docReviewOverdueDays })

  const score = Math.max(0, 100 - penalty)
  const statusName = status === COMPLIANT ? "COMPLIANT" : status === ATRISK ? "AT-RISK" : "BREACH"
  const trailJson = JSON.stringify({
    assetId,
    token: tokenAddress,
    supply,
    claimsUSD,
    reservesUSD,
    fxRate,
    reserveRatioBps: ratioBps,
    status: statusName,
    score,
    policy: POLICY_VERSION,
    checks,
  })
  const reportHash = keccak256(stringToHex(trailJson))
  runtime.log(`[${assetId}] Verdict: ${statusName} score=${score} ratio=${(ratioBps / 100).toFixed(2)}% reportHash=${reportHash}`)

  // 4. Anchor the verdict on-chain via a DON-signed report.
  if (config.writeEnabled) {
    const payload = encodeAbiParameters(
      parseAbiParameters("address token, uint256 reserveRatioBps, uint8 status, uint256 score, bytes32 reportHash, bytes32 policyHash"),
      [tokenAddress as Address, BigInt(ratioBps), status, BigInt(score), reportHash, POLICY_HASH as `0x${string}`]
    )
    const report = runtime
      .report({
        encodedPayload: hexToBase64(payload),
        encoderName: "evm",
        signingAlgo: "ecdsa",
        hashingAlgo: "keccak256",
      })
      .result()
    const writeResult = evmClient
      .writeReport(runtime, {
        receiver: config.registryAddress,
        report,
        gasConfig: { gasLimit: config.gasLimit },
      })
      .result()
    if (writeResult.txStatus !== TxStatus.SUCCESS) {
      throw new Error(`On-chain write failed for ${assetId} with status: ${writeResult.txStatus}`)
    }
    const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))
    runtime.log(`[${assetId}] Verdict anchored on-chain, tx: ${txHash}`)
    return `${assetId}: ${statusName} score=${score} ratioBps=${ratioBps} tx=${txHash}`
  }

  return `${assetId}: ${statusName} score=${score} ratioBps=${ratioBps} reportHash=${reportHash}`
}

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName })
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`)
  const evmClient = new EVMClient(network.chainSelector.selector)

  const results: string[] = []
  for (const asset of config.assets) {
    results.push(evaluateAsset(runtime, evmClient, asset.assetId, asset.tokenAddress))
  }
  return results.join(" | ")
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}

main()
