/**
 * VeriLex compliance workflow (Chainlink CRE, TypeScript).
 *
 * On a cron schedule this workflow:
 *   1. Fetches the custodian's attestation for a tokenized real-world asset
 *      (reserves, custodian licence, legal document anchor, last audit) over
 *      HTTP, with DON consensus over the parsed fields.
 *   2. Reads the asset token's totalSupply() on-chain via the EVM capability.
 *   3. Evaluates a transparent compliance rule set (the same rules as the
 *      off-chain VeriLex agent) and builds a reasoning trail.
 *   4. Anchors the verdict on-chain: the trail is hashed and a DON-signed
 *      report carrying (token, reserveRatioBps, status, reportHash) is
 *      delivered to the ComplianceRegistry consumer contract via onReport().
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
  custodianApiUrl: z.string(),
  scenario: z.string().optional(),
  chainSelectorName: z.string(),
  tokenAddress: z.string(),
  registryAddress: z.string(),
  gasLimit: z.string(),
  writeEnabled: z.boolean(),
})

type Config = z.infer<typeof configSchema>

// Flat, consensus-friendly view of the custodian attestation.
type AttestationData = {
  reservesUSD: number
  licenseDaysRemaining: number
  auditAgeDays: number
  docHashOk: number // 1 = legal doc hash present and well-formed
  unitClaimUSD: number
  docHash: string
}

const DAY_MS = 86_400_000

const fetchAttestation = (sendRequester: HTTPSendRequester, config: Config): AttestationData => {
  const url = config.scenario
    ? `${config.custodianApiUrl}?scenario=${config.scenario}`
    : config.custodianApiUrl
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
  const docHash: string = body.legal.docHash ?? ""
  const docHashOk = /^0x[0-9a-fA-F]{64}$/.test(docHash) ? 1 : 0
  return {
    reservesUSD: body.reservesUSD,
    licenseDaysRemaining,
    auditAgeDays,
    docHashOk,
    unitClaimUSD: body.unitClaimUSD ?? 1,
    docHash,
  }
}

// Status codes mirror ComplianceRegistry.Status (0 is unused/Unknown).
const COMPLIANT = 1
const ATRISK = 2
const BREACH = 3

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config

  // 1. Custodian attestation via HTTP capability (DON consensus per field).
  const httpClient = new HTTPClient()
  const att = httpClient
    .sendRequest(
      runtime,
      fetchAttestation,
      ConsensusAggregationByFields<AttestationData>({
        reservesUSD: median<number>(),
        licenseDaysRemaining: median<number>(),
        auditAgeDays: median<number>(),
        docHashOk: median<number>(),
        unitClaimUSD: median<number>(),
        docHash: identical<string>(),
      })
    )(config)
    .result()
  runtime.log(
    `Attestation: reserves=$${att.reservesUSD} licenceDays=${att.licenseDaysRemaining} auditAgeDays=${att.auditAgeDays} docHashOk=${att.docHashOk}`
  )

  // 2. On-chain circulating supply via EVM capability.
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName })
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`)
  const evmClient = new EVMClient(network.chainSelector.selector)

  const erc20Abi = parseAbi(["function totalSupply() view returns (uint256)"])
  const callData = encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" })
  const callResp = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: config.tokenAddress as Address,
        data: callData,
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result()
  const supplyRaw = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "totalSupply",
    data: bytesToHex(callResp.data),
  }) as bigint
  const supply = Number(formatUnits(supplyRaw, 18)) // demo asset uses 18 decimals
  runtime.log(`On-chain totalSupply: ${supply}`)

  // 3. Evaluate the compliance rule set (mirrors services/agent/agent.js).
  const claimsUSD = supply * att.unitClaimUSD
  const ratioBps = claimsUSD > 0 ? Math.floor((att.reservesUSD / claimsUSD) * 10000) : 0
  let status = COMPLIANT
  const checks: Record<string, unknown>[] = []
  const raise = (level: number) => {
    if (level > status) status = level
  }

  const reserveLevel = ratioBps >= 10000 ? COMPLIANT : ratioBps >= 9500 ? ATRISK : BREACH
  checks.push({ check: "reserve_coverage", reserveRatioBps: ratioBps, result: reserveLevel })
  raise(reserveLevel)

  const licenseLevel = att.licenseDaysRemaining < 0 ? BREACH : att.licenseDaysRemaining <= 30 ? ATRISK : COMPLIANT
  checks.push({ check: "custodian_licence", licenseDaysRemaining: att.licenseDaysRemaining, result: licenseLevel })
  raise(licenseLevel)

  const docLevel = att.docHashOk >= 0.5 ? COMPLIANT : BREACH
  checks.push({ check: "legal_doc_anchor", docHash: att.docHash, result: docLevel })
  raise(docLevel)

  const auditLevel = att.auditAgeDays > 180 ? ATRISK : COMPLIANT
  checks.push({ check: "audit_freshness", auditAgeDays: att.auditAgeDays, result: auditLevel })
  raise(auditLevel)

  const statusName = status === COMPLIANT ? "COMPLIANT" : status === ATRISK ? "AT-RISK" : "BREACH"
  const trailJson = JSON.stringify({
    token: config.tokenAddress,
    supply,
    claimsUSD,
    reservesUSD: att.reservesUSD,
    reserveRatioBps: ratioBps,
    status: statusName,
    checks,
  })
  const reportHash = keccak256(stringToHex(trailJson))
  runtime.log(`Verdict: ${statusName} | reserve ratio: ${(ratioBps / 100).toFixed(2)}% | reportHash: ${reportHash}`)

  // 4. Anchor the verdict on-chain via a DON-signed report to the registry.
  if (config.writeEnabled) {
    const payload = encodeAbiParameters(
      parseAbiParameters("address token, uint256 reserveRatioBps, uint8 status, bytes32 reportHash"),
      [config.tokenAddress as Address, BigInt(ratioBps), status, reportHash]
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
      throw new Error(`On-chain write failed with status: ${writeResult.txStatus}`)
    }
    const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))
    runtime.log(`Verdict anchored on-chain, tx: ${txHash}`)
    return `${statusName} ratioBps=${ratioBps} tx=${txHash}`
  }

  return `${statusName} ratioBps=${ratioBps} reportHash=${reportHash}`
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
