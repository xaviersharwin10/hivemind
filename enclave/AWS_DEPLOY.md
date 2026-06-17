# Deploying the HiveMind enclave to AWS Nitro

This is the HiveMind-specific runbook on top of the Nautilus template scripts
(`configure_enclave.sh`, `expose_enclave.sh`, `register_enclave.sh`,
`Makefile`). Everything below was prepared so it can be run top-to-bottom once
the AWS account is ready. App name / feature flag is **`hivemind`**.

## What's already wired for HiveMind
- App module: `src/nautilus-server/src/apps/hivemind/` (selected by the
  `hivemind` cargo feature → `ENCLAVE_APP=hivemind`).
- Outbound allowlist: `src/nautilus-server/src/apps/hivemind/allowed_endpoints.yaml`
  (just `relayer-staging.memory.walrus.xyz`; KMS/Secrets Manager added
  automatically by `configure_enclave.sh`).
- Secret model: `MemwalConfig::from_env()` reads **one** secret env var,
  `HIVEMIND_MEMWAL_SECRET`, as JSON `{account_id, delegate_key, server_url?}` —
  matching Nautilus' single-secret injection.
- Move verifier: `move/hivemind-app` (module `hivemind`, OTW `HIVEMIND`).

## 0. Prereqs
- AWS account (new accounts get ~$200 credit — covers enclave hours).
- A key pair in the target region: `export KEY_PAIR=<your-ec2-keypair-name>`
- `export REGION=us-east-1` (or your choice)
- Sui CLI logged in with a testnet address that has gas.

## 1. Create the secret (AWS Secrets Manager)
Pack the group's MemWal credentials as JSON. Use the values the bot issued for
the demo group (the delegate key is sensitive — paste it only here, never into
the repo):

```json
{
  "account_id": "0x74c056...",
  "delegate_key": "74b5e46e...",
  "server_url": "https://relayer-staging.memory.walrus.xyz"
}
```

`configure_enclave.sh` will prompt to create a new secret — pick **new**, give
it a name, and paste the JSON. Then tell it the env var name:

```bash
export API_ENV_VAR_NAME=HIVEMIND_MEMWAL_SECRET
```

## 2. Launch + configure the EC2 Nitro host
```bash
export ENCLAVE_APP=hivemind
./configure_enclave.sh
```
This launches a Nitro-enabled EC2 instance, configures traffic forwarding for
the allowlisted endpoints + KMS/Secrets Manager, and sets up the secret. SSH in
when it finishes.

## 3. Build + run the enclave (on the EC2 host)
```bash
make ENCLAVE_APP=hivemind            # builds out/nitro.eif (reproducible)
make run ENCLAVE_APP=hivemind        # or run-debug to attach a console
./expose_enclave.sh                  # vsock proxy: secret in, port 3000 out
```
Record the **PCRs** printed at build time (PCR0/1/2) — they go on-chain and are
what the Move verifier checks.

## 4. Publish the Move packages (once, from your machine)
```bash
# base enclave framework package
sui client publish move/enclave --gas-budget 200000000
#   → ENCLAVE_PACKAGE_ID

# HiveMind app package (registers the enclave config object)
sui client publish move/hivemind-app --gas-budget 200000000
#   → APP_PACKAGE_ID, and the created ENCLAVE_CONFIG_OBJECT_ID (Cap/Config)
```
Update the PCRs in the enclave config to match step 3 (the template exposes an
`update_pcrs` admin call; see `UsingNautilus.md`).

## 5. Register the running enclave on-chain
This fetches the live attestation from the enclave and verifies it on Sui,
binding the enclave's ephemeral public key to the config:

```bash
./register_enclave.sh \
  <ENCLAVE_PACKAGE_ID> \
  <APP_PACKAGE_ID> \
  <ENCLAVE_CONFIG_OBJECT_ID> \
  http://<EC2_PUBLIC_IP>:3000 \
  hivemind \
  HIVEMIND
```

## 6. Point the remote MCP at the enclave
On the remote-MCP host (Render/Fly/EC2), set:
```
ENCLAVE_URL=http://<EC2_PUBLIC_IP>:3000   # or a TLS front
ENCLAVE_PUBKEY=<registered enclave pubkey, hex>   # pin to the on-chain key
HIVEMIND_NAMESPACE=<group namespace, e.g. -5357824668>
SERVER_URL=https://<public mcp url>
STYTCH_DOMAIN=https://groovy-cycle-8931.customers.stytch.dev
STYTCH_PROJECT_ID=project-test-9eff4586-b6ee-49a3-adca-82cdb3ad7379
```
`ENCLAVE_PUBKEY` must be the key registered in step 5, not whatever the enclave
self-reports — that's the whole point of the attestation.

## 7. End-to-end check
- `curl http://<EC2_IP>:3000/get_attestation` returns a non-empty attestation.
- Remote MCP `/mcp` recall (with a valid Stytch token) returns `✓ attested by
  enclave (…verified)` — now backed by *real* Nitro hardware + on-chain
  registration instead of the local dev key.

## Notes
- Only `get_attestation` needs real Nitro hardware; the rest of the server runs
  anywhere, which is why the local loop was sufficient to prove correctness.
- Teardown: `nitro-cli terminate-enclave --all` then terminate the EC2 instance
  to stop billing.
