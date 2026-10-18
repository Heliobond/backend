import request from "supertest";
import express, { Express } from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { parse, validate, buildSchema, GraphQLError } from "graphql";
import {
  graphqlSchema,
  graphqlRoot,
  createGraphQLContext,
  DEFAULT_MAX_QUERY_DEPTH,
  DEFAULT_MAX_ALIASES,
  DEFAULT_MAX_ROOT_FIELDS,
  DEFAULT_MAX_QUERY_COMPLEXITY,
  getMaxQueryDepth,
  getMaxAliases,
  getMaxRootFields,
  getMaxQueryComplexity,
  isIntrospectionDisabled,
  createDepthLimitRule,
  createAliasLimitRule,
  createComplexityLimitRule,
  createIntrospectionControlRule,
  getGraphQLValidationRules,
} from "../graphql/schema";
import { clearApiKeys, generateApiKey } from "../lib/apiKeys";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
  updateImpactScore: jest.fn(),
}));
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

function buildTestApp(
  customOptions: Parameters<typeof getGraphQLValidationRules>[0] = {},
): Express {
  const app = express();
  app.use(express.json());

  app.all(
    "/graphql",
    createHandler({
      schema: graphqlSchema as any,
      rootValue: graphqlRoot,
      context: (req: any) => createGraphQLContext(req.raw) as any,
      validationRules: getGraphQLValidationRules(customOptions) as any,
    }),
  );

  return app;
}

