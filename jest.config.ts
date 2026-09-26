export default {
  transform: {
    // .js is included so ESM-only transitive deps of @stellar/stellar-sdk
    // (e.g. uint8array-extras) are transpiled to CommonJS by ts-jest.
    "^.+\\.[jt]sx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  // stellar-sdk v17 and its ESM deps (@exodus/bytes, uint8array-extras,
  // eventsource) ship untranspiled ESM, so they must not be ignored by the
  // default node_modules pattern.
  transformIgnorePatterns: [
    "node_modules/(?!(@stellar|@exodus|@noble|uint8array-extras|eventsource|smol-toml)/)",
  ],
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/__tests__/**"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov", "json-summary"],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50,
    },
  },
};
