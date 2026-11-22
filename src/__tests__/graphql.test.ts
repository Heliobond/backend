import request from "supertest";
import express, { Express } from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { graphqlSchema, graphqlRoot, createGraphQLContext } from "../graphql/schema";
import { validateGraphQLDocument } from "../graphql/security";
import * as registry from "../lib/registry";
import * as iot from "../routes/iot";
import * as scoring from "../lib/scoring";
import { clearApiKeys, generateApiKey } from "../lib/apiKeys";
import { errorHandler } from "../middleware/errors";

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
  updateImpactScore: jest.fn(),
}));
jest.mock("../routes/iot");
jest.mock("../lib/scoring");

function buildApp(): Express {
  const app = express();
  app.use(express.json());

  app.all(
    "/graphql",
    createHandler({
      // Cast needed: ts-jest resolves graphql's GraphQLSchema nominally distinct
      // from the one in graphql-http's handler types despite identical paths.
      schema: graphqlSchema as any,
      rootValue: graphqlRoot,
      context: (req: any) => createGraphQLContext(req.raw) as any,
      validate: validateGraphQLDocument,
    }),
  );

  app.use(errorHandler);
  return app;
}

describe("GraphQL API Integration", () => {
  let app: Express;
  let consumerKey: string;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.ADMIN_API_KEY = "admin-secret-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.env.ADMIN_API_KEY = "admin-secret-key";
  });

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    clearApiKeys();

    const key = generateApiKey("GraphQL Consumer");
    consumerKey = key.key;

    (registry.getTotalProjects as jest.Mock).mockResolvedValue(2);
    (registry.updateImpactScore as jest.Mock).mockResolvedValue("tx-graphql");
    (iot.getSolarData as jest.Mock).mockImplementation((id: number) => ({
      power_output_kw: 600,
      efficiency_pct: 82,
      max_power_kw: 1000,
      timestamp: Date.now(),
    }));
    (iot.getSatelliteData as jest.Mock).mockImplementation((id: number) => ({
      forest_density_pct: 75,
      ndvi_score: 0.75,
      timestamp: Date.now(),
    }));
    (scoring.computeScores as jest.Mock).mockImplementation(() => ({
      credit_quality: 88,
      green_impact: 78,
    }));
  });

  it("should reject queries without a valid API key", async () => {
    const query = `
      query {
        projects {
          id
        }
      }
    `;

    const res = await request(app).post("/graphql").send({ query });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("Unauthorized");
  });

  it("should allow querying projects with a consumer API key", async () => {
    const query = `
      query {
        projects {
          id
          credit_quality
          green_impact
          solar {
            power_output_kw
          }
        }
      }
    `;

    const res = await request(app).post("/graphql").set("X-API-Key", consumerKey).send({ query });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.projects.length).toBe(2);
    expect(res.body.data.projects[0].credit_quality).toBe(88);
  });

  it("should allow querying portfolioSummary", async () => {
    const query = `
      query {
        portfolioSummary {
          total_projects
          avg_credit_quality
          avg_green_impact
          total_power_output_kw
        }
      }
    `;

    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer admin-secret-key`)
      .send({ query });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.portfolioSummary).toEqual({
      total_projects: 2,
      avg_credit_quality: 88,
      avg_green_impact: 78,
      total_power_output_kw: 1200,
    });
  });

  it("should reject mutations for consumer keys", async () => {
    const query = `
      mutation {
        updateProjectScores(id: "1", creditQuality: 90, greenImpact: 80) {
          id
        }
      }
    `;

    const res = await request(app).post("/graphql").set("X-API-Key", consumerKey).send({ query });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toContain("Unauthorized: Admin access required");
  });

  it("should allow mutations for admin key", async () => {
    const query = `
      mutation {
        updateProjectScores(id: "1", creditQuality: 90, greenImpact: 80) {
          id
          credit_quality
          green_impact
        }
      }
    `;

    const res = await request(app)
      .post("/graphql")
      .set("Authorization", "Bearer admin-secret-key")
      .send({ query });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateProjectScores.id).toBe("1");
    expect(registry.updateImpactScore).toHaveBeenCalledWith(1, 90, 80);
  });

  // ── Query safety limits ────────────────────────────────────────────────────

  it("rejects queries deeper than GRAPHQL_MAX_DEPTH before execution", async () => {
    process.env.GRAPHQL_MAX_DEPTH = "2";
    const query = `
      query {
        projects {
          solar {
            power_output_kw
          }
        }
      }
    `;

    const res = await request(app).post("/graphql").set("X-API-Key", consumerKey).send({ query });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors[0].message).toContain("depth 3");
    expect(res.body.errors[0].message).toContain("maximum allowed depth of 2");
    expect(iot.getSolarData).not.toHaveBeenCalled();
  });

  it("rejects queries over GRAPHQL_MAX_COMPLEXITY before execution", async () => {
    process.env.GRAPHQL_MAX_COMPLEXITY = "3";
    const query = `
      query {
        projects {
          id
          credit_quality
          green_impact
        }
      }
    `;

    const res = await request(app).post("/graphql").set("X-API-Key", consumerKey).send({ query });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors[0].message).toContain("complexity 4");
    expect(res.body.errors[0].message).toContain("maximum allowed complexity of 3");
    expect(registry.getTotalProjects).not.toHaveBeenCalled();
  });

  it("rejects alias fan-out beyond the root field cap", async () => {
    const selections = Array.from(
      { length: 21 },
      (_, index) => `p${index}: projects(limit: 1) { id }`,
    ).join("\n");
    const query = `query { ${selections} }`;

    const res = await request(app).post("/graphql").set("X-API-Key", consumerKey).send({ query });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors[0].message).toContain("21 root fields/aliases");
    expect(res.body.errors[0].message).toContain("maximum of 20");
    expect(registry.getTotalProjects).not.toHaveBeenCalled();
  });

  it("disables introspection in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.GRAPHQL_ALLOW_INTROSPECTION;

    const query = `
      query {
        __schema {
          queryType {
            name
          }
        }
      }
    `;

    const res = await request(app).post("/graphql").set("X-API-Key", consumerKey).send({ query });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors[0].message).toContain("introspection");
    expect(res.body.errors[0].extensions.code).toBe("GRAPHQL_INTROSPECTION_DISABLED");
  });

  it("allows introspection in non-production environments", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.GRAPHQL_ALLOW_INTROSPECTION;

    const query = `
      query {
        __schema {
          queryType {
            name
          }
        }
      }
    `;

    const res = await request(app).post("/graphql").set("X-API-Key", consumerKey).send({ query });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.__schema.queryType.name).toBe("Query");
  });
});
