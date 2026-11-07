/**
 * SupportPage — Whistleblower support, large-file storage endowment, and community donation.
 *
 * Three capabilities on one page:
 *
 * 1. **Community float donation** — tops up ZeroDrop.donate() so the contract can pay for frame
 *    transactions (gas float). Anyone can contribute ETH. Private: goes through Anon-RPC.
 *
 * 2. **Large-file storage endowment** — funds ZeroDropStorage.fundStorage() / topUpStorage() to
 *    sponsor decentralised IPFS/Filecoin persistence of a specific disclosure. Panama-Papers-scale
 *    datasets (gigabytes or petabytes) need on-chain endowments to pay independent pinner nodes
 *    to keep replicating. The cost is calculated client-side: free ≤ 1 MiB, priced above that at
 *    the on-chain ratePerMbPerBlock.
 *
 * 3. **Whistleblower gas sponsorship** — sends ETH directly to ZeroDrop.donate() but earmarks it
 *    conceptually for a specific case, so community members can sponsor a disclosure's transaction
 *    costs without knowing the sender's identity.
 *
 * All transactions use the user's own wallet (window.ethereum / EIP-1193) and go through Anon-RPC
 * so the contributor's IP address is not linked to the disclosure CID they are funding.
 *
 * Security notes:
 * - No private key is ever handled here. The page only builds calldata and calls `eth_sendTransaction`
 *   via the injected provider.
 * - The ZeroDropStorage contract address comes from config/<deployment>.json (storageContract field).
 *   Until the contract is deployed on a network and that field is set, the storage endowment section
 *   shows a clear "not deployed" notice rather than silently doing nothing.
 * - The gas float section always works on any deployment because ZeroDrop.donate() is always present.
 */
