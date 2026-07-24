# Load Testing

This directory contains [k6](https://k6.io/) load tests for the Heliobond backend API.

## Prerequisites

Install k6 on your machine:

```bash
# macOS
brew install k6

# Ubuntu / Debian
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Windows (via Chocolatey)
choco install k6
```

## Scenarios

| Scenario | VUs | Duration | Purpose |
|---|---|---|---|
| `smoke` | 1 | 30s | Verify endpoints are up and responding correctly |
| `average-load` | 20 | ~7m | Simulate typical production traffic |
| `stress` | 100 | ~10m | Find breaking points beyond normal capacity |
| `spike` | 200 (peak) | ~5.5m | Test resilience against sudden traffic surges |
| `graphql` | 10 | ~4m | Exercise the GraphQL endpoint under load |

## Running Tests

```bash
# Smoke test (fastest — run first)
npm run load-test:smoke

# Average load test
npm run load-test:average

# Stress test
npm run load-test:stress

# Spike test
npm run load-test:spike

# GraphQL test
npm run load-test:graphql

# Run against a custom URL
BASE_URL=https://staging.example.com npm run load-test:smoke
```

## Performance Baselines

Baselines are defined in [`config/baselines.json`](./config/baselines.json). These are the thresholds each scenario enforces:

| Endpoint group | p95 | p99 | Max error rate |
|---|---|---|---|
| `/health` | 100ms | 200ms | 1% |
| Public endpoints | 500ms | 1000ms | 1% |
| Admin endpoints | 800ms | 1500ms | 1% |
| GraphQL | 600ms | 1200ms | 1% |

## Reports

k6 prints a summary to the terminal after each run. To save results as JSON for further analysis:

```bash
k6 run --out json=load-tests/reports/results.json load-tests/scenarios/smoke.js
```

The `load-tests/reports/` directory is git-ignored to prevent committing large result files.

## CI Integration

The `.github/workflows/load-test.yml` workflow:

- Can be triggered manually via **Actions → Load Tests → Run workflow**, where you choose the scenario and target URL.
- Runs the smoke test automatically every night at 02:00 UTC.
- Uploads the JSON report as a workflow artifact (retained for 30 days).
