# Devnet status

Result of probing the public alt-mempool devnet from the development machine, with normal TLS verification. The probe never disables verification; to read the certificate dates it opens a bare handshake that sends no request.

**Verdict: not reachable from this machine at the time below. Nothing was sent to the devnet. No transaction, deployment or simulation has happened there.**

## Run

- Time (UTC, this machine's clock): `2026-11-05T21:27:52Z`
- Command: `pnpm tsx scripts/check-devnet.ts`
- Endpoints (from `docs.altmempool.wtf/guides/devnet`, read 2026-11-06): execution RPC `https://altmempool.forshtat.com`, sidecar `https://altmempool.forshtat.com/rpc`, second sidecar `https://altmempoolgateway.forshtat.com/rpc`, expected chain id 1337 (0x539)

Output, verbatim:

```
checked at 2026-11-05T21:27:53.305Z (this machine's clock), expected chain 1337

execution RPC (ethrex)
  https://altmempool.forshtat.com
  TLS: certificate is NOT YET VALID (verification failed; no request was sent)
       certificate notBefore: 2026-11-06T05:31:33.000Z  (Nov  6 05:31:33 2026 GMT)
       certificate notAfter:  2027-02-04T05:31:32.000Z
       this machine's clock:  2026-11-05T21:27:53.305Z
       the certificate becomes valid in 8.1 h by this machine's clock (do not work around it with -k / NODE_TLS_REJECT_UNAUTHORIZED=0)

sidecar /rpc (primary)
  https://altmempool.forshtat.com/rpc
  TLS: certificate is NOT YET VALID (verification failed; no request was sent)
       certificate notBefore: 2026-11-06T05:31:33.000Z  (Nov  6 05:31:33 2026 GMT)
       certificate notAfter:  2027-02-04T05:31:32.000Z
       this machine's clock:  2026-11-05T21:27:53.305Z
       the certificate becomes valid in 8.1 h by this machine's clock (do not work around it with -k / NODE_TLS_REJECT_UNAUTHORIZED=0)

sidecar gateway [informational]
  https://altmempoolgateway.forshtat.com/rpc
  TLS: certificate is NOT YET VALID (verification failed; no request was sent)
       certificate notBefore: 2026-11-06T05:33:56.000Z  (Nov  6 05:33:56 2026 GMT)
       certificate notAfter:  2027-02-04T05:33:55.000Z
       this machine's clock:  2026-11-05T21:27:53.305Z
       the certificate becomes valid in 8.1 h by this machine's clock (do not work around it with -k / NODE_TLS_REJECT_UNAUTHORIZED=0)

NOT REACHABLE: see the lines above
exit 1
```

## Independent confirmation of the certificate dates

`openssl s_client` handshakes (no request sent) at 2026-11-05T21:27:57Z:

| Host | notBefore | notAfter | Issuer |
|---|---|---|---|
| `altmempool.forshtat.com` | Nov  6 05:31:33 2026 GMT | Feb  4 05:31:32 2027 GMT | Let's Encrypt (YE1) |
| `altmempoolgateway.forshtat.com` | Nov  6 05:33:56 2026 GMT | Feb  4 05:33:55 2027 GMT | Let's Encrypt (YE2) |
| `explorer.altmempool.wtf` | Oct 19 08:55:32 2026 GMT | Jan 17 08:55:31 2027 GMT | Let's Encrypt (YR2) |

`curl https://altmempool.forshtat.com` (without `-k`) fails with `SSL certificate problem: certificate is not yet valid`.

## Reading

- The certificates for the two devnet hosts become valid about 8 hours after this probe, by this machine's clock. Either this machine's clock is behind, or the certificates were issued with a start time in the future. We did not establish which, and we did not change the clock or disable verification.
- Re-run `pnpm tsx scripts/check-devnet.ts` after 2026-11-06 05:31:33 UTC. It exits 0 only when the execution RPC and the sidecar `/rpc` both answer `eth_chainId` with 0x539.
- The extra read-only calls the script makes once reachable (block number, code at the documented staking registry, `skandha_config`) have only been exercised against a local stub server, not against the real devnet.
- Everything that depends on the devnet is therefore **not yet done**: `evidence/txs.md` section 2, the canonical rejection (`evidence/canonical-rejection.md`), and the sidecar admission question (`sidecar/README.md`).
