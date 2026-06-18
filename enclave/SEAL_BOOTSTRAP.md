# Provisioning the enclave delegate key via Seal (attestation-gated)

This replaces "put the delegate key in AWS Secrets Manager" with "encrypt it so
ONLY the registered, attested HiveMind enclave can decrypt it." The operator can
hold the ciphertext and still never read the key. Run this once per enclave build
(PCRs), after the enclave is registered on-chain.

Pieces already in the repo:
- Enclave bootstrap endpoints (`apps/hivemind/seal.rs`, host-only `:3001`):
  `init_seal_key_load`, `complete_seal_key_load`, `provision_delegate_key`.
- Seal config `apps/hivemind/seal_config.yaml` (key servers + their pubkeys + the policy package id).
- On-chain policy `move/hivemind-app/sources/seal_policy.move` (`app::seal_policy::seal_approve` over `Enclave<HIVEMIND>`).
- The plaintext = the **stable enclave delegate private key** (hex) — the one whose
  address is authorized on each group's MemWalAccount.

## Prereqs
- Seal CLI installed (`cargo install --git https://github.com/MystenLabs/seal seal-cli`, or see Seal docs).
- hivemind-app published **with `seal_policy`** → note `APP_PKG`.
- `apps/hivemind/seal_config.yaml` → set `package_id: <APP_PKG>` (rebuild the enclave so it's baked in; PCRs change → re-register).
- Enclave running (`hivemind` feature) and registered on-chain → note `ENCLAVE_OBJECT_ID` + `INITIAL_SHARED_VERSION`.

## 1. Encrypt the delegate key (anywhere, off the enclave)
```bash
# id is the fixed single-secret id the policy expects: 0x00
seal-cli encrypt-hex \
  --package-id <APP_PKG> \
  --id 00 \
  --threshold 2 \
  <ENCLAVE_DELEGATE_PRIVATE_KEY_HEX> \
  <KEY_SERVER_OBJECT_ID_1> <KEY_SERVER_OBJECT_ID_2>
#   → ENCRYPTED_OBJECT (hex). Safe to store anywhere (e.g. in S3/Secrets Manager) —
#     it's useless outside the attested enclave.
```

## 2. Two-phase key load (on the EC2 host — it has internet; the enclave does not)
```bash
# a) ask the enclave to start a key load for this registered enclave object
REQ=$(curl -s localhost:3001/admin/init_seal_key_load \
  -H 'content-type: application/json' \
  -d '{"enclave_object_id":"<ENCLAVE_OBJECT_ID>","initial_shared_version":<INITIAL_SHARED_VERSION>}' \
  | jq -r .encoded_request)

# b) relay the FetchKeyRequest to the Seal key servers (host has internet)
RESP=$(seal-cli fetch-keys --request "$REQ")   # → seal_responses (hex)

# c) hand the responses back; enclave decrypts + caches the Seal keys in memory
curl -s localhost:3001/admin/complete_seal_key_load \
  -H 'content-type: application/json' -d "{\"seal_responses\":\"$RESP\"}"
```

## 3. Provision the delegate key into enclave memory
```bash
curl -s localhost:3001/admin/provision_delegate_key \
  -H 'content-type: application/json' -d '{"encrypted_object":"<ENCRYPTED_OBJECT>"}'
#   → {"status":"OK"} — recall() now uses the Seal-provisioned key. No
#     HIVEMIND_DELEGATE_KEY env / plaintext secret needed anymore.
```

## 4. Authorize the enclave delegate on each group (owner-signed, one-time per group)
The enclave signs MemWal recalls with the stable enclave delegate address
(`0x0aba86be9899f0f1c192367fee04763acd903bab78b89c6a2bd596ce5842b278`). For the
relayer to accept a recall for a group, that address must be in the group's
MemWalAccount delegate list — added by the **owner** via `add_delegate_key`
(the "enable claude.ai" approval; wired into onboarding for new groups).

## Notes
- The three enclave keys (ephemeral, Seal wallet, ElGamal) live only in enclave
  memory; the delegate key is recovered only after a successful attestation-gated
  fetch, so a stop/start requires re-running steps 2–3 (the bootstrap), same as
  re-registration.
- `seal-cli` subcommand names/flags may differ by version — see the Seal CLI docs.