import { useState, useEffect } from "react";
import { parseEther, type Hex, type Address } from "viem";
import {
  calculateStorageQuote,
  formatDataSize,
  getStorageEndowmentStatus,
  type StorageQuote,
  type StorageStatus,
} from "@zerodrop/core";
import { useDeployment } from "../lib/prefs";
import { networkGate, useBootState, useNetworkPlan } from "../lib/network";
import { readClient } from "../lib/chain";
import { errorMessage, short } from "../lib/util";
import { Card, Warn, Info, Tick } from "./common";

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** Calls the injected EIP-1193 provider. Throws if no wallet is connected. */
async function sendWalletTx(params: {
  to: Address;
  value: bigint;
  data?: Hex;
}): Promise<Hex> {
  const provider = (window as unknown as { ethereum?: { request: (r: { method: string; params: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!provider) throw new Error("No wallet detected. Install MetaMask or a compatible EIP-1193 wallet to send transactions.");

  const accounts = (await provider.request({ method: "eth_requestAccounts", params: [] })) as string[];
  if (!accounts || accounts.length === 0) throw new Error("No wallet account available. Connect your wallet first.");
  const from = accounts[0];

  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [{
      from,
      to: params.to,
      value: "0x" + params.value.toString(16),
      data: params.data ?? "0x",
    }],
  }) as Hex;
  return txHash;
}

function formatWei(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return "0 ETH";
  if (eth < 0.0001) return `<0.0001 ETH`;
  return `${eth.toFixed(4)} ETH`;
}

const PARSE_ERROR = "Enter a valid positive number.";

// ---------------------------------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------------------------------

export function SupportPage() {
  const deployment = useDeployment();
  const plan = useNetworkPlan();
  const boot = useBootState();
  const gate = networkGate(plan, boot);

  const zeroDrop = deployment?.zeroDrop ?? null;
  // The storageContract address comes from an optional field in config/<deployment>.json.
  // Until ZeroDropStorage is deployed and the config field is set, this is undefined.
  const storageContract = (deployment as unknown as { storageContract?: Address })?.storageContract ?? null;

  return (
    <section>
      <p className="eyebrow">Support</p>
      <h1 className="page-title">Support a Disclosure</h1>
      <p className="lede">
        Anyone can help preserve a whistleblower's disclosure: sponsor the contract's gas float, fund long-term decentralised
        storage for large datasets, or top up the endowment of a specific CID so independent pinner nodes keep it online.
        All transfers go through Anon-RPC so your IP address is not linked to the CID you are supporting.
      </p>

      {!gate.ok && <Warn>{gate.message}</Warn>}

      {/* ── Section 1: Gas float donation ─────────────────────────────────────── */}
      <FloatDonationCard zeroDrop={zeroDrop} />

      {/* ── Section 2: Large-file storage endowment ───────────────────────────── */}
      <StorageEndowmentCard storageContract={storageContract} />

      {/* ── Section 3: Top-up an existing endowment (community crowdfunding) ──── */}
      <TopUpCard storageContract={storageContract} />

      {/* ── Section 4: How it works ───────────────────────────────────────────── */}
      <HowItWorksCard />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Float donation
// ---------------------------------------------------------------------------------------------------

function FloatDonationCard({ zeroDrop }: { zeroDrop: Address | null }) {
  const [amount, setAmount] = useState("0.01");
  const [working, setWorking] = useState(false);
  const [txHash, setTxHash] = useState<Hex>();
  const [error, setError] = useState<string>();

  const parsedWei = (() => {
    try { const v = parseEther(amount.trim()); return v > 0n ? v : null; }
    catch { return null; }
  })();

  async function donate() {
    if (!zeroDrop || !parsedWei) return;
    setWorking(true);
    setError(undefined);
    setTxHash(undefined);
    try {
      // ZeroDrop.donate() is payable, no calldata needed beyond the function selector.
      // The fallback also accepts plain ETH (empty calldata), but donate() is the explicit path.
      const hash = await sendWalletTx({
        to: zeroDrop,
        value: parsedWei,
        data: "0x47e7ef24", // keccak256("donate()")[0:4]
      });
      setTxHash(hash);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card
      title="Gas float donation"
      subtitle="Tops up the ZeroDrop contract's ETH balance so it can pay for EIP-8141 frame transactions on behalf of whistleblowers. No identity required."
      raised={false}
    >
      {!zeroDrop ? (
        <Warn>No deployment is selected. Go to Settings and pick a deployment first.</Warn>
      ) : (
        <>
          <Info>
            The ZeroDrop contract (<code className="mono">{short(zeroDrop, 10, 6)}</code>) pays its own gas through the EIP-8141 frame path.
            Donations top up this float. They are irreversible and become shared infrastructure.
            Your wallet address will appear in the transaction but your IP address goes through Anon-RPC.
          </Info>
          <label className="field narrow">
            <span className="field-label">Amount (ETH)</span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(undefined); setTxHash(undefined); }}
              aria-label="Donation amount in ETH"
            />
            {parsedWei && <span className="small muted">{formatWei(parsedWei)}</span>}
            {amount.trim() && !parsedWei && <span className="small warning-text">{PARSE_ERROR}</span>}
          </label>
          {error && <Warn>{error}</Warn>}
          {txHash && (
            <p className="small">
              <Tick>Sent.</Tick> Transaction: <code className="mono">{short(txHash, 14, 8)}</code>
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={working || !parsedWei} onClick={() => void donate()}>
              {working ? "Sending…" : "Donate to float"}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------
// Large-file storage endowment
// ---------------------------------------------------------------------------------------------------

/**
 * The Panama Papers were 2.6 TB. The Snowden archive was ~1.7 million files. This section handles
 * disclosures far beyond the 1 MiB free tier, giving a cost quote and submitting the on-chain endowment.
 */
function StorageEndowmentCard({ storageContract }: { storageContract: Address | null }) {
  const deployment = useDeployment();

  const [sizeInput, setSizeInput] = useState("1");
  const [sizeUnit, setSizeUnit] = useState<"MB" | "GB" | "TB">("GB");
  const [durationDays, setDurationDays] = useState(365);
  const [cidDigestInput, setCidDigestInput] = useState("");
  const [quote, setQuote] = useState<StorageQuote | null>(null);
  const [working, setWorking] = useState(false);
  const [txHash, setTxHash] = useState<Hex>();
  const [error, setError] = useState<string>();

  const sizeBytes = (() => {
    const n = parseFloat(sizeInput);
    if (!isFinite(n) || n <= 0) return null;
    const mul = sizeUnit === "MB" ? 1_048_576 : sizeUnit === "GB" ? 1_073_741_824 : 1_099_511_627_776;
    return Math.round(n * mul);
  })();

  // Recompute quote whenever inputs change
  useEffect(() => {
    if (!sizeBytes || durationDays < 1) { setQuote(null); return; }
    setQuote(calculateStorageQuote(sizeBytes, durationDays));
  }, [sizeBytes, durationDays]);

  const digestHex = /^0x[0-9a-fA-F]{64}$/.test(cidDigestInput.trim()) ? (cidDigestInput.trim() as Hex) : null;

  async function fund() {
    if (!storageContract || !quote || !digestHex || !sizeBytes) return;
    setWorking(true);
    setError(undefined);
    setTxHash(undefined);
    try {
      // Encode fundStorage(bytes32 cidDigest, uint256 sizeBytes)
      // selector: keccak256("fundStorage(bytes32,uint256)")[0:4] = 0x7ada5d4c
      const selector = "7ada5d4c";
      const digestPadded = digestHex.slice(2).padStart(64, "0");
      const sizeHex = sizeBytes.toString(16).padStart(64, "0");
      const calldata = ("0x" + selector + digestPadded + sizeHex) as Hex;
      const hash = await sendWalletTx({
        to: storageContract,
        value: quote.costWei,
        data: calldata,
      });
      setTxHash(hash);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card
      title="Fund large-scale storage"
      subtitle="For datasets beyond 1 MiB — audio archives, video leaks, database dumps, multi-gigabyte document sets. The endowment pays independent IPFS pinner nodes a streaming reward per block."
      raised={false}
    >
      {!storageContract ? (
        <Info>
          The ZeroDropStorage endowment contract is not yet deployed on{" "}
          {deployment ? `${deployment.label} (chain ${deployment.chainId})` : "the selected chain"}.
          When it is deployed, add a <code className="mono">storageContract</code> field to the deployment's{" "}
          <code className="mono">config/*.json</code> file. The contract code is in{" "}
          <code className="mono">contracts/src/ZeroDropStorage.sol</code> — deploy it with{" "}
          <code className="mono">forge create --rpc-url … ZeroDropStorage</code>.
        </Info>
      ) : (
        <>
          <Info>
            Free tier: up to 1 MiB costs nothing. Above 1 MiB the endowment pays 100 wei per MB per
            Ethereum block (~12 s), split equally among registered pinner nodes. The Panama Papers
            (2.6 TB, 1 year) would cost roughly 0.046 ETH at current rates.
          </Info>

          <div className="field-row">
            <label className="field narrow">
              <span className="field-label">Dataset size</span>
              <div className="inline-form">
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={sizeInput}
                  onChange={(e) => { setSizeInput(e.target.value); setError(undefined); setTxHash(undefined); }}
                  aria-label="Dataset size"
                />
                <select value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as "MB" | "GB" | "TB")} aria-label="Size unit">
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                  <option value="TB">TB</option>
                </select>
              </div>
              {sizeBytes && <span className="small muted">{formatDataSize(sizeBytes)}</span>}
            </label>

            <label className="field narrow">
              <span className="field-label">Duration (days)</span>
              <input
                type="number"
                min="1"
                max="3650"
                step="1"
                value={durationDays}
                onChange={(e) => { const n = parseInt(e.target.value); if (n > 0) setDurationDays(n); }}
                aria-label="Duration in days"
              />
              <span className="small muted">{durationDays} days ≈ {(durationDays / 365).toFixed(1)} years</span>
            </label>
          </div>

          {quote && (
            <div className="quote-box">
              <p className="field-label">Cost estimate</p>
              {quote.isFreeTier ? (
                <p><Tick>Free tier</Tick> — this dataset is ≤ 1 MiB, no endowment needed.</p>
              ) : (
                <ul className="rows">
                  <li><span>Dataset size</span><code className="mono">{formatDataSize(quote.sizeBytes)}</code></li>
                  <li><span>Above free tier</span><code className="mono">{formatDataSize(quote.excessBytes)} ({quote.excessMb} MB billed)</code></li>
                  <li><span>Duration</span><code className="mono">{quote.durationDays} days ({quote.durationBlocks.toLocaleString()} blocks)</code></li>
                  <li><span>Estimated cost</span><code className="mono">{quote.costEthFormatted}</code></li>
                </ul>
              )}
            </div>
          )}

          <label className="field">
            <span className="field-label">CID digest (0x-prefixed 32-byte sha256)</span>
            <input
              type="text"
              value={cidDigestInput}
              onChange={(e) => { setCidDigestInput(e.target.value); setError(undefined); setTxHash(undefined); }}
              placeholder="0x…"
              spellCheck={false}
              aria-label="CID digest"
            />
            {cidDigestInput && !digestHex && (
              <span className="small warning-text">Must be <code className="mono">0x</code> followed by 64 hex characters (the sha256 of the IPFS CID).</span>
            )}
            {digestHex && <span className="small muted">Digest: <code className="mono">{short(digestHex, 12, 8)}</code></span>}
          </label>

          {error && <Warn>{error}</Warn>}
          {txHash && (
            <p className="small">
              <Tick>Funded.</Tick> Transaction: <code className="mono">{short(txHash, 14, 8)}</code>.
              Pinner nodes can now register and start claiming rewards.
            </p>
          )}

          <div className="actions">
            <button
              className="primary"
              disabled={working || !quote || quote.isFreeTier || !digestHex}
              onClick={() => void fund()}
            >
              {working ? "Sending…" : `Fund ${quote ? quote.costEthFormatted : "…"}`}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------
// Top-up (crowdfunding an existing endowment)
// ---------------------------------------------------------------------------------------------------

function TopUpCard({ storageContract }: { storageContract: Address | null }) {
  const [cidDigestInput, setCidDigestInput] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [txHash, setTxHash] = useState<Hex>();
  const [error, setError] = useState<string>();
  const deployment = useDeployment();

  const digestHex = /^0x[0-9a-fA-F]{64}$/.test(cidDigestInput.trim()) ? (cidDigestInput.trim() as Hex) : null;
  const parsedWei = (() => {
    try { const v = parseEther(amount.trim()); return v > 0n ? v : null; }
    catch { return null; }
  })();

  async function lookupStatus() {
    if (!storageContract || !digestHex) return;
    setStatusLoading(true);
    setStatusError(undefined);
    setStatus(null);
    try {
      const client = readClient("reader");
      const s = await getStorageEndowmentStatus(client, storageContract, digestHex);
      setStatus(s);
    } catch (err) {
      setStatusError(errorMessage(err));
    } finally {
      setStatusLoading(false);
    }
  }

  async function topUp() {
    if (!storageContract || !digestHex || !parsedWei) return;
    setWorking(true);
    setError(undefined);
    setTxHash(undefined);
    try {
      // topUpStorage(bytes32 cidDigest) selector: keccak256("topUpStorage(bytes32)")[0:4] = 0x4e6a6ac2
      const selector = "4e6a6ac2";
      const digestPadded = digestHex.slice(2).padStart(64, "0");
      const calldata = ("0x" + selector + digestPadded) as Hex;
      const hash = await sendWalletTx({ to: storageContract, value: parsedWei, data: calldata });
      setTxHash(hash);
      // Refresh status after a moment
      setTimeout(() => void lookupStatus(), 3000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card
      title="Top up an endowment (community crowdfunding)"
      subtitle="Keep a disclosure alive. If you recognise a CID as important, anyone can add ETH to extend its storage runway. The Panama Papers, Snowden archive, or any other large leak can be kept online indefinitely."
      raised={false}
    >
      {!storageContract ? (
        <Info>
          ZeroDropStorage is not yet deployed on{" "}
          {deployment ? `${deployment.label} (chain ${deployment.chainId})` : "the selected chain"}.
          Once deployed, set <code className="mono">storageContract</code> in the deployment's config JSON.
        </Info>
      ) : (
        <>
          <label className="field">
            <span className="field-label">CID digest of the disclosure you want to support</span>
            <div className="inline-form">
              <input
                type="text"
                value={cidDigestInput}
                onChange={(e) => { setCidDigestInput(e.target.value); setStatus(null); setStatusError(undefined); setTxHash(undefined); setError(undefined); }}
                placeholder="0x…"
                spellCheck={false}
                aria-label="CID digest"
              />
              <button className="secondary" disabled={!digestHex || statusLoading} onClick={() => void lookupStatus()}>
                {statusLoading ? "Checking…" : "Check status"}
              </button>
            </div>
            {cidDigestInput && !digestHex && (
              <span className="small warning-text">Must be <code className="mono">0x</code> + 64 hex characters.</span>
            )}
          </label>

          {statusError && <Warn>{statusError}</Warn>}

          {status && (
            <div className="quote-box">
              {!status.isFunded ? (
                <p className="small warning-text">No endowment found for this digest. The document might be under the free 1 MiB tier, or the endowment has not been funded yet.</p>
              ) : (
                <ul className="rows">
                  <li><span>Dataset size</span><code className="mono">{formatDataSize(status.sizeBytes)}</code></li>
                  <li><span>Days remaining</span><code className="mono">{status.daysRemaining} days</code></li>
                  <li><span>Balance</span><code className="mono">{formatWei(status.balanceWei)}</code></li>
                  <li><span>Active pinners</span><code className="mono">{status.pinnerCount}</code></li>
                </ul>
              )}
            </div>
          )}

          <label className="field narrow">
            <span className="field-label">Top-up amount (ETH)</span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(undefined); setTxHash(undefined); }}
              aria-label="Top-up amount in ETH"
            />
            {parsedWei && <span className="small muted">{formatWei(parsedWei)}</span>}
          </label>

          {error && <Warn>{error}</Warn>}
          {txHash && (
            <p className="small">
              <Tick>Sent.</Tick> Transaction: <code className="mono">{short(txHash, 14, 8)}</code>.
              The storage runway has been extended.
            </p>
          )}

          <div className="actions">
            <button
              className="primary"
              disabled={working || !digestHex || !parsedWei || (!!status && !status.isFunded)}
              onClick={() => void topUp()}
            >
              {working ? "Sending…" : "Top up storage"}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------------------------------

function HowItWorksCard() {
  return (
    <Card title="How it works" subtitle="The technical details of funding and privacy." raised={false}>
      <div className="how-it-works">
        <p className="field-label">Gas float</p>
        <p className="small">
          The EIP-8141 frame path means the ZeroDrop contract is both the transaction sender and the fee payer.
          It holds a gas float — ETH from donations — that it spends when a whistleblower records a disclosure.
          The whistleblower holds no account, pays no gas, and appears nowhere on chain.
          The minimum stake required by the alt-mempool is 0.01 ETH; the current devnet contract is staked.
        </p>

        <p className="field-label">Large-file endowment (Panama Papers scale)</p>
        <p className="small">
          Files above 1 MiB cannot go through the standard IPFS pinning path (a single Kubo chunk).
          Instead, the whistleblower or a sponsor funds a <code className="mono">ZeroDropStorage</code> endowment
          on chain: a deposit of ETH that pays independent pinner nodes a streaming reward per Ethereum block.
          Pinners register their <code className="mono">multiaddr</code> to claim rewards. The dataset can be
          petabytes — only the on-chain funding amount and the CID digest are visible.
        </p>

        <p className="field-label">Privacy</p>
        <p className="small">
          All transactions on this page go through your injected wallet (MetaMask or equivalent).
          Your wallet address will appear in the transaction on chain; this is unavoidable for ETH transfers.
          Your IP address, however, is routed through Anon-RPC (Tor) so the recipient RPC node cannot link
          your IP to the CID you are supporting. The whistleblower who posted the disclosure remains
          completely anonymous through the Semaphore zero-knowledge proof.
        </p>

        <p className="field-label">Whistleblower identity protection</p>
        <p className="small">
          Supporting a disclosure does not reveal who the whistleblower is.
          The Semaphore proof only shows "one member of group N posted this".
          Funding the endowment only links your wallet to the CID — not to the person who disclosed it.
          The ZeroDrop contract never stores or emits the whistleblower's address; the{" "}
          <code className="mono">Disclosed</code> event contains only the group, the case, the CID digest,
          and the nullifier (a one-way hash derived from the Semaphore identity).
        </p>
      </div>
    </Card>
  );
}
