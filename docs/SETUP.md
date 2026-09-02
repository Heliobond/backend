# Development Setup Guide

Comprehensive guide for new developers to set up and run the Heliobond backend locally.

## Prerequisites

- [Node.js](https://nodejs.org/) v20 or later
- [Bun](https://bun.sh) (`curl -fsSLh https://bun.sh/install | bash`)
- [Git](https://git-scm.com/)
- A Stellar secret key (for signing transactions on testnet)
- A Soroban contract address for the ProjectRegistry

## Installation

```bash
# Clone the repository
git clone https://github.com/Heliobond/backend.git
cd backend

# Install dependencies
bun install
```

## Environment Configuration

```bash
# Create your local environment file
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Required: Stellar secret key (starts with S...)
ADMIN_SECRET_KEY=S...

# Required: Soroban ProjectRegistry contract address
PROJECT_REGISTRY_CONTRACT_ID=...
```
All other variables have sensible defaults for local development.

### Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|----------|---------------------------------------------------------------------------------------------------------|
| `STELLAR_NETWORK` | No | `testnet` | `testnet` or `mainnet` |
| `ADMIN_SECRET_KEY` | Yes | -- | Stellar secret key for signing transactions |
| `PROJECT_REGISTRY_CONTRACT_ID` | Yes | -- | Soroban contract address |
| `RPC_URL` | No | `https://soroban-testnet.stellar.org` | Stellar RPC endpoint |
| `DB_HOST` | No | `localhost` | PostgreSQL host (required for staging/production) |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_NAME` | No | env-specific | PostgreSQL database name (defaults: `heliobond_dev` development, `heliobond_test` test; required for staging/production) |
| `DB_USER` | No | `postgres` | PostgreSQL user (required for staging/production) |
| `DB_PASSWORD` | No | -- | PostgreSQL password |
| `PORT` | No | `3001` | HTTP port |
| `FRONTEND_URL` | No | `http://localhost:3000` | CORS origin |
| `ADMIN_API_KEY` | No | -- | Bearer token for admin endpoints (dev mode if unset) |
| `WS_AUTH_TOKEN` | No | -- | WebSocket auth token (falls back to ADMIN_API_KEY) |
| `ADMIN_API_KEY` | No | — | Bearer token for admin endpoints (dev mode if unset) |
| `WS_AUTH_TOKEN` | Prod | — | `/ws` bearer token (`Authorization: Bearer`); required in production, no `?token=`, no ADMIN_API_KEY fallback |

## Running Locally

```bash
# Development mode (ts-node with hot reload)
bun run dev

# Verify the server is running
curl http://localhost:3001/health
```

The server starts on port 3001 by default. The development mode includes:
- Hourly score update cron job
- 5-minute event indexer cron job
- WebSocket server on the same port
- GraphQL playground at `/graphql-playground`
- Swagger UI at `/docs`

## Running Tests

```bash
# Run the full test suite
bun run test

# Run tests with coverage report
bun run test:coverage
```

## Code Quality

```bash
# Lint source files
bun run lint

# Auto-fix lint issues
bun run lint:fix

# Format code with Prettier
bun run format

# Check formatting without modifying files
bun run format:check

# TypeScript type checking
bun run typecheck

# Full quality check (lint + typecheck)
bun run lint && bun run typecheck
```

## Build

```bash
# Compile TypeScript to JavaScript
bun run build

# Run the production build
bun start
```

## Load Testing

The project includes k6 load testing scenarios:

```bash
# Smoke test
bun run load-test:smoke

# Average load test
bun run load-test:average

# Stress test
bun run load-test:stress

# Spike test
bun run load-test:spike

# GraphQL load test
bun run load-test:graphql
```

## Project Structure

```
backend/
├ src/
│  ├__tests__/        # Jest test files
│ ├ graphql/         # GraphQL schema and resolvers
─ ├ grpc/             # gRPC server and proto definitions
│ ├ lib/              # Core business logic
│   ├ scoring.ts    # Score computation
│    ├ stellar.ts    # Stellar RPC client
│   ├ registry.ts   # Soroban contract calls
│   ├ ...
│ ├ middleware/        # Express middleware
│ ├ proto/            # Protocol buffer definitions
│ ├ routes/           # Express route handlers
│ ├ index.ts          # Application entry point
├ load-tests/          # k6 load testing scenarios
│ ├ .github/workflows/    # CI/CD pipelines
│ ├ package.json
│ ├ tsconfig.json
│ ├ jest.config.ts
▀▀
## Common Issues

### "ADMIN_SECRET_KEY is required"

The server requires a valid Stellar secret key to sign Soroban transactions. Generate one for testnet using the Stellar CLI:

```bash
stellar keys generate my-key
```

### Port already in use

Change the port in `.env`:

```bash
PORT=3002
```

### CORS errors

Ensure `FRONTEND_URL` in `.env` matches your frontend's origin (e.g., `http://localhost:3000`).

### TypeScript compilation errors

Run type checking to see detailed errors:

```bash
bun run typecheck
```

### Tests failing after pulling latest changes

Reinstall dependencies:

```bash
rm -rf node_modules bun.lock
bun install
```

## API Exploration

Once the server is running:

- *Swagger UI*: http://localhost:3001/docs
- *GraphQL Playground*: http://localhost:3001/graphql-playground
- *Health Check*: http://localhost:3001/health
- *OpenAPI Spec*: http://localhost:3001/docs.json

## Git Workflow

1. Create a feature branch from `main`
2. Make changes with descriptive commits
3. Run lint and typecheck before pushing
4. Open a PR against main
5. CI will run build and tests automatically
