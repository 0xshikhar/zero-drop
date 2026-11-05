/**
 * Phase 0 gas spike for the EIP-8141 disclosure path.
 *
 * Question it answers: does the devnet admit a self-relay frame transaction whose VERIFY frame burns ~300k gas
 * (a stand-in for a Groth16 verification), when ZeroDrop is a staked sender?
 *
 * What it does
 *   1. Deploys MockVerifier(gasToBurn, default 300000) behind a fresh ZeroDrop (direct path off), creates a group,
 *      funds the float and optionally stakes, all on the target chain (--dry skips every network call).
 *   2. Builds the disclosure frame tx with buildDisclosureFrameTx (packages/core/src/frametx.ts).
 *   3. Checks locally that the SENDER frame data has the layout ZeroDrop's VERIFY fallback reads.
 *   4. Simulates it: ethrex_simulateFrameTransaction on the execution RPC with the RAW `0x06 || rlp` bytes
 *      (docs.altmempool.wtf, guides/submit-a-transaction: "takes the RLP-encoded raw transaction, not the JSON form").
 *   5. Submits it to the mempool URL(s) with eth_sendFrameTransaction and polls skandha_frameTransactionStatus,
 *      then reads eth_getFrameTransactionReceipt. Prints the result and the rejection reason, if any.
 *
 * STATUS: NEVER RUN against a frame-capable node. At the time of writing the devnet's TLS certificate is not yet
 * valid from the dev machine (about 05:31 GMT on 2026-11-06) and there is no local frame-capable node. Do not
 * disable TLS verification to get around that. Use `--dry` to check the encoding offline.
 *
 * Usage
 *   pnpm tsx scripts/gas-spike.ts --dry
 *   RPC_URL=https://<ethrex> MEMPOOL_URLS=https://<sidecar>/rpc DEPLOYER_PRIVATE_KEY=0x... \
 *     pnpm tsx scripts/gas-spike.ts --fund 0.1 --stake 0.012
 *   ... --zerodrop 0x...  (reuse a deployed ZeroDrop that already has group + float; also needs --group, --root)
 *
 * Options
 *   --dry                   Build and print the encoded tx only. No network, no key needed.
 *   --gas-to-burn <n>       Mock verifier gas. Default 300000.
 *   --fund <eth>            Float donated to ZeroDrop after deploy. Default 0.1.
 *   --stake <eth>           Stake from the float at the registry (default none). Needs the registry address.
 *   --registry <address>    IStakingRegistry. Default: documented devnet registry on chain 1337.
 *   --verify-gas <n>        Execution gas of the VERIFY frame. Default 450000 (frametx.ts default 30000 is far too low).
 *   --sender-gas <n>        Execution gas of the SENDER frame. Default 800000 (contract floor 450000, plus the mock burn).
 *   --state-gas <n>         State gas of the SENDER frame. Default 200000.
 *   --max-fee-gwei <n>      maxFeePerGas. Default: skandha_getGasPrice from the mempool, else eth_gasPrice, else 2.
 *   --simulate-only         Simulate but do not submit.
 *   --trace                 Ask the simulation for the ERC-7562 trace and print it in full.
 *   --poll-seconds <n>      How long to poll for inclusion. Default 90.
 *   --zerodrop/--group/--root   Use an existing deployment instead of deploying (see above).
 *
 * Env: RPC_URL (execution client; also used for deploys), MEMPOOL_URLS (comma separated sidecar /rpc URLs, default
 * from config/devnet.json sidecarUrls), DEPLOYER_PRIVATE_KEY (required unless the chain is 31337; never printed).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAddress, hexToBigInt, isAddress, keccak256, parseEther, toBytes, toHex, type Address, type Hex } from "viem";
import {
  DEVNET_CHAIN_ID,
  DEVNET_STAKING_REGISTRY,
  ZERO_ADDRESS,
  chainIdOf,
  loadArtifact,
  repoRoot,
  rpcUrl,
  signerFor,
} from "./lib/chain-env.ts";
import { makeDeployer } from "./lib/deploy-lib.ts";
import {
  MAX_COST_CAP_WEI,
  buildDisclosureFrameTx,
  frameRpc,
  recordCalldata,
  submitDisclosureFrameTx,
} from "../packages/core/src/frametx.ts";

/** Mirror of DisclosureFrameChecks.MIN_BODY_GAS (contracts/src/frame/DisclosureFrameChecks.sol). */
const CONTRACT_MIN_BODY_GAS = 450_000n;
/** BN254 scalar field, ZeroDrop.SNARK_SCALAR_FIELD. */
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const PLACEHOLDER_ZERODROP = "0x000000000000000000000000000000000000dEaD" as Address;
const UNSTAKE_DELAY_SEC = 86_400;

