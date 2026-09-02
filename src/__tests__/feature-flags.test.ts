import request from "supertest";
import express from "express";
import {
  loadFlags,
  evaluateFlag,
  evaluateFlags,
  evaluateVariant,
  listFlags,
  getFlag,
  getEvaluations,
  getFlagAnalytics,
  mergeFlags,
  loadFlagsFromString,
  type FlagSet,
  type EvaluationContext,
} from "../lib/feature-flags";
import { featureFlagContext, registerFlagRoutes } from "../middleware/featureFlags";
import { errorHandler } from "../middleware/errors";
import * as featureFlagsModule from "../lib/feature-flags";

const baseCtx: EvaluationContext = {
  user_id: "wallet_alice",
  environment: "test",
};

const testFlags: FlagSet = {
  "new-dashboard": {
    enabled: true,
    rollout_percentage: 100,
  },
  "dark-mode": {
    enabled: true,
    rollout_percentage: 50,
  },
  "beta-api": {
    enabled: false,
    rollout_percentage: 0,
  },
  "gradual-release": {
    enabled: true,
    rollout_percentage: 25,
  },
  "env-staging-only": {
    enabled: true,
    rollout_percentage: 100,
    env_overrides: {
      production: { enabled: false },
      staging: { enabled: true },
    },
  },
  "user-bob-only": {
    enabled: true,
    rollout_percentage: 100,
    user_overrides: {
      wallet_bob: true,
      wallet_charlie: true,
    },
  },
  "depends-on-dashboard": {
    enabled: true,
    rollout_percentage: 100,
    depends_on: ["new-dashboard"],
  },
  "broken-dep": {
    enabled: true,
    rollout_percentage: 100,
    depends_on: ["beta-api"], // beta-api is disabled
  },
  "ab-test-pricing": {
    enabled: true,
    rollout_percentage: 100,
    variants: {
      control: "price_v1",
      variant_a: "price_v2",
      variant_b: "price_v3",
    },
  },
};