describe("GraphQL Query Depth, Complexity & Introspection Hardening", () => {
  const originalEnv = process.env;
  let consumerKey: string;
  let testApp: Express;

  beforeAll(() => {
    process.env.ADMIN_API_KEY = "admin-secret-key";
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GRAPHQL_MAX_DEPTH;
    delete process.env.GRAPHQL_MAX_ALIASES;
    delete process.env.GRAPHQL_MAX_ROOT_FIELDS;
    delete process.env.GRAPHQL_MAX_COMPLEXITY;
    delete process.env.GRAPHQL_INTROSPECTION_DISABLED;
    delete process.env.GRAPHQL_INTROSPECTION_ENABLED;

    clearApiKeys();
    const key = generateApiKey("GraphQL Consumer");
    consumerKey = key.key;

    jest.clearAllMocks();
    (registry.getTotalProjects as jest.Mock).mockResolvedValue(5);
    (iot.getSolarData as jest.Mock).mockImplementation((id: number) => ({
      power_output_kw: 500 + id * 10,
      efficiency_pct: 80,
      max_power_kw: 1000,
    }));
    (iot.getSatelliteData as jest.Mock).mockImplementation((id: number) => ({
      forest_density_pct: 70,
      ndvi_score: 0.7,
    }));
    (scoring.computeScores as jest.Mock).mockImplementation(() => ({
      credit_quality: 85,
      green_impact: 75,
    }));

    testApp = buildTestApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // Query Depth & Selection Boundaries
  // =========================================================================
  describe("Query Depth & Selection Boundaries", () => {
    const depths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    it.each(depths)("evaluates query depth boundary against configured maxDepth=%i", (limit) => {
      // Build a nested query of depth 4
      const doc = parse(`
        query {
          projects {
            solar {
              power_output_kw
            }
          }
        }
      `);
      const rule = createDepthLimitRule(limit);
      const errors = validate(graphqlSchema, doc, [rule]);

      if (limit < 3) {
        // depth is 3: projects (1) -> solar (2) -> power_output_kw (3)
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].message).toContain(
          `Query depth of 3 exceeds maximum allowed depth of ${limit}`,
        );
      } else {
        expect(errors.length).toBe(0);
      }
    });

    const aliasCounts = [0, 1, 2, 5, 10, 15, 16, 20, 25];
    it.each(aliasCounts)(
      "evaluates alias cap boundary with %i aliases against maxAliases=15",
      (count) => {
        const aliasLines = Array.from({ length: count }, (_, i) => `p${i}: id`).join("\n");
        const queryStr =
          count === 0
            ? `query { project(id: "1") { id } }`
            : `query { project(id: "1") { ${aliasLines} } }`;

        const doc = parse(queryStr);
        const rule = createAliasLimitRule(15, 20);
        const errors = validate(graphqlSchema, doc, [rule]);

        if (count > 15) {
          expect(errors.length).toBe(1);
          expect(errors[0].message).toContain(
            `Query contains ${count} aliases, exceeding maximum allowed limit of 15`,
          );
        } else {
          expect(errors.length).toBe(0);
        }
      },
    );

    const rootFieldCounts = [1, 2, 5, 9, 10, 11, 15, 20];
    it.each(rootFieldCounts)(
      "evaluates root field cap boundary with %i root fields against maxRootFields=10",
      (count) => {
        const rootLines = Array.from(
          { length: count },
          (_, i) => `f${i}: project(id: "${i + 1}") { id }`,
        ).join("\n");
        const queryStr = `query { ${rootLines} }`;

        const doc = parse(queryStr);
        const rule = createAliasLimitRule(100, 10);
        const errors = validate(graphqlSchema, doc, [rule]);

        if (count > 10) {
          expect(errors.length).toBe(1);
          expect(errors[0].message).toContain(
            `Query contains ${count} root fields, exceeding maximum allowed limit of 10`,
          );
        } else {
          expect(errors.length).toBe(0);
        }
      },
    );

    describe("Environment Variable Parsing & Clamping", () => {
      const depthEnvCases = [
        { env: "10", expected: 10 },
        { env: "1", expected: 1 },
        { env: "0", expected: DEFAULT_MAX_QUERY_DEPTH },
        { env: "-5", expected: DEFAULT_MAX_QUERY_DEPTH },
        { env: "abc", expected: DEFAULT_MAX_QUERY_DEPTH },
        { env: "   ", expected: DEFAULT_MAX_QUERY_DEPTH },
        { env: "", expected: DEFAULT_MAX_QUERY_DEPTH },
      ];
      it.each(depthEnvCases)(
        "parses GRAPHQL_MAX_DEPTH='$env' -> $expected",
        ({ env, expected }) => {
          process.env.GRAPHQL_MAX_DEPTH = env;
          expect(getMaxQueryDepth()).toBe(expected);
        },
      );

      const aliasEnvCases = [
        { env: "25", expected: 25 },
        { env: "0", expected: 0 },
        { env: "-1", expected: DEFAULT_MAX_ALIASES },
        { env: "xyz", expected: DEFAULT_MAX_ALIASES },
        { env: "  30  ", expected: 30 },
      ];
      it.each(aliasEnvCases)(
        "parses GRAPHQL_MAX_ALIASES='$env' -> $expected",
        ({ env, expected }) => {
          process.env.GRAPHQL_MAX_ALIASES = env;
          expect(getMaxAliases()).toBe(expected);
        },
      );

      const rootEnvCases = [
        { env: "8", expected: 8 },
        { env: "0", expected: DEFAULT_MAX_ROOT_FIELDS },
        { env: "-2", expected: DEFAULT_MAX_ROOT_FIELDS },
        { env: "invalid", expected: DEFAULT_MAX_ROOT_FIELDS },
      ];
      it.each(rootEnvCases)(
        "parses GRAPHQL_MAX_ROOT_FIELDS='$env' -> $expected",
        ({ env, expected }) => {
          process.env.GRAPHQL_MAX_ROOT_FIELDS = env;
          expect(getMaxRootFields()).toBe(expected);
        },
      );

      const complexityEnvCases = [
        { env: "1000", expected: 1000 },
        { env: "50", expected: 50 },
        { env: "0", expected: DEFAULT_MAX_QUERY_COMPLEXITY },
        { env: "-100", expected: DEFAULT_MAX_QUERY_COMPLEXITY },
        { env: "none", expected: DEFAULT_MAX_QUERY_COMPLEXITY },
      ];
      it.each(complexityEnvCases)(
        "parses GRAPHQL_MAX_COMPLEXITY='$env' -> $expected",
        ({ env, expected }) => {
          process.env.GRAPHQL_MAX_COMPLEXITY = env;
          expect(getMaxQueryComplexity()).toBe(expected);
        },
      );
    });
  });

  // =========================================================================
  // Operation Combinatorics & Flag Permutations
  // =========================================================================
  describe("Operation Combinatorics & Flag Permutations", () => {
    const introspectionMatrix = [
      {
        nodeEnv: "production",
        disabledFlag: undefined,
        enabledFlag: undefined,
        expectedDisabled: true,
      },
      {
        nodeEnv: "production",
        disabledFlag: "false",
        enabledFlag: "true",
        expectedDisabled: false,
      },
      { nodeEnv: "production", disabledFlag: "true", enabledFlag: "true", expectedDisabled: true },
      {
        nodeEnv: "development",
        disabledFlag: undefined,
        enabledFlag: undefined,
        expectedDisabled: false,
      },
      {
        nodeEnv: "development",
        disabledFlag: "true",
        enabledFlag: undefined,
        expectedDisabled: true,
      },
      { nodeEnv: "test", disabledFlag: undefined, enabledFlag: undefined, expectedDisabled: false },
      { nodeEnv: "test", disabledFlag: "true", enabledFlag: undefined, expectedDisabled: true },
      { nodeEnv: "staging", disabledFlag: undefined, enabledFlag: "true", expectedDisabled: false },
    ];

    it.each(introspectionMatrix)(
      "resolves introspection policy for NODE_ENV=$nodeEnv, disabled=$disabledFlag, enabled=$enabledFlag -> $expectedDisabled",
      ({ nodeEnv, disabledFlag, enabledFlag, expectedDisabled }) => {
        process.env.NODE_ENV = nodeEnv;
        if (disabledFlag !== undefined) process.env.GRAPHQL_INTROSPECTION_DISABLED = disabledFlag;
        else delete process.env.GRAPHQL_INTROSPECTION_DISABLED;
        if (enabledFlag !== undefined) process.env.GRAPHQL_INTROSPECTION_ENABLED = enabledFlag;
        else delete process.env.GRAPHQL_INTROSPECTION_ENABLED;

        expect(isIntrospectionDisabled()).toBe(expectedDisabled);
      },
    );

    it("validates named operations alongside anonymous operations", () => {
      const namedDoc = parse(`query GetProjects { projects { id } }`);
      const anonDoc = parse(`{ projects { id } }`);
      const mutationDoc = parse(
        `mutation UpdateScore { updateProjectScores(id: "1", creditQuality: 90, greenImpact: 85) { id } }`,
      );

      const rules = getGraphQLValidationRules({ maxDepth: 4 });
      expect(validate(graphqlSchema, namedDoc, rules).length).toBe(0);
      expect(validate(graphqlSchema, anonDoc, rules).length).toBe(0);
      expect(validate(graphqlSchema, mutationDoc, rules).length).toBe(0);
    });

    it("correctly calculates depth across nested fragments", () => {
      const doc = parse(`
        fragment Leaf on SolarData {
          power_output_kw
        }
        fragment Mid on Project {
          solar {
            ...Leaf
          }
        }
        query {
          projects {
            ...Mid
          }
        }
      `);
      // Depth: projects (1) -> solar (2) -> power_output_kw (3)
      const ruleExceeded = createDepthLimitRule(2);
      const errors = validate(graphqlSchema, doc, [ruleExceeded]);
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain("Query depth of 3 exceeds maximum allowed depth of 2");

      const ruleAllowed = createDepthLimitRule(3);
      expect(validate(graphqlSchema, doc, [ruleAllowed]).length).toBe(0);
    });

    it("correctly handles inline fragments inside selections", () => {
      const doc = parse(`
        query {
          projects {
            ... on Project {
              solar {
                ... on SolarData {
                  power_output_kw
                }
              }
            }
          }
        }
      `);
      // Depth remains 3 because inline fragments are type conditions on existing objects
      const ruleExceeded = createDepthLimitRule(2);
      expect(validate(graphqlSchema, doc, [ruleExceeded]).length).toBe(1);

      const ruleAllowed = createDepthLimitRule(3);
      expect(validate(graphqlSchema, doc, [ruleAllowed]).length).toBe(0);
    });
  });

  // =========================================================================
  // AST Structures & Host Variations
  // =========================================================================
  describe("AST Structures & Host Variations", () => {
    const introspectionQueries = [
      { name: "direct __schema", query: `{ __schema { queryType { name } } }` },
      { name: "direct __type", query: `{ __type(name: "Project") { name } }` },
      { name: "aliased schema", query: `{ s: __schema { types { name } } }` },
      {
        name: "fragment wrapped __schema",
        query: `fragment F on Query { __schema { queryType { name } } } query { ...F }`,
      },
      {
        name: "inline fragment __schema",
        query: `query { ... on Query { __schema { queryType { name } } } }`,
      },
    ];

    it.each(introspectionQueries)("blocks $name when introspection is disabled", ({ query }) => {
      const doc = parse(query);
      const rule = createIntrospectionControlRule(true);
      const errors = validate(graphqlSchema, doc, [rule]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toBe(
        "GraphQL introspection is disabled in production environments",
      );
    });

    it.each(introspectionQueries)("allows $name when introspection is enabled", ({ query }) => {
      const doc = parse(query);
      const rule = createIntrospectionControlRule(false);
      const errors = validate(graphqlSchema, doc, [rule]);
      expect(errors.length).toBe(0);
    });

    it("ALWAYS allows __typename queries even when introspection is disabled", () => {
      const doc = parse(`
        query {
          projects {
            __typename
            id
            solar {
              __typename
              power_output_kw
            }
          }
        }
      `);
      const rule = createIntrospectionControlRule(true);
      const errors = validate(graphqlSchema, doc, [rule]);
      expect(errors.length).toBe(0);
    });
  });

  // =========================================================================
  // Complexity Budget & Negative Controls
  // =========================================================================
  describe("Complexity Budget & Negative Controls", () => {
    it("computes field complexity for small valid queries well within budget", () => {
      const doc = parse(`
        query {
          project(id: "1") {
            id
            credit_quality
            green_impact
          }
        }
      `);
      // Cost: project (1) + id (1) + credit_quality (1) + green_impact (1) = 4
      const rule = createComplexityLimitRule(10);
      expect(validate(graphqlSchema, doc, [rule]).length).toBe(0);
    });

    it("rejects alias fan-out multiplier queries exceeding complexity budget", () => {
      // 10 aliased projects queries each requesting 50 items
      const aliased = Array.from(
        { length: 8 },
        (_, i) => `
        a${i}: projects(limit: 50) {
          id
          solar { power_output_kw }
        }
      `,
      ).join("\n");

      const doc = parse(`query { ${aliased} }`);
      const rule = createComplexityLimitRule(300);
      const errors = validate(graphqlSchema, doc, [rule]);
      expect(errors.length).toBe(1);
      expect(errors[0].message).toMatch(
        /Query complexity of \d+ exceeds maximum allowed complexity of 300/,
      );
    });

    it("proves that rejected queries NEVER execute database or iot resolvers", async () => {
      const badQuery = `
        query {
          a1: projects { id }
          a2: projects { id }
          a3: projects { id }
          a4: projects { id }
          a5: projects { id }
          a6: projects { id }
        }
      `;

      // Build app with maxRootFields = 3
      const strictApp = buildTestApp({ maxRootFields: 3 });

      const res = await request(strictApp)
        .post("/graphql")
        .set("X-API-Key", consumerKey)
        .send({ query: badQuery });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toContain(
        "Query contains 6 root fields, exceeding maximum allowed limit of 3",
      );
      // Resolvers must NEVER have been called
      expect(registry.getTotalProjects).not.toHaveBeenCalled();
      expect(iot.getSolarData).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Stress Testing & HTTP Integration
  // =========================================================================
  describe("Stress Testing & HTTP Integration", () => {
    it("safely handles cyclic fragment references without infinite recursion", () => {
      // GraphQL's document validator catches cycle, but our custom rules must also not crash
      const doc = parse(`
        fragment A on Project {
          ...B
        }
        fragment B on Project {
          ...A
        }
        query {
          project(id: "1") {
            ...A
          }
        }
      `);
      const depthRule = createDepthLimitRule(10);
      const aliasRule = createAliasLimitRule(10, 10);
      const complexityRule = createComplexityLimitRule(100);

      expect(() => {
        validate(graphqlSchema, doc, [depthRule, aliasRule, complexityRule]);
      }).not.toThrow();
    });

    it("rejects deeply nested query via HTTP supertest before resolver execution", async () => {
      // Create a depth-7 query (projects -> solar -> power_output_kw is depth 3; let's simulate deep invalid nesting)
      const strictApp = buildTestApp({ maxDepth: 2 });
      const query = `
        query {
          projects {
            solar {
              power_output_kw
            }
          }
        }
      `;

      const res = await request(strictApp)
        .post("/graphql")
        .set("X-API-Key", consumerKey)
        .send({ query });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toContain(
        "Query depth of 3 exceeds maximum allowed depth of 2",
      );
      expect(res.body.data).toBeUndefined();
    });

    it("rejects alias fan-out beyond cap via HTTP supertest", async () => {
      const strictApp = buildTestApp({ maxAliases: 3 });
      const query = `
        query {
          project(id: "1") {
            a1: id
            a2: credit_quality
            a3: green_impact
            a4: id
          }
        }
      `;

      const res = await request(strictApp)
        .post("/graphql")
        .set("X-API-Key", consumerKey)
        .send({ query });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toContain(
        "Query contains 4 aliases, exceeding maximum allowed limit of 3",
      );
    });

    it("blocks schema introspection in production mode via HTTP", async () => {
      const prodApp = buildTestApp({ disableIntrospection: true });
      const query = `
        query {
          __schema {
            queryType {
              name
            }
          }
        }
      `;

      const res = await request(prodApp)
        .post("/graphql")
        .set("X-API-Key", consumerKey)
        .send({ query });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toBe(
        "GraphQL introspection is disabled in production environments",
      );
    });

    it("allows schema introspection in development mode via HTTP", async () => {
      const devApp = buildTestApp({ disableIntrospection: false });
      const query = `
        query {
          __schema {
            queryType {
              name
            }
          }
        }
      `;

      const res = await request(devApp)
        .post("/graphql")
        .set("X-API-Key", consumerKey)
        .send({ query });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.__schema.queryType.name).toBe("Query");
    });

    it("handles rapid burst of 25 malicious fan-out and deep queries concurrently", async () => {
      const strictApp = buildTestApp({ maxDepth: 2, maxAliases: 2 });
      const attackQueries = Array.from({ length: 25 }, (_, i) => ({
        query:
          i % 2 === 0
            ? `query { projects { solar { power_output_kw } } }`
            : `query { project(id: "1") { a1: id a2: id a3: id } }`,
      }));

      const results = await Promise.all(
        attackQueries.map((body) =>
          request(strictApp).post("/graphql").set("X-API-Key", consumerKey).send(body),
        ),
      );

      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.errors).toBeDefined();
        expect(res.body.errors.length).toBeGreaterThan(0);
      }
    });

    const limitComplexityMatrix = [
      { limit: 1, expectedMultiplier: 1 },
      { limit: 2, expectedMultiplier: 2 },
      { limit: 5, expectedMultiplier: 5 },
      { limit: 10, expectedMultiplier: 10 },
      { limit: 20, expectedMultiplier: 20 },
      { limit: 25, expectedMultiplier: 25 },
      { limit: 50, expectedMultiplier: 50 },
      { limit: 75, expectedMultiplier: 75 },
      { limit: 100, expectedMultiplier: 100 },
      { limit: 150, expectedMultiplier: 100 }, // clamped to 100
      { limit: 200, expectedMultiplier: 100 }, // clamped to 100
    ];
    it.each(limitComplexityMatrix)(
      "computes list field complexity with limit=$limit clamped to multiplier $expectedMultiplier",
      ({ limit, expectedMultiplier }) => {
        const doc = parse(`
          query {
            projects(limit: ${limit}) {
              id
            }
          }
        `);
        // Cost: 1 (projects) + multiplier * 1 (id) = 1 + multiplier
        const expectedCost = 1 + expectedMultiplier;
        const ruleAllowed = createComplexityLimitRule(expectedCost);
        expect(validate(graphqlSchema, doc, [ruleAllowed]).length).toBe(0);

        const ruleExceeded = createComplexityLimitRule(expectedCost - 1);
        const errors = validate(graphqlSchema, doc, [ruleExceeded]);
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain(
          `Query complexity of ${expectedCost} exceeds maximum allowed complexity of ${expectedCost - 1}`,
        );
      },
    );

    const combinatorialPairs = [
      { isDeep: false, aliases: 0, maxD: 2, maxA: 5, shouldPass: true },
      { isDeep: true, aliases: 1, maxD: 3, maxA: 5, shouldPass: true },
      { isDeep: true, aliases: 2, maxD: 2, maxA: 5, shouldPass: false }, // depth 3 exceeds maxD 2
      { isDeep: false, aliases: 6, maxD: 5, maxA: 5, shouldPass: false }, // aliases 6 exceeds maxA 5
      { isDeep: false, aliases: 5, maxD: 5, maxA: 5, shouldPass: true },
      { isDeep: true, aliases: 10, maxD: 5, maxA: 10, shouldPass: true },
      { isDeep: true, aliases: 11, maxD: 5, maxA: 10, shouldPass: false }, // aliases 11 exceeds maxA 10
      { isDeep: true, aliases: 0, maxD: 2, maxA: 10, shouldPass: false }, // depth 3 exceeds maxD 2
      { isDeep: false, aliases: 3, maxD: 3, maxA: 4, shouldPass: true },
      { isDeep: false, aliases: 4, maxD: 3, maxA: 4, shouldPass: true },
      { isDeep: false, aliases: 5, maxD: 3, maxA: 4, shouldPass: false }, // aliases 5 exceeds maxA 4
      { isDeep: true, aliases: 0, maxD: 3, maxA: 0, shouldPass: true },
      { isDeep: true, aliases: 1, maxD: 3, maxA: 0, shouldPass: false }, // aliases 1 exceeds maxA 0
      { isDeep: false, aliases: 1, maxD: 2, maxA: 1, shouldPass: true },
      { isDeep: false, aliases: 2, maxD: 2, maxA: 1, shouldPass: false }, // aliases 2 exceeds maxA 1
    ];
    it.each(combinatorialPairs)(
      "combinatorial evaluation: isDeep=$isDeep, aliases=$aliases (limits: d=$maxD, a=$maxA) -> pass=$shouldPass",
      ({ isDeep, aliases, maxD, maxA, shouldPass }) => {
        const selection = isDeep ? "solar { power_output_kw }" : "id";
        const aliasLines = Array.from({ length: aliases }, (_, i) => `a${i}: id`).join("\n");
        const query = `
          query {
            project(id: "1") {
              ${selection}
              ${aliasLines}
            }
          }
        `;
        const doc = parse(query);
        const rules = [createDepthLimitRule(maxD), createAliasLimitRule(maxA, 20)];
        const errors = validate(graphqlSchema, doc, rules);
        if (shouldPass) {
          expect(errors.length).toBe(0);
        } else {
          expect(errors.length).toBeGreaterThan(0);
        }
      },
    );

    const mutationDepthMatrix = [
      { depthLimit: 1, shouldPass: false },
      { depthLimit: 2, shouldPass: true },
      { depthLimit: 3, shouldPass: true },
    ];
    it.each(mutationDepthMatrix)(
      "enforces depth limits on mutation operations with maxDepth=$depthLimit -> pass=$shouldPass",
      ({ depthLimit, shouldPass }) => {
        const doc = parse(`
          mutation {
            updateProjectScores(id: "1", creditQuality: 80, greenImpact: 90) {
              id
            }
          }
        `);
        // Depth: updateProjectScores (1) -> id (2) = depth 2
        const errors = validate(graphqlSchema, doc, [createDepthLimitRule(depthLimit)]);
        if (shouldPass) {
          expect(errors.length).toBe(0);
        } else {
          expect(errors.length).toBe(1);
          expect(errors[0].message).toContain(
            "Query depth of 2 exceeds maximum allowed depth of 1",
          );
        }
      },
    );

    const multiOpMatrix = [
      { op1Valid: true, op2Valid: true, expectedErrors: 0 },
      { op1Valid: true, op2Valid: false, expectedErrors: 1 },
      { op1Valid: false, op2Valid: false, expectedErrors: 2 },
    ];
    it.each(multiOpMatrix)(
      "validates multi-operation document: op1Valid=$op1Valid, op2Valid=$op2Valid -> errors=$expectedErrors",
      ({ op1Valid, op2Valid, expectedErrors }) => {
        const op1 = op1Valid
          ? `query Q1 { project(id: "1") { id } }`
          : `query Q1 { project(id: "1") { solar { power_output_kw } } }`;
        const op2 = op2Valid
          ? `query Q2 { project(id: "2") { id } }`
          : `query Q2 { project(id: "2") { solar { power_output_kw } } }`;

        const doc = parse(`${op1}\n${op2}`);
        // With maxDepth=2, depth of solar.power_output_kw is 3
        const errors = validate(graphqlSchema, doc, [createDepthLimitRule(2)]);
        expect(errors.length).toBe(expectedErrors);
      },
    );

    const directiveCases = [
      { directive: "@include(if: true)", shouldPass: true },
      { directive: "@skip(if: false)", shouldPass: true },
    ];
    it.each(directiveCases)(
      "handles queries with directive $directive under depth limit rules",
      ({ directive }) => {
        const doc = parse(`
          query {
            project(id: "1") {
              id ${directive}
            }
          }
        `);
        const errors = validate(graphqlSchema, doc, [createDepthLimitRule(5)]);
        expect(errors.length).toBe(0);
      },
    );

    it("attaches AST node references to reported GraphQLError instances", () => {
      const doc = parse(`
        query BadDepth {
          projects {
            solar {
              power_output_kw
            }
          }
        }
      `);
      const errors = validate(graphqlSchema, doc, [createDepthLimitRule(2)]);
      expect(errors.length).toBe(1);
      const err = errors[0];
      expect(err).toBeInstanceOf(GraphQLError);
      expect(err.nodes).toBeDefined();
      expect(err.nodes?.length).toBeGreaterThan(0);
      expect(err.locations).toBeDefined();
    });
  });
});
