export default {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/__tests__/**"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov", "json-summary"],
  coverageThresholds: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50,
    },
  },
};
