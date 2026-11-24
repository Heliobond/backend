# Creator Onboarding & Transaction Preparation

This guide documents the integration requirements and lifecycle for unsigned onboarding transactions returned by the Heliobond backend.

## Overview

The Heliobond backend never stores, holds, or accesses private keys for creators or whitelisters. Instead, it generates **unsigned XDR transactions** containing the exact smart contract invocation parameters (`set_whitelist` and `create_project`).

Because these transactions are built with initial `BASE_FEE` limits and no pre-computed footprint, **wallets and clients must simulate and assemble the transactions before signing and submitting them to the Stellar network.**

---

## Transaction Preparation Contract

Endpoints that return unsigned transactions (`GET /v1/creators/applications/:id/create-project-tx` and admin `PATCH /v1/admin/creators/applications/:id`) include explicit preparation contract metadata:

```json
{
  "application_id": "8dd5380b-42bb-4214-8f36-2a3607bb9e71",
  "project_id": null,
  "metadata_hash": "a1b2c3...",
  "metadata_uri": "ipfs://...",
  "maturity_date": 2000000000,
  "unsigned_xdr": "AAAAAg...",
  "signed": false,
  "prepared": false,
  "preparation": {
    "prepared": false,
    "simulation_required": true,
    "resource_assembly_required": true,
    "authorization_required": true,
    "signing_required": true,
    "steps": [
      "simulateTransaction",
      "assembleTransaction",
      "signTransaction",
      "sendTransaction"
    ],
    "instructions": "This transaction is unsigned and unprepared. Before signing, the wallet or client must simulate the transaction via Soroban RPC (simulateTransaction) and assemble the authorization footprint and resource fees (assembleTransaction or prepareTransaction), sign with the source account secret key, and submit via sendTransaction."
  }
}
```

---

## Client Integration Steps

Every client or wallet integrating with Heliobond onboarding must take the returned XDR through four sequential steps:

```
[ Unsigned XDR ] ──► 1. simulateTransaction() ──► 2. assembleTransaction() ──► 3. sign() ──► 4. sendTransaction()
```

### 1. Simulate
Call Soroban RPC `simulateTransaction(tx)` to calculate gas/resource limits, storage footprint, and required authorization entries.

### 2. Assemble
Call `rpc.assembleTransaction(tx, simulationResponse)` (or `server.prepareTransaction(tx)`) to generate the prepared transaction populated with resource fees and the Soroban data footprint.

### 3. Sign
Sign the assembled transaction with the source account's private key (`Keypair` or hardware wallet).

### 4. Submit
Submit the signed transaction to the Stellar network via `server.sendTransaction(signedTx)`.

---

## Complete TypeScript Client Example

See [`src/examples/creatorOnboardingClient.ts`](../src/examples/creatorOnboardingClient.ts) for the reference implementation:

```typescript
import { Keypair, TransactionBuilder, rpc, Networks } from "@stellar/stellar-sdk";

async function submitOnboardingTx(unsignedXdr: string, creatorKeypair: Keypair, rpcUrl: string) {
  const server = new rpc.Server(rpcUrl);
  const networkPassphrase = Networks.TESTNET;

  // 1. Parse unsigned transaction
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);

  // 2. Simulate transaction via Soroban RPC
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  // 3. Assemble resources and footprint
  const preparedTx = rpc.assembleTransaction(tx, sim).build();

  // 4. Sign with creator's keypair
  preparedTx.sign(creatorKeypair);

  // 5. Submit to network
  const result = await server.sendTransaction(preparedTx);
  return result;
}
```
