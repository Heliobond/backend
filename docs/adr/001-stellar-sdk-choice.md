# ADR-001: Use Stellar SDK for Soroban Contract Interaction

## Status

Accepted

## Context

The Heliobond backend needs to interact with Soroban smart contracts on the Stellar blockchain. Specifically, it must:

- Submit `update_impact_score` transactions to the ProjectRegistry contract
- Query contract state (e.g., `getTotalProjects`)
- Sign transactions with a server-side secret key
- Handle RPC connectivity, retries, and error recovery

The team evaluated options for Stellar/Soroban integration:

1. **@stellar/stellar-sdk** — Official Stellar JavaScript SDK with Soroban support
2. **soroban-client** — Legacy standalone Soroban client (deprecated)
3. **Custom RPC calls** — Direct HTTP/gRPC to Stellar RPC endpoints
4. **@stellar/stellar-sdk (Rust)** — Native Rust SDK via FFI

## Decision

Use `@stellar/stellar-sdk` v15 as the sole interface for all Soroban contract interactions.

### Rationale

- **Official support**: Maintained by the Stellar Development Foundation with regular updates
- **TypeScript-first**: Full type definitions included, integrates well with our TypeScript codebase
- **Comprehensive**: Handles transaction building, signing, submission, and polling in a single package
- **Active community**: Widely adopted, well-documented, and actively maintained
- **Testnet support**: Built-in network passphrase selection and RPC endpoint configuration

## Consequences

### Positive

- Single dependency for all blockchain interactions
- Type-safe contract calls with built-in XDR serialization
- Built-in transaction signing and submission with confirmation polling
- Seamless integration with our TypeScript/Node.js stack

### Negative

- Vendor lock-in to the official SDK (mitigated by Stellar's central role in the ecosystem)
- SDK updates may require migration work for breaking changes

### Neutral

- RPC endpoint configuration is centralized in `lib/stellar.ts`
- Transaction signing is isolated to `signAndSubmit()` for easy testing and key management
