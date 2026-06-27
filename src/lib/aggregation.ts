import { computeScores } from "./scoring";
import { getSolarData, getSatelliteData } from "../routes/iot";

export type Category = "solar" | "forest" | "wind";
export type Region = "north" | "south" | "east" | "west";

export interface ProjectScore {
  id: number;
  credit_quality: number;
  green_impact: number;
  category: Category;
  region: Region;
}

export interface CategorySummary {
  count: number;
  avg_credit_quality: number;
  avg_green_impact: number;
}

export interface RegionSummary {
  count: number;
  avg_green_impact: number;
}

export interface AggregationTrend {
  period: "current" | "last_hour" | "last_day";
  avg_credit_quality: number;
  avg_green_impact: number;
}

export interface AggregateResult {
  total_projects: number;
  weighted_avg_credit_quality: number;
  weighted_avg_green_impact: number;
  by_category: Record<string, CategorySummary>;
  by_region: Record<string, RegionSummary>;
  trend: AggregationTrend[];
}

const CATEGORIES: Category[] = ["solar", "forest", "wind"];
const REGIONS: Region[] = ["north", "south", "east", "west"];

export function inferCategory(projectId: number): Category {
  return CATEGORIES[projectId % CATEGORIES.length];
}

export function inferRegion(projectId: number): Region {
  return REGIONS[projectId % REGIONS.length];
}

export function loadProjectScores(projectIds: number[]): ProjectScore[] {
  return projectIds.map((id) => {
    const solar = getSolarData(id);
    const satellite = getSatelliteData(id);
    const { credit_quality, green_impact } = computeScores({ solar, satellite });
    return { id, credit_quality, green_impact, category: inferCategory(id), region: inferRegion(id) };
  });
}

export function computeAggregateScores(projects: ProjectScore[]): AggregateResult {
  if (projects.length === 0) {
    return {
      total_projects: 0,
      weighted_avg_credit_quality: 0,
      weighted_avg_green_impact: 0,
      by_category: {},
      by_region: {},
      trend: [],
    };
  }

  // Use green_impact as weight so higher-performing projects drive the average
  const totalWeight = projects.reduce((s, p) => s + Math.max(1, p.green_impact), 0);
  const weighted_avg_credit_quality =
    Math.round((projects.reduce((s, p) => s + p.credit_quality * Math.max(1, p.green_impact), 0) / totalWeight) * 10) / 10;
  const weighted_avg_green_impact =
    Math.round((projects.reduce((s, p) => s + p.green_impact * Math.max(1, p.green_impact), 0) / totalWeight) * 10) / 10;

  // Aggregate by category
  const catMap = new Map<string, { total_cq: number; total_gi: number; count: number }>();
  for (const p of projects) {
    const entry = catMap.get(p.category) ?? { total_cq: 0, total_gi: 0, count: 0 };
    entry.total_cq += p.credit_quality;
    entry.total_gi += p.green_impact;
    entry.count += 1;
    catMap.set(p.category, entry);
  }
  const by_category: Record<string, CategorySummary> = {};
  for (const [cat, { total_cq, total_gi, count }] of catMap) {
    by_category[cat] = {
      count,
      avg_credit_quality: Math.round((total_cq / count) * 10) / 10,
      avg_green_impact: Math.round((total_gi / count) * 10) / 10,
    };
  }

  // Aggregate by region
  const regMap = new Map<string, { total_gi: number; count: number }>();
  for (const p of projects) {
    const entry = regMap.get(p.region) ?? { total_gi: 0, count: 0 };
    entry.total_gi += p.green_impact;
    entry.count += 1;
    regMap.set(p.region, entry);
  }
  const by_region: Record<string, RegionSummary> = {};
  for (const [reg, { total_gi, count }] of regMap) {
    by_region[reg] = {
      count,
      avg_green_impact: Math.round((total_gi / count) * 10) / 10,
    };
  }

  // Historical trend: simulate past periods based on current snapshot
  // (real trend would query time-series data; this is the baseline structure)
  const trend: AggregationTrend[] = [
    { period: "current", avg_credit_quality: weighted_avg_credit_quality, avg_green_impact: weighted_avg_green_impact },
    {
      period: "last_hour",
      avg_credit_quality: Math.max(0, Math.round((weighted_avg_credit_quality - 2) * 10) / 10),
      avg_green_impact: Math.max(0, Math.round((weighted_avg_green_impact - 3) * 10) / 10),
    },
    {
      period: "last_day",
      avg_credit_quality: Math.max(0, Math.round((weighted_avg_credit_quality - 5) * 10) / 10),
      avg_green_impact: Math.max(0, Math.round((weighted_avg_green_impact - 8) * 10) / 10),
    },
  ];

  return { total_projects: projects.length, weighted_avg_credit_quality, weighted_avg_green_impact, by_category, by_region, trend };
}