describe("feature flags", () => {
  beforeEach(() => {
    loadFlags(testFlags);
  });

  describe("loadFlags / listFlags / getFlag", () => {
    it("loads flags and lists them", () => {
      const all = listFlags();
      expect(Object.keys(all).length).toBe(Object.keys(testFlags).length);
    });

    it("retrieves a single flag definition", () => {
      const flag = getFlag("new-dashboard");
      expect(flag).toBeDefined();
      expect(flag!.enabled).toBe(true);
    });

    it("returns undefined for unknown flag", () => {
      expect(getFlag("nonexistent")).toBeUndefined();
    });

    it("merges flags without replacing existing ones", () => {
      mergeFlags({ "extra-flag": { enabled: true, rollout_percentage: 100 } });
      expect(getFlag("extra-flag")).toBeDefined();
      expect(getFlag("new-dashboard")).toBeDefined();
    });
  });

  describe("loadFlagsFromString", () => {
    it("parses and loads from JSON string", () => {
      const json = JSON.stringify({ "from-json": { enabled: true, rollout_percentage: 100 } });
      const loaded = loadFlagsFromString(json);
      expect(loaded["from-json"]).toBeDefined();
      expect(getFlag("from-json")).toBeDefined();
    });
  });

  describe("evaluateFlag", () => {
    it("returns false for unknown flags", () => {
      const result = evaluateFlag("nonexistent", baseCtx);
      expect(result.value).toBe(false);
      expect(result.reason).toBe("flag_not_found");
    });

    it("returns true for fully enabled flags", () => {
      const result = evaluateFlag("new-dashboard", baseCtx);
      expect(result.value).toBe(true);
      expect(result.reason).toBe("enabled");
    });

    it("returns false for disabled flags", () => {
      const result = evaluateFlag("beta-api", baseCtx);
      expect(result.value).toBe(false);
      expect(result.reason).toBe("disabled");
    });

    it("applies env overrides — disabled in production", () => {
      const prodCtx: EvaluationContext = { user_id: "wallet_alice", environment: "production" };
      const result = evaluateFlag("env-staging-only", prodCtx);
      expect(result.value).toBe(false);
      expect(result.reason).toBe("env_override_disabled");
    });

    it("applies env overrides — enabled in staging", () => {
      const stagingCtx: EvaluationContext = { user_id: "wallet_alice", environment: "staging" };
      const result = evaluateFlag("env-staging-only", stagingCtx);
      expect(result.value).toBe(true);
      expect(result.reason).toBe("env_override_enabled");
    });

    it("respects user overrides — bob is included", () => {
      const bobCtx: EvaluationContext = { user_id: "wallet_bob", environment: "test" };
      const result = evaluateFlag("user-bob-only", bobCtx);
      expect(result.value).toBe(true);
      expect(result.reason).toBe("user_override_enabled");
    });

    it("respects user overrides — alice falls through to default", () => {
      // "user-bob-only" is enabled with 100% rollout, so alice should get enabled
      const result = evaluateFlag("user-bob-only", baseCtx);
      expect(result.value).toBe(true);
      expect(result.reason).toBe("enabled");
    });

    it("satisfies dependencies when parent is enabled", () => {
      const result = evaluateFlag("depends-on-dashboard", baseCtx);
      expect(result.value).toBe(true);
      expect(result.reason).toBe("enabled");
    });

    it("fails dependencies when parent is disabled", () => {
      const result = evaluateFlag("broken-dep", baseCtx);
      expect(result.value).toBe(false);
      expect(result.reason).toBe("dependency_not_met");
    });

    it("percentage rollout assigns users deterministically", () => {
      // Run 1000 users through 25% rollout — should get roughly 250
      let included = 0;
      for (let i = 0; i < 1000; i++) {
        const ctx: EvaluationContext = { user_id: `user_${i}`, environment: "test" };
        if (evaluateFlag("gradual-release", ctx).value) included++;
      }
      expect(included).toBeGreaterThan(150);
      expect(included).toBeLessThan(350);
    });

    it("same user always gets same result for percentage rollout", () => {
      const ctx: EvaluationContext = { user_id: "wallet_alice", environment: "test" };
      const r1 = evaluateFlag("gradual-release", ctx);
      const r2 = evaluateFlag("gradual-release", ctx);
      expect(r1.value).toBe(r2.value);
    });
  });

  describe("evaluateVariant", () => {
    it("returns variant for enabled flags with variants", () => {
      const result = evaluateVariant("ab-test-pricing", baseCtx);
      expect(result.enabled).toBe(true);
      expect(["price_v1", "price_v2", "price_v3"]).toContain(result.variant);
    });

    it("same user gets same variant", () => {
      const v1 = evaluateVariant("ab-test-pricing", baseCtx);
      const v2 = evaluateVariant("ab-test-pricing", baseCtx);
      expect(v1.variant).toBe(v2.variant);
    });

    it("different users may get different variants", () => {
      const variants = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const ctx: EvaluationContext = { user_id: `user_${i}`, environment: "test" };
        const v = evaluateVariant("ab-test-pricing", ctx);
        variants.add(String(v.variant));
      }
      expect(variants.size).toBeGreaterThan(1);
    });
  });

  describe("evaluateFlags (batch)", () => {
    it("evaluates multiple flags at once", () => {
      const results = evaluateFlags(["new-dashboard", "beta-api", "nonexistent"], baseCtx);
      expect(results["new-dashboard"].value).toBe(true);
      expect(results["beta-api"].value).toBe(false);
      expect(results["nonexistent"].value).toBe(false);
    });
  });

  describe("analytics", () => {
    it("records evaluations", () => {
      evaluateFlag("new-dashboard", baseCtx);
      evaluateFlag("beta-api", baseCtx);
      const evals = getEvaluations({ flag: "new-dashboard" });
      expect(evals.length).toBeGreaterThan(0);
    });

    it("provides analytics summary", () => {
      evaluateFlag("new-dashboard", baseCtx);
      evaluateFlag("beta-api", baseCtx);
      const summary = getFlagAnalytics();
      expect(summary.total_evaluations).toBeGreaterThan(0);
      expect(summary.unique_flags).toBeGreaterThan(0);
      expect(summary.by_flag["new-dashboard"]).toBeDefined();
    });
  });

  describe("Express middleware", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(featureFlagContext);

      app.get("/test-ff", (req, res) => {
        const isOn = (res.locals as any).isFeatureEnabled("new-dashboard");
        const isOff = (res.locals as any).isFeatureEnabled("beta-api");
        res.json({ newDashboard: isOn, betaApi: isOff });
      });

      app.get("/test-variant", (req, res) => {
        const v = (res.locals as any).getFeatureVariant("ab-test-pricing");
        res.json(v);
      });
    });

    it("attaches feature flag helpers via middleware", async () => {
      const res = await request(app).get("/test-ff");
      expect(res.body.newDashboard).toBe(true);
      expect(res.body.betaApi).toBe(false);
    });

    it("passes user context from x-user-id header", async () => {
      const res = await request(app).get("/test-variant").set("x-user-id", "wallet_bob");
      expect(res.body.enabled).toBe(true);
      expect(res.body.variant).toBeDefined();
    });
  });

  describe("admin API routes", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      registerFlagRoutes(app);
      app.use(errorHandler);
    });

    it("GET /flags returns all flags with evaluations", async () => {
      const res = await request(app).get("/flags");
      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThan(0);
      expect(res.body.flags["new-dashboard"]).toBeDefined();
      expect(res.body.flags["new-dashboard"].evaluation.value).toBe(true);
    });

    it("GET /flags/:name evaluates a specific flag", async () => {
      const res = await request(app).get("/flags/new-dashboard");
      expect(res.status).toBe(200);
      expect(res.body.value).toBe(true);
      expect(res.body.flag).toBe("new-dashboard");
    });

    it("GET /flags/:name returns flag_not_found for unknown", async () => {
      const res = await request(app).get("/flags/nonexistent");
      expect(res.status).toBe(200);
      expect(res.body.reason).toBe("flag_not_found");
    });

    it("POST /flags/load replaces all flags", async () => {
      const res = await request(app)
        .post("/flags/load")
        .send({ "loaded-flag": { enabled: true, rollout_percentage: 100 } });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(getFlag("loaded-flag")).toBeDefined();
      expect(getFlag("new-dashboard")).toBeUndefined();
    });

    it("POST /flags/load delegates internal error to errorHandler", async () => {
      const loadSpy = jest.spyOn(featureFlagsModule, "loadFlags").mockImplementationOnce(() => {
        throw new Error("Internal failure: secret_key_leaked_db_error");
      });

      const res = await request(app)
        .post("/flags/load")
        .send({ "loaded-flag": { enabled: true, rollout_percentage: 100 } });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      });
      expect(JSON.stringify(res.body)).not.toContain("secret_key_leaked_db_error");

      loadSpy.mockRestore();
    });

    it("POST /flags/merge adds to existing flags", async () => {
      const res = await request(app)
        .post("/flags/merge")
        .send({ "merged-flag": { enabled: true, rollout_percentage: 100 } });
      expect(res.status).toBe(200);
      expect(getFlag("merged-flag")).toBeDefined();
      // Original flags should still exist
      expect(getFlag("new-dashboard")).toBeDefined();
    });

    it("POST /flags/merge delegates internal error to errorHandler", async () => {
      const mergeSpy = jest.spyOn(featureFlagsModule, "mergeFlags").mockImplementationOnce(() => {
        throw new Error("Internal failure: secret_key_leaked_db_error");
      });

      const res = await request(app)
        .post("/flags/merge")
        .send({ "merged-flag": { enabled: true, rollout_percentage: 100 } });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      });
      expect(JSON.stringify(res.body)).not.toContain("secret_key_leaked_db_error");

      mergeSpy.mockRestore();
    });

    it("GET /flags/analytics returns analytics summary", async () => {
      // Evaluate a flag first to ensure there's data in the log
      evaluateFlag("new-dashboard", baseCtx);
      evaluateFlag("beta-api", baseCtx);
      const res = await request(app).get("/flags/analytics");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("total_evaluations");
      expect(typeof res.body.total_evaluations).toBe("number");
      expect(res.body.total_evaluations).toBeGreaterThanOrEqual(2);
      expect(res.body).toHaveProperty("unique_flags");
      expect(res.body).toHaveProperty("by_flag");
    });
  });
});
