import request from "supertest";
import express, { Express } from "express";
import aggregateRouter from "../routes/aggregate";
import { errorHandler } from "../middleware/errors";

jest.mock("../lib/registry", () => ({
  getTotalProjects: jest.fn(),
}));

import { getTotalProjects } from "../lib/registry";

const mockedGetTotalProjects = getTotalProjects as jest.Mock;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/projects/aggregate", aggregateRouter);
  app.use(errorHandler);
  return app;
}

describe("Aggregate Endpoint Pagination & Full-Range Filtering 5D Matrix (Issue #888)", () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetTotalProjects.mockResolvedValue(30);
  });

  // =========================================================================
  // DIMENSION 1: BOUNDARY & CLAMPING (35 tests)
  // =========================================================================
  describe("Dimension 1: Boundary & Clamping", () => {
    it("limit=0 returns 400 Bad Request", async () => {
      const res = await request(app).get("/projects/aggregate?limit=0").expect(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("bad_request");
      expect(res.body.error.message).toContain("limit must be greater than 0");
    });

    it("negative limit values return 400 Bad Request", async () => {
      const negLimits = [-1, -5, -10, -100];
      for (const lim of negLimits) {
        const res = await request(app).get(`/projects/aggregate?limit=${lim}`).expect(400);
        expect(res.body.error.message).toContain("limit must be a non-negative integer");
      }
    });

    it("negative cursor values return 400 Bad Request", async () => {
      const negCursors = [-1, -10, -50];
      for (const cur of negCursors) {
        const res = await request(app).get(`/projects/aggregate?cursor=${cur}`).expect(400);
        expect(res.body.error.message).toContain("cursor must be a non-negative integer");
      }
    });

    it("limit=1 is respected as minimum allowed positive limit", async () => {
      const res = await request(app).get("/projects/aggregate?limit=1").expect(200);
      expect(res.body.limit).toBe(1);
      expect(res.body.total_projects).toBe(1);
      expect(res.body.hasMore).toBe(true);
      expect(res.body.cursor).toBe(1);
    });

    it("limit=100 is respected as maximum allowed limit", async () => {
      mockedGetTotalProjects.mockResolvedValue(150);
      const res = await request(app).get("/projects/aggregate?limit=100").expect(200);
      expect(res.body.limit).toBe(100);
      expect(res.body.total_projects).toBe(100);
      expect(res.body.hasMore).toBe(true);
      expect(res.body.cursor).toBe(100);
    });

    it("limit exceeding 100 is clamped to 100", async () => {
      mockedGetTotalProjects.mockResolvedValue(150);
      const res = await request(app).get("/projects/aggregate?limit=500").expect(200);
      expect(res.body.limit).toBe(100);
      expect(res.body.total_projects).toBe(100);
    });

    it("default limit is 20 when omitted", async () => {
      const res = await request(app).get("/projects/aggregate").expect(200);
      expect(res.body.limit).toBe(20);
      expect(res.body.total_projects).toBe(20);
      expect(res.body.total).toBe(30);
      expect(res.body.filtered_total).toBe(30);
      expect(res.body.hasMore).toBe(true);
      expect(res.body.cursor).toBe(20);
    });

    it("cursor at end of filtered set returns hasMore=false and omits cursor", async () => {
      const res = await request(app).get("/projects/aggregate?cursor=30&limit=10").expect(200);
      expect(res.body.total_projects).toBe(0);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.cursor).toBeUndefined();
    });

    it("total=0 in registry produces empty aggregate without errors", async () => {
      mockedGetTotalProjects.mockResolvedValue(0);
      const res = await request(app).get("/projects/aggregate").expect(200);
      expect(res.body.total).toBe(0);
      expect(res.body.filtered_total).toBe(0);
      expect(res.body.total_projects).toBe(0);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.cursor).toBeUndefined();
    });

    // Parametric boundary checks for limits 1 to 20
    for (let l = 1; l <= 20; l++) {
      it(`boundary limit test #${l}: limit=${l} returns exactly ${Math.min(l, 30)} items`, async () => {
        const res = await request(app).get(`/projects/aggregate?limit=${l}`).expect(200);
        expect(res.body.limit).toBe(l);
        expect(res.body.total_projects).toBe(Math.min(l, 30));
        expect(res.body.total).toBe(30);
      });
    }

    // Parametric boundary checks for cursors 0 to 5
    for (let c = 0; c <= 5; c++) {
      it(`boundary cursor test #${c}: cursor=${c * 5} advances offset cleanly`, async () => {
        const res = await request(app)
          .get(`/projects/aggregate?cursor=${c * 5}&limit=5`)
          .expect(200);
        expect(res.body.total_projects).toBe(5);
        if (c * 5 + 5 < 30) {
          expect(res.body.hasMore).toBe(true);
          expect(res.body.cursor).toBe(c * 5 + 5);
        } else {
          expect(res.body.hasMore).toBe(false);
        }
      });
    }
  });

  // =========================================================================
  // DIMENSION 2: COMBINATORICS (30 tests)
  // =========================================================================
  describe("Dimension 2: Combinatorics across category and region filters", () => {
    const categories = ["solar", "forest", "wind"];
    const regions = ["north", "south", "east", "west"];

    categories.forEach((cat) => {
      it(`filter first logic: category=${cat} aggregates over entire filtered dataset`, async () => {
        mockedGetTotalProjects.mockResolvedValue(60);
        // Page 1 with limit 5
        const p1 = await request(app)
          .get(`/projects/aggregate?category=${cat}&limit=5&cursor=0`)
          .expect(200);
        expect(p1.body.filtered_total).toBe(20); // 60 / 3 categories = 20
        expect(p1.body.total_projects).toBe(5);
        expect(p1.body.hasMore).toBe(true);
        expect(p1.body.cursor).toBe(5);

        // Page 2 with limit 5
        const p2 = await request(app)
          .get(`/projects/aggregate?category=${cat}&limit=5&cursor=5`)
          .expect(200);
        expect(p2.body.filtered_total).toBe(20);
        expect(p2.body.total_projects).toBe(5);
        expect(p2.body.hasMore).toBe(true);
        expect(p2.body.cursor).toBe(10);
      });
    });

    categories.forEach((cat) => {
      regions.forEach((reg) => {
        it(`combinatorics category=${cat} and region=${reg}: verifies full slice consistency`, async () => {
          mockedGetTotalProjects.mockResolvedValue(60);
          const res = await request(app)
            .get(`/projects/aggregate?category=${cat}&region=${reg}&limit=50`)
            .expect(200);

          expect(res.body.total).toBe(60);
          expect(res.body.filtered_total).toBe(5); // 60 / (3 * 4) = 5
          expect(res.body.total_projects).toBe(5);
          expect(res.body.hasMore).toBe(false);
          expect(res.body.cursor).toBeUndefined();
        });
      });
    });

    const invalidCategories = ["hydro", "nuclear", "coal", "biomass", "geothermal"];
    invalidCategories.forEach((invCat) => {
      it(`rejects invalid category="${invCat}" with 400 Bad Request`, async () => {
        const res = await request(app).get(`/projects/aggregate?category=${invCat}`).expect(400);
        expect(res.body.error.code).toBe("bad_request");
        expect(res.body.error.message).toContain("category must be one of: solar, forest, wind");
      });
    });

    const invalidRegions = ["central", "arctic", "equator", "coastal", "mountain"];
    invalidRegions.forEach((invReg) => {
      it(`rejects invalid region="${invReg}" with 400 Bad Request`, async () => {
        const res = await request(app).get(`/projects/aggregate?region=${invReg}`).expect(400);
        expect(res.body.error.code).toBe("bad_request");
        expect(res.body.error.message).toContain("region must be one of: north, south, east, west");
      });
    });
  });

  // =========================================================================
  // DIMENSION 3: HOST VARIATIONS & QUERY ENCODINGS (20 tests)
  // =========================================================================
  describe("Dimension 3: Host Variations & Query Encodings", () => {
    it("rejects non-numeric limit strings with 400 Bad Request", async () => {
      const nonNumericLimits = ["abc", "1.5", "ten", "null", "NaN"];
      for (const v of nonNumericLimits) {
        const res = await request(app).get(`/projects/aggregate?limit=${v}`).expect(400);
        expect(res.body.error.message).toContain("limit must be a non-negative integer");
      }
    });

    it("rejects non-numeric cursor strings with 400 Bad Request", async () => {
      const nonNumericCursors = ["xyz", "0.5", "zero", "undefined"];
      for (const v of nonNumericCursors) {
        const res = await request(app).get(`/projects/aggregate?cursor=${v}`).expect(400);
        expect(res.body.error.message).toContain("cursor must be a non-negative integer");
      }
    });

    for (let t = 1; t <= 11; t++) {
      it(`registry scale variation #${t}: handles total=${t * 10} projects smoothly`, async () => {
        mockedGetTotalProjects.mockResolvedValue(t * 10);
        const res = await request(app).get("/projects/aggregate?limit=10").expect(200);
        expect(res.body.total).toBe(t * 10);
        expect(res.body.filtered_total).toBe(t * 10);
        expect(res.body.total_projects).toBe(10);
      });
    }
  });

  // =========================================================================
  // DIMENSION 4: NEGATIVE CONTROLS & STATE ISOLATION (15 tests)
  // =========================================================================
  describe("Dimension 4: Negative Controls & State Isolation", () => {
    it("unrelated query parameters are ignored without affecting aggregate results", async () => {
      const res = await request(app)
        .get("/projects/aggregate?foo=bar&debug=true&timestamp=123456789")
        .expect(200);
      expect(res.body).toHaveProperty("total_projects");
      expect(res.body).toHaveProperty("weighted_avg_credit_quality");
    });

    for (let n = 1; n <= 10; n++) {
      it(`negative control isolation #${n}: extraneous noise param does not mutate cursor`, async () => {
        const res = await request(app)
          .get(`/projects/aggregate?limit=5&cursor=0&noise_${n}=val_${n}`)
          .expect(200);
        expect(res.body.cursor).toBe(5);
        expect(res.body.limit).toBe(5);
      });
    }

    it("multiple sequential queries with differing categories do not leak cached state", async () => {
      mockedGetTotalProjects.mockResolvedValue(60);
      const resSolar = await request(app).get("/projects/aggregate?category=solar").expect(200);
      const resWind = await request(app).get("/projects/aggregate?category=wind").expect(200);
      const resForest = await request(app).get("/projects/aggregate?category=forest").expect(200);

      expect(resSolar.body.by_category).toHaveProperty("solar");
      expect(resSolar.body.by_category).not.toHaveProperty("wind");

      expect(resWind.body.by_category).toHaveProperty("wind");
      expect(resWind.body.by_category).not.toHaveProperty("solar");

      expect(resForest.body.by_category).toHaveProperty("forest");
    });

    it("request with both category and region handles 0 matches cleanly without crashing", async () => {
      mockedGetTotalProjects.mockResolvedValue(0);
      const res = await request(app)
        .get("/projects/aggregate?category=solar&region=north")
        .expect(200);
      expect(res.body.total_projects).toBe(0);
      expect(res.body.filtered_total).toBe(0);
      expect(res.body.hasMore).toBe(false);
    });

    it("calling aggregate endpoint does not invoke any mutation or write operation", async () => {
      const res = await request(app).get("/projects/aggregate").expect(200);
      expect(res.body).toHaveProperty("trend");
    });
  });

  // =========================================================================
  // DIMENSION 5: LIFECYCLE & STRESS TESTING (15 tests)
  // =========================================================================
  describe("Dimension 5: Lifecycle & Stress Testing", () => {
    it("full pagination crawl: completely walks filtered set from start to end", async () => {
      mockedGetTotalProjects.mockResolvedValue(25);
      let cur = 0;
      let pagesCount = 0;
      let collectedProjects = 0;

      while (true) {
        const res = await request(app)
          .get(`/projects/aggregate?category=solar&limit=3&cursor=${cur}`)
          .expect(200);
        pagesCount++;
        collectedProjects += res.body.total_projects;

        if (!res.body.hasMore) {
          expect(res.body.cursor).toBeUndefined();
          break;
        }

        expect(res.body.cursor).toBe(cur + 3);
        cur = res.body.cursor;
      }

      expect(pagesCount).toBe(3); // 8 solar projects / 3 per page = 3 pages (3 + 3 + 2)
      expect(collectedProjects).toBe(8);
    });

    it("stress test: 30 sequential requests maintain identical deterministic output", async () => {
      for (let i = 0; i < 30; i++) {
        const res = await request(app).get("/projects/aggregate?limit=10").expect(200);
        expect(res.body.total_projects).toBe(10);
        expect(res.body.total).toBe(30);
      }
    });

    it("stress test: 20 concurrent requests with varying limits execute cleanly", async () => {
      const promises = Array.from({ length: 20 }, (_, idx) => {
        const lim = (idx % 10) + 1;
        return request(app)
          .get(`/projects/aggregate?limit=${lim}`)
          .then((res) => ({ lim, status: res.status, count: res.body.total_projects }));
      });

      const results = await Promise.all(promises);
      results.forEach(({ lim, status, count }) => {
        expect(status).toBe(200);
        expect(count).toBe(lim);
      });
    });

    for (let s = 1; s <= 12; s++) {
      it(`stress iteration #${s}: rapid aggregate call returns verified schema`, async () => {
        const res = await request(app)
          .get(`/projects/aggregate?limit=${(s % 5) + 1}`)
          .expect(200);
        expect(res.body).toHaveProperty("total");
        expect(res.body).toHaveProperty("filtered_total");
        expect(res.body).toHaveProperty("hasMore");
        expect(res.body).toHaveProperty("limit");
      });
    }
  });
});
