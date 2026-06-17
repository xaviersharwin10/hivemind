# HiveMind enclave — live deployment (Sui testnet + AWS Nitro)

The confidential MCP is deployed and **verified end-to-end on real hardware**:
the enclave runs in an AWS Nitro Enclave, its Nitro attestation was verified
**on Sui**, and the on-chain `Enclave.pk` matches the running enclave's key.

## On-chain (Sui testnet)
| What | ID |
|---|---|
| `enclave` framework package | `0x8ecf22e78c90c3e32833d76d82415d7e4227ea370bec4efdad4c4830cbda9e49` |
| `app::hivemind` package | `0xa583af305a9edd07dbb3b67bceda94ee97a4b225f48c8e06a9a07d9ab5ef702b` |
| `EnclaveConfig<HIVEMIND>` (shared) | `0x70a1718eab2bc2dad180ef7268c5c013a98ae9155b755ae3b6b108e1c78b495a` |
| `Cap<HIVEMIND>` (admin) | `0xba260755c79a19d87836d1a62dcaca23b5adb0421b2ba95fed106f6636ccf413` |
| **`Enclave<HIVEMIND>` (shared, registered)** | `0xa57d7e3ff7ce8e161619dcb7ae21464c5a58a244b64a00a62177960404114345` |
| Bound enclave pubkey (`pk`) | `4dcae18b27ca91d8b6cb84840bc3edd7e10b05432f7bf01c270a4b31624116e2` |

## Enclave measurements (PCRs, on-chain in EnclaveConfig)
```
PCR0 = PCR1 = 4fa9458c7ef1970a896ac5a5a63ee4d0fdbd66b5d9ef918ceb3616117c565b60804aa6e6584096fdcb44d0552e2c1557
PCR2 =        21b9efbc184807662e966d34f390821309eeac6802309798826296bf3e8bec7c10edb30948c90ba67310f7b964fc500a
```

## AWS Nitro host
- Instance: `i-0ab82c85a95fb086b` (m5.xlarge, us-east-1)
- Enclave endpoint: `http://13.218.16.6:3000` (`/health_check`, `/get_attestation`, `/process_data`)
- MemWal credentials provisioned via AWS Secrets Manager (`hivemind-memwal`), injected
  over vsock as `HIVEMIND_MEMWAL_SECRET`; never on disk in the repo.

## Proven
- `/process_data` recall runs **inside the enclave**, reaching MemWal through the
  enclave's traffic forwarder, returning enclave-signed results.
- The remote MCP fetches the result and verifies the Ed25519 signature against the
  registered pubkey (Rust↔Move↔JS BCS layouts agree).
- `app::hivemind::verify_recall<HIVEMIND>(...)` can verify any recall response
  on-chain against the registered `Enclave` object.

> Note: the enclave's ephemeral `pk` regenerates each time the enclave process
> restarts, so `register_enclave` must be re-run (and `ENCLAVE_PUBKEY` updated)
> after any enclave restart. See [AWS_DEPLOY.md](AWS_DEPLOY.md).
