import request from "supertest";
import express, { Express } from "express";

jest.mock("../lib/registry", () => ({
  projectExists: jest.fn().mockImplementation(async (id: number) => {
    // Projects 1 through 10 exist, others do not
    return id >= 1 && id <= 10;
  }),
  getTotalProjects: jest.fn().mockResolvedValue(10),
}));

import comparisonRouter from "../routes/comparison";
import dashboardRouter from "../routes/dashboard";
import { errorHandler, notFoundHandler } from "../middleware/errors";
import { projectExists } from "../lib/registry";

const mockedExists = projectExists as jest.Mock;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/comparison", comparisonRouter);
  app.use("/v1/dashboard", dashboardRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("Comparison and Dashboard Existence Validation Suite (#930)", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedExists.mockImplementation(async (id: number) => id >= 1 && id <= 10);
    app = buildApp();
  });

  describe("Boundary and Range Checks", () => {
    it("handles lowest valid project ID (1)", async () => {
      const res = await request(app).get("/v1/comparison?ids=1").expect(200);
      expect(res.body.projects).toHaveLength(1);
      expect(res.body.projects[0].id).toBe(1);
      expect(res.body.summary.highest_combined).toBe(res.body.projects[0].combined_score);
    });

    it("handles highest valid project ID in range (10)", async () => {
      const res = await request(app).get("/v1/comparison?ids=10").expect(200);
      expect(res.body.projects).toHaveLength(1);
      expect(res.body.projects[0].id).toBe(10);
    });

    it("rejects first ID outside valid range (11) with 404", async () => {
      const res = await request(app).get("/v1/comparison?ids=11").expect(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 11 not found");
    });

    it("rejects large project ID (999999) with 404", async () => {
      const res = await request(app).get("/v1/comparison?ids=999999").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 999999 not found");
    });

    it("rejects max boundary project ID (2147483647) with 404", async () => {
      const res = await request(app).get("/v1/comparison?ids=2147483647").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 2147483647 not found");
    });

    it("validates up to max allowed comparison batch (20 valid IDs)", async () => {
      mockedExists.mockImplementation(async (id: number) => id >= 1 && id <= 25);
      const ids = Array.from({ length: 20 }, (_, i) => i + 1).join(",");
      const res = await request(app).get(`/v1/comparison?ids=${ids}`).expect(200);
      expect(res.body.projects).toHaveLength(20);
      expect(res.body.summary.avg_credit_quality).toBeGreaterThan(0);
    });

    it("rejects batch exceeding max limit (21 IDs) with 400 before registry query", async () => {
      const ids = Array.from({ length: 21 }, (_, i) => i + 1).join(",");
      const res = await request(app).get(`/v1/comparison?ids=${ids}`).expect(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(res.body.error.message).toContain("Cannot compare more than 20 projects");
      expect(mockedExists).not.toHaveBeenCalled();
    });
  });

  describe("Combinatorial ID Positions in List", () => {
    it("rejects when invalid ID is at head of list", async () => {
      const res = await request(app).get("/v1/comparison?ids=99,1,2").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 99 not found");
    });

    it("rejects when invalid ID is in middle of list", async () => {
      const res = await request(app).get("/v1/comparison?ids=1,99,2").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 99 not found");
    });

    it("rejects when invalid ID is at tail of list", async () => {
      const res = await request(app).get("/v1/comparison?ids=1,2,99").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 99 not found");
    });

    it("reports first invalid ID deterministically when multiple are invalid", async () => {
      const res = await request(app).get("/v1/comparison?ids=91,92,93").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 91 not found");
    });

    it("reports first invalid ID in mixed list with multiple invalid entries", async () => {
      const res = await request(app).get("/v1/comparison?ids=1,500,2,600").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 500 not found");
    });
  });

  describe("Ranking Endpoints Validation", () => {
    const criteriaList = [
      "combined_score",
      "credit_quality",
      "green_impact",
      "power_output_kw",
      "efficiency_pct",
      "forest_density_pct",
      "ndvi_score",
    ];

    for (const criteria of criteriaList) {
      it(`ranks successfully for valid IDs with criteria=${criteria}`, async () => {
        const res = await request(app)
          .get(`/v1/comparison/ranking?ids=1,2,3&criteria=${criteria}`)
          .expect(200);
        expect(res.body.criteria).toBe(criteria);
        expect(res.body.rankings).toHaveLength(3);
        expect(res.body.rankings[0].rank).toBe(1);
        expect(res.body.rankings[1].rank).toBe(2);
        expect(res.body.rankings[2].rank).toBe(3);
      });

      it(`rejects unknown project ID with criteria=${criteria}`, async () => {
        const res = await request(app)
          .get(`/v1/comparison/ranking?ids=1,888&criteria=${criteria}`)
          .expect(404);
        expect(res.body.error.code).toBe("not_found");
        expect(res.body.error.message).toBe("Project 888 not found");
      });
    }

    it("validates criteria before checking project existence when criteria is invalid", async () => {
      const res = await request(app)
        .get("/v1/comparison/ranking?ids=999&criteria=nonexistent_field")
        .expect(400);
      expect(res.body.error.code).toBe("bad_request");
    });
  });

  describe("CSV Export Endpoints Validation", () => {
    it("exports comparison CSV for valid IDs", async () => {
      const res = await request(app).get("/v1/comparison/export?ids=1,2,3").expect(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(
        /attachment; filename="comparison-1-2-3\.csv"/,
      );
      expect(res.text).toContain("project_id,Credit Quality,Green Impact");
      expect(res.text).toContain("1,");
      expect(res.text).toContain("2,");
      expect(res.text).toContain("3,");
    });

    it("rejects comparison CSV export for unknown project ID with 404", async () => {
      const res = await request(app).get("/v1/comparison/export?ids=1,777").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 777 not found");
    });

    it("exports ranking CSV for valid IDs", async () => {
      const res = await request(app)
        .get("/v1/comparison/ranking/export?ids=1,2&criteria=green_impact")
        .expect(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(
        /attachment; filename="ranking-green_impact\.csv"/,
      );
      expect(res.text).toContain("rank,project_id");
    });

    it("rejects ranking CSV export for unknown project ID with 404", async () => {
      const res = await request(app)
        .get("/v1/comparison/ranking/export?ids=2,888&criteria=green_impact")
        .expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 888 not found");
    });

    it("rejects comparison export for unsupported format with 400", async () => {
      const res = await request(app).get("/v1/comparison/export?ids=1,2&format=xml").expect(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(res.body.error.message).toContain("Unsupported export format");
    });
  });

  describe("Dashboard Timeseries Endpoint Validation", () => {
    it("returns timeseries for valid project ID (1)", async () => {
      const res = await request(app).get("/v1/dashboard/timeseries/1").expect(200);
      expect(res.body.project_id).toBe(1);
      expect(Array.isArray(res.body.points)).toBe(true);
    });

    it("returns timeseries for valid project ID with from and to query filters", async () => {
      const res = await request(app)
        .get("/v1/dashboard/timeseries/2?from=1000&to=2000")
        .expect(200);
      expect(res.body.project_id).toBe(2);
      expect(Array.isArray(res.body.points)).toBe(true);
    });

    it("rejects unknown project ID (123456) with 404", async () => {
      const res = await request(app).get("/v1/dashboard/timeseries/123456").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 123456 not found");
    });

    it("rejects deleted project ID (mocked as false) with 404", async () => {
      mockedExists.mockImplementation(async (id: number) => (id === 5 ? false : true));
      const res = await request(app).get("/v1/dashboard/timeseries/5").expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body.error.message).toBe("Project 5 not found");
    });

    it("rejects non-numeric project ID with 400", async () => {
      const res = await request(app).get("/v1/dashboard/timeseries/invalid_id").expect(400);
      expect(res.body.error.code).toBe("bad_request");
    });

    it("rejects negative project ID with 400", async () => {
      const res = await request(app).get("/v1/dashboard/timeseries/-5").expect(400);
      expect(res.body.error.code).toBe("bad_request");
    });
  });

  describe("Negative Controls and Isolation", () => {
    it("returns metrics definition list without invoking registry", async () => {
      const res = await request(app).get("/v1/comparison/metrics").expect(200);
      expect(res.body.metrics).toBeInstanceOf(Array);
      expect(res.body.metrics.length).toBe(7);
      expect(mockedExists).not.toHaveBeenCalled();
    });

    it("rejects missing ids parameter with 400 without invoking registry", async () => {
      const res = await request(app).get("/v1/comparison").expect(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(mockedExists).not.toHaveBeenCalled();
    });

    it("rejects non-integer ids in list with 400 without invoking registry", async () => {
      const res = await request(app).get("/v1/comparison?ids=1,abc,3").expect(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(mockedExists).not.toHaveBeenCalled();
    });

    it("rejects zero and negative ids in list with 400 without invoking registry", async () => {
      const res = await request(app).get("/v1/comparison?ids=0,1").expect(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(mockedExists).not.toHaveBeenCalled();
    });

    it("surfaces upstream registry RPC errors as 500 without masking", async () => {
      mockedExists.mockRejectedValueOnce(new Error("RPC timeout"));
      const res = await request(app).get("/v1/comparison?ids=1").expect(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
    });
  });

  describe("Stress and Concurrency Matrix", () => {
    it("handles 25 concurrent valid comparison queries consistently", async () => {
      const requests = Array.from({ length: 25 }, (_, i) => {
        const id1 = (i % 5) + 1;
        const id2 = ((i + 1) % 5) + 1;
        return request(app).get(`/v1/comparison?ids=${id1},${id2}`);
      });
      const results = await Promise.all(requests);
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.projects).toHaveLength(2);
      }
    });

    it("handles 25 concurrent invalid comparison queries returning 404 without crashing", async () => {
      const requests = Array.from({ length: 25 }, (_, i) => {
        return request(app).get(`/v1/comparison?ids=${100 + i}`);
      });
      const results = await Promise.all(requests);
      for (let i = 0; i < 25; i++) {
        expect(results[i].status).toBe(404);
        expect(results[i].body.error.code).toBe("not_found");
        expect(results[i].body.error.message).toBe(`Project ${100 + i} not found`);
      }
    });
  });

  describe("Comprehensive ID Matrix Verification", () => {
    describe("Valid IDs acceptance in comparison", () => {
      test.each(Array.from({ length: 10 }, (_, i) => i + 1))(
        "valid project ID %i succeeds with 200",
        async (id) => {
          const res = await request(app).get(`/v1/comparison?ids=${id}`).expect(200);
          expect(res.body.projects[0].id).toBe(id);
        },
      );
    });

    describe("Nonexistent IDs rejection with 404 in comparison", () => {
      test.each(Array.from({ length: 20 }, (_, i) => 11 + i))(
        "nonexistent project ID %i returns 404",
        async (id) => {
          const res = await request(app).get(`/v1/comparison?ids=${id}`).expect(404);
          expect(res.body.error.code).toBe("not_found");
          expect(res.body.error.message).toBe(`Project ${id} not found`);
        },
      );
    });

    describe("Nonexistent IDs rejection with 404 in dashboard timeseries", () => {
      test.each(Array.from({ length: 20 }, (_, i) => 11 + i))(
        "nonexistent timeseries project ID %i returns 404",
        async (id) => {
          const res = await request(app).get(`/v1/dashboard/timeseries/${id}`).expect(404);
          expect(res.body.error.code).toBe("not_found");
          expect(res.body.error.message).toBe(`Project ${id} not found`);
        },
      );
    });

    describe("Nonexistent IDs rejection with 404 in comparison ranking", () => {
      test.each(Array.from({ length: 15 }, (_, i) => 50 + i))(
        "nonexistent ranking project ID %i returns 404",
        async (id) => {
          const res = await request(app).get(`/v1/comparison/ranking?ids=${id}`).expect(404);
          expect(res.body.error.code).toBe("not_found");
          expect(res.body.error.message).toBe(`Project ${id} not found`);
        },
      );
    });

    describe("Nonexistent IDs rejection with 404 in comparison export", () => {
      test.each(Array.from({ length: 15 }, (_, i) => 70 + i))(
        "nonexistent export project ID %i returns 404",
        async (id) => {
          const res = await request(app).get(`/v1/comparison/export?ids=${id}`).expect(404);
          expect(res.body.error.code).toBe("not_found");
          expect(res.body.error.message).toBe(`Project ${id} not found`);
        },
      );
    });
  });
});