const { values } = parseArgs({
  options: {
    dry: { type: "boolean", default: false },
    "gas-to-burn": { type: "string" },
    fund: { type: "string" },
    stake: { type: "string" },
    registry: { type: "string" },
    "verify-gas": { type: "string" },
    "sender-gas": { type: "string" },
    "state-gas": { type: "string" },
    "max-fee-gwei": { type: "string" },
    "simulate-only": { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    "poll-seconds": { type: "string" },
    zerodrop: { type: "string" },
    group: { type: "string" },
    root: { type: "string" },
  },
  strict: true,
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")),
});

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

function randomWord(bytes: number): bigint {
  return BigInt(toHex(crypto.getRandomValues(new Uint8Array(bytes))));
}

/**
 * Mirrors ZeroDrop._readRecordArgs: the VERIFY fallback reads these offsets out of the SENDER frame's data. Throws if
 * the calldata frametx.ts produces does not have that layout.
 */
function checkVerifyLayout(data: Hex, expected: { proofLength: number; groupId: bigint; nullifier: bigint; root: bigint }) {
  const bytes = toBytes(data);
  const word = (offset: number) => hexToBigInt(toHex(bytes.slice(offset, offset + 32)));
  const problems: string[] = [];
  if (toHex(bytes.slice(0, 4)) !== keccak256(toBytes("record(uint256,bytes32,bytes32,uint256,uint256,uint256,bytes)")).slice(0, 10)) {
    problems.push("selector is not record(...)");
  }
  if (word(4) !== expected.groupId) problems.push("groupId is not at data[4..36]");
  if (word(4 + 96) !== expected.root) problems.push("root is not at data[100..132]");
  if (word(4 + 128) !== expected.nullifier) problems.push("nullifier is not at data[132..164]");
  if (word(4 + 192) !== 0xe0n) problems.push(`proof offset word is ${word(4 + 192)}, ZeroDrop requires 0xe0`);
  if (word(4 + 0xe0) !== BigInt(expected.proofLength)) problems.push("proof length word mismatch");
  if (bytes.length < 4 + 0xe0 + 32 + expected.proofLength) problems.push("data shorter than the proof it declares");
  if (problems.length > 0) throw new Error(`SENDER frame data does not match ZeroDrop's VERIFY layout:\n - ${problems.join("\n - ")}`);
}

function mempoolUrls(): string[] {
  const env = process.env.MEMPOOL_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
  if (env && env.length > 0) return env;
  try {
    const cfg = JSON.parse(readFileSync(resolve(repoRoot, "config/devnet.json"), "utf8")) as { sidecarUrls?: string[] };
    return cfg.sidecarUrls ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const dry = values.dry;
  const gasToBurn = BigInt(values["gas-to-burn"] ?? 300_000);
  const verifyGas = BigInt(values["verify-gas"] ?? 450_000);
  const senderGas = BigInt(values["sender-gas"] ?? 800_000);
  const stateGas = BigInt(values["state-gas"] ?? 200_000);
  if (senderGas < CONTRACT_MIN_BODY_GAS) {
    throw new Error(`--sender-gas ${senderGas} is below ZeroDrop's MIN_BODY_GAS ${CONTRACT_MIN_BODY_GAS}; the VERIFY frame would reject it`);
  }

  const caseId = keccak256(toBytes("zerodrop/gas-spike"));
  const cidDigest = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const nullifier = randomWord(31) + 1n;
  const root = values.root ? BigInt(values.root) : BigInt(keccak256(toBytes("zerodrop/gas-spike/root"))) % FIELD;
  const proof = toHex(new Uint8Array(256)); // MockVerifier ignores it; ZeroDrop wants 1..1024 bytes
  const depth = 2n;
  let groupId = values.group ? BigInt(values.group) : 1n;
  let zeroDrop: Address = PLACEHOLDER_ZERODROP;
  let chainId = DEVNET_CHAIN_ID;
  let maxFeePerGas = values["max-fee-gwei"] ? BigInt(Math.round(Number(values["max-fee-gwei"]) * 1e9)) : 2_000_000_000n;

  const urls = mempoolUrls();

  if (values.zerodrop) {
    if (!isAddress(values.zerodrop)) throw new Error("--zerodrop is not an address");
    zeroDrop = getAddress(values.zerodrop);
  }

  if (!dry) {
    const url = rpcUrl();
    chainId = await chainIdOf(url);
    const account = signerFor(chainId);
    console.log(`chain ${chainId} via ${url}, deployer ${account.address}`);
    if (chainId !== DEVNET_CHAIN_ID) {
      console.warn(`warning: chain id ${chainId} is not ${DEVNET_CHAIN_ID}; frametx.ts only supports the ethrex-eip8141-tracer profile`);
    }

    if (!values.zerodrop) {
      const registryArg = values.registry ?? (chainId === DEVNET_CHAIN_ID ? DEVNET_STAKING_REGISTRY : ZERO_ADDRESS);
      if (!isAddress(registryArg)) throw new Error("--registry is not an address");
      const registry = getAddress(registryArg);
      const { deploy, send, publicClient } = makeDeployer(url, account);
      const zd = await deploy("ZeroDrop", [false, registry]);
      const verifier = await deploy("MockVerifier", [gasToBurn]);
      zeroDrop = zd.address;
      const abi = loadArtifact("ZeroDrop").abi;
      await send(zeroDrop, abi, "setVerifier", [verifier.address]);
      await send(zeroDrop, abi, "createGroup", [1]);
      groupId = 1n;
      await send(zeroDrop, abi, "addMembers", [groupId, [1n], root]);
      const fund = parseEther(values.fund ?? "0.1");
      await send(zeroDrop, abi, "donate", [], fund);
      if (values.stake) {
        if (registry === ZERO_ADDRESS) throw new Error("--stake needs a registry");
        await send(zeroDrop, abi, "stake", [UNSTAKE_DELAY_SEC, parseEther(values.stake)]);
      }
      console.log(`ZeroDrop float ${await publicClient.getBalance({ address: zeroDrop })} wei`);
    } else if (!values.group || !values.root) {
      throw new Error("--zerodrop needs --group and --root (a root that group already published)");
    }

    if (!values["max-fee-gwei"]) {
      maxFeePerGas = await resolveGasPrice(urls, url, maxFeePerGas);
    }
  } else {
    console.log("dry run: no network access");
  }

  const built = buildDisclosureFrameTx({
    chainId,
    zeroDrop,
    groupId,
    caseId,
    cidDigest,
    root,
    nullifier,
    depth,
    proof,
    maxFeePerGas,
    verifyExecutionGas: verifyGas,
    senderExecutionGas: senderGas,
    senderStateGas: stateGas,
  });

  const data = recordCalldata({ groupId, caseId, cidDigest, root, nullifier, depth, proof });
  checkVerifyLayout(data, { proofLength: 256, groupId, nullifier, root });

  const totalGas = verifyGas + senderGas + stateGas;
  console.log("--- transaction");
  console.log(`sender/target   ${zeroDrop}`);
  console.log(`chainId         ${chainId}`);
  console.log(`nonce key/seq   ${nullifier} / 0`);
  console.log(`frames          [0] VERIFY exec ${verifyGas}   [1] SENDER exec ${senderGas} state ${stateGas}, data ${(data.length - 2) / 2} bytes`);
  console.log(`maxFeePerGas    ${maxFeePerGas} wei, gas limits sum ${totalGas}, cost bound ${totalGas * maxFeePerGas} wei (cap ${MAX_COST_CAP_WEI})`);
  console.log(`verify layout   ok (selector, groupId@4, root@100, nullifier@132, proof offset 0xe0, ${256} proof bytes)`);
  console.log(`txHash          ${built.txHash}`);
  console.log(`sigHash         ${built.sigHash}`);
  console.log(`raw (${(built.raw.length - 2) / 2} bytes)  ${built.raw}`);

  if (dry) return;

  const execUrl = rpcUrl();
  console.log("--- ethrex_simulateFrameTransaction");
  try {
    const sim = await frameRpc<Record<string, unknown>>({ url: execUrl }, "ethrex_simulateFrameTransaction", [
      built.raw,
      "latest",
      ...(values.trace ? [{ trace: true }] : []),
    ]);
    const { erc7562Trace, ...summary } = sim;
    console.log(json(summary));
    if (values.trace) console.log(json(erc7562Trace));
    else if (erc7562Trace) console.log("(trace omitted, pass --trace)");
  } catch (error) {
    console.error(`simulation failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!values["simulate-only"]) console.error("continuing to submit anyway, the mempool applies its own rules");
  }

  if (values["simulate-only"]) return;
  if (urls.length === 0) throw new Error("no mempool endpoint: set MEMPOOL_URLS or config/devnet.json sidecarUrls");

  console.log("--- eth_sendFrameTransaction");
  const submitted = await submitDisclosureFrameTx({ tx: built.tx, mempoolUrls: urls });
  console.log(json(submitted.results));
  if (!submitted.accepted) {
    console.error("REJECTED by every mempool endpoint. Reasons above (rule family comes from explainRejection).");
    for (const url of urls) await explainAdmission(url, built.txHash);
    process.exitCode = 1;
    return;
  }

  const accepted = submitted.results.find((r) => r.ok);
  const poll = accepted ? accepted.url : urls[0];
  const deadline = Date.now() + Number(values["poll-seconds"] ?? 90) * 1000;
  let last = "";
  console.log("--- skandha_frameTransactionStatus");
  while (Date.now() < deadline) {
    try {
      const status = await frameRpc<{ status?: string; reason?: string }>({ url: poll }, "skandha_frameTransactionStatus", [built.txHash]);
      if (status.status !== last) {
        last = status.status ?? "";
        console.log(`${new Date().toISOString()} ${json(status)}`);
      }
      if (["OnChain", "Finalized", "Reverted", "Cancelled"].includes(status.status ?? "")) break;
    } catch (error) {
      console.log(`status: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("--- eth_getFrameTransactionReceipt");
  try {
    console.log(json(await frameRpc({ url: poll }, "eth_getFrameTransactionReceipt", [built.txHash])));
  } catch (error) {
    console.log(`no receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (last !== "OnChain" && last !== "Finalized") process.exitCode = 1;
}

/** Best-effort: the explorer needs the sidecar started with --explorer.enable. */
async function explainAdmission(url: string, txHash: Hex): Promise<void> {
  try {
    const report = await frameRpc({ url }, "skandha_explorer_getTransaction", [txHash]);
    console.log(`admission report from ${url}:\n${json(report)}`);
  } catch (error) {
    console.log(`no admission report from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveGasPrice(urls: string[], execUrl: string, fallback: bigint): Promise<bigint> {
  for (const url of urls) {
    try {
      const price = await frameRpc<{ maxFeePerGas: Hex }>({ url }, "skandha_getGasPrice", []);
      return BigInt(price.maxFeePerGas);
    } catch {
      /* try the next source */
    }
  }
  try {
    return BigInt(await frameRpc<Hex>({ url: execUrl }, "eth_gasPrice", [])) * 2n;
  } catch {
    return fallback;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
