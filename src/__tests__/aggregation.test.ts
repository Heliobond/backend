import { computeAggregateScores, inferCategory, inferRegion, type ProjectScore } from "../lib/aggregation";

function makeProject(id: number, cq: number, gi: number): ProjectScore {
  return { id, credit_quality: cq, green_impact: gi, category: inferCategory(id), region: inferRegion(id) };
}

describe("inferCategory", () => {
  it("cycles through solar / forest / wind", () => {
    expect(inferCategory(0)).toBe("solar");
    expect(inferCategory(1)).toBe("forest");
    expect(inferCategory(2)).toBe("wind");
    expect(inferCategory(3)).toBe("solar");
  });
});

describe("inferRegion", () => {
  it("cycles through north / south / east / west", () => {
    expect(inferRegion(0)).toBe("north");
    expect(inferRegion(1)).toBe("south");
    expect(inferRegion(2)).toBe("east");
    expect(inferRegion(3)).toBe("west");
    expect(inferRegion(4)).toBe("north");
  });
});

describe("computeAggregateScores", () => {
  it("returns zero result for empty input", () => {
    const result = computeAggregateScores([]);
    expect(result.total_projects).toBe(0);
    expect(result.weighted_avg_credit_quality).toBe(0);
    expect(result.weighted_avg_green_impact).toBe(0);
    expect(result.trend).toHaveLength(0);
  });

  it("counts total projects correctly", () => {
    const projects = [makeProject(1, 80, 70), makeProject(2, 60, 50), makeProject(3, 90, 85)];
    const result = computeAggregateScores(projects);
    expect(result.total_projects).toBe(3);
  });

  it("weighted averages are within 0–100", () => {
    const projects = [makeProject(1, 100, 100), makeProject(2, 0, 0), makeProject(3, 50, 50)];
    const result = computeAggregateScores(projects);
    expect(result.weighted_avg_credit_quality).toBeGreaterThanOrEqual(0);
    expect(result.weighted_avg_credit_quality).toBeLessThanOrEqual(100);
    expect(result.weighted_avg_green_impact).toBeGreaterThanOrEqual(0);
    expect(result.weighted_avg_green_impact).toBeLessThanOrEqual(100);
  });

  it("by_category contains only categories present in input", () => {
    // ids 1, 4, 7 all map to 'forest' (1%3=1, 4%3=1, 7%3=1)
    const projects = [makeProject(1, 80, 70), makeProject(4, 60, 55), makeProject(7, 75, 65)];
    const result = computeAggregateScores(projects);
    expect(Object.keys(result.by_category)).toEqual(["forest"]);
    expect(result.by_category.forest.count).toBe(3);
  });

  it("by_category averages are correct", () => {
    // id 1 → forest, id 2 → wind
    const projects = [makeProject(1, 80, 60), makeProject(2, 40, 20)];
    const result = computeAggregateScores(projects);
    expect(result.by_category.forest.avg_credit_quality).toBe(80);
    expect(result.by_category.forest.avg_green_impact).toBe(60);
    expect(result.by_category.wind.avg_credit_quality).toBe(40);
    expect(result.by_category.wind.avg_green_impact).toBe(20);
  });

  it("by_region groups projects by region correctly", () => {
    // id 1 → south, id 5 → south; id 2 → east
    const projects = [makeProject(1, 80, 70), makeProject(5, 60, 50), makeProject(2, 40, 30)];
    const result = computeAggregateScores(projects);
    expect(result.by_region.south.count).toBe(2);
    expect(result.by_region.east.count).toBe(1);
  });

  it("trend contains three periods in order", () => {
    const projects = [makeProject(1, 80, 70)];
    const result = computeAggregateScores(projects);
    expect(result.trend).toHaveLength(3);
    expect(result.trend[0].period).toBe("current");
    expect(result.trend[1].period).toBe("last_hour");
    expect(result.trend[2].period).toBe("last_day");
  });

  it("trend past periods are not higher than current", () => {
    const projects = [makeProject(1, 80, 70), makeProject(2, 75, 65)];
    const result = computeAggregateScores(projects);
    expect(result.trend[1].avg_green_impact).toBeLessThanOrEqual(result.trend[0].avg_green_impact);
    expect(result.trend[2].avg_green_impact).toBeLessThanOrEqual(result.trend[1].avg_green_impact);
  });

  it("trend values are clamped to >= 0", () => {
    const projects = [makeProject(1, 3, 2)];
    const result = computeAggregateScores(projects);
    for (const t of result.trend) {
      expect(t.avg_credit_quality).toBeGreaterThanOrEqual(0);
      expect(t.avg_green_impact).toBeGreaterThanOrEqual(0);
    }
  });
});
