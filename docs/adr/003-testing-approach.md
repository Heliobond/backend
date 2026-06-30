# ADR-003: Use Jest with ts-jest for Testing

## Status

Accepted

## Context

The backend needs a testing framework that supports:

- TypeScript source files without a separate compilation step
- Unit testing of pure functions (scoring, validation)
- Integration testing of HTTP routes (with Supertest)
- Mocking of external dependencies (Stellar RPC, database)
- Code coverage reporting
- CI integration with GitHub Actions

Options evaluated:

1. **Jest + ts-jest** — Full-featured test framework with TypeScript support
2. **Vitest** — Modern, Vite-native test runner
3. **Mocha + Chai** — Traditional Node.js testing stack
4. **Node.js test runner** — Built-in test runner (experimental)

## Decision

Use Jest with ts-jest for all testing.

### Rationale

- **TypeScript out of the box**: ts-jest transforms TypeScript files directly, no build step needed
- **Batteries included**: Assertions, mocking, coverage, watch mode, and parallel execution built in
- **Supertest integration**: Seamless HTTP route testing with Express
- **CI-friendly**: Widely supported in GitHub Actions, detailed coverage reports
- **Snapshot testing**: Useful for API response shape validation
- **Large ecosystem**: Extensive plugin and matcher community

### Configuration

```typescript
// jest.config.ts
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/__tests__/**"],
  coverageThresholds: {
    global: { branches: 50, functions: 50, lines: 50, statements: 50 },
  },
};
```

## Consequences

### Positive

- No separate TypeScript compilation for tests
- Built-in code coverage with configurable thresholds
- Parallel test execution for fast CI pipelines
- Rich assertion library with custom matchers
- Watch mode for rapid development feedback

### Negative

- ts-jest adds overhead compared to native test runners
- Jest's module resolution can occasionally differ from runtime behavior

### Neutral

- Test files are co-located in `src/__tests__/` directories
- Coverage reports generated in text, lcov, and JSON formats
- Supertest used for all HTTP endpoint integration tests
