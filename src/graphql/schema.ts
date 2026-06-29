import { buildSchema } from "graphql";
import DataLoader from "dataloader";
import { getSolarData, getSatelliteData } from "../routes/iot";
import { computeScores } from "../lib/scoring";
import { createDefaultFinancialInput, calculateNPV, calculatePaybackPeriod } from "../lib/financial";
import { updateImpactScore, getTotalProjects } from "../lib/registry";
import { recordAudit } from "../lib/audit";
import { validateApiKey, isRateLimited, incrementUsage } from "../lib/apiKeys";
import { tryBeginUpdate, markCompleted, markFailed } from "../lib/duplicate-detection";

// 1. GraphQL SDL Schema
export const graphqlSchema = buildSchema(`
  type SolarData {
    power_output_kw: Float!
    efficiency_pct: Float!
    max_power_kw: Float!
  }

  type SatelliteData {
    forest_density_pct: Float!
    ndvi_score: Float!
  }

  type FinancialMetrics {
    installation_cost: Float!
    npv: Float!
    payback_period_years: Float
    roi_pct: Float!
  }

  type Project {
    id: ID!
    credit_quality: Int!
    green_impact: Int!
    solar: SolarData!
    satellite: SatelliteData!
    financials: FinancialMetrics!
  }

  type PortfolioSummary {
    total_projects: Int!
    avg_credit_quality: Float!
    avg_green_impact: Float!
    total_power_output_kw: Float!
    highest_score_project_id: ID
    lowest_score_project_id: ID
  }

  type Query {
    project(id: ID!): Project
    projects(limit: Int, offset: Int): [Project!]!
    portfolioSummary: PortfolioSummary!
  }

  type Mutation {
    updateProjectScores(id: ID!, creditQuality: Int!, greenImpact: Int!): Project!
  }
`);

// 2. DataLoaders for N+1 prevention
export interface GraphQLContext {
  isAdmin: boolean;
  isConsumer: boolean;
  consumerName: string;
  loaders: {
    solarLoader: DataLoader<number, any>;
    satelliteLoader: DataLoader<number, any>;
  };
  [key: string]: any;
}

export function createGraphQLContext(req: any): GraphQLContext {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers["x-api-key"];
  let providedKey = "";

  if (apiKeyHeader && typeof apiKeyHeader === "string") {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7);
  }

  let isAdmin = false;
  let isConsumer = false;
  let consumerName = "";

  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && providedKey === adminKey) {
    isAdmin = true;
  } else if (providedKey) {
    const keyRecord = validateApiKey(providedKey);
    if (keyRecord) {
      if (isRateLimited(keyRecord.id, keyRecord.rate_limit)) {
        throw new Error("Rate limit exceeded for this API key");
      }
      incrementUsage(keyRecord.id);
      isConsumer = true;
      consumerName = keyRecord.consumer_name;
    }
  }

  const solarLoader = new DataLoader<number, any>(async (keys) => {
    return keys.map((id) => getSolarData(id));
  });

  const satelliteLoader = new DataLoader<number, any>(async (keys) => {
    return keys.map((id) => getSatelliteData(id));
  });

  return {
    isAdmin,
    isConsumer,
    consumerName,
    loaders: {
      solarLoader,
      satelliteLoader,
    },
  };
}

// 3. Resolvers using classes to bind fields dynamically
class ProjectResolver {
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async solar(_args: any, context: GraphQLContext) {
    return context.loaders.solarLoader.load(parseInt(this.id, 10));
  }

  async satellite(_args: any, context: GraphQLContext) {
    return context.loaders.satelliteLoader.load(parseInt(this.id, 10));
  }

  async credit_quality(_args: any, context: GraphQLContext) {
    const solar = await context.loaders.solarLoader.load(parseInt(this.id, 10));
    const satellite = await context.loaders.satelliteLoader.load(parseInt(this.id, 10));
    const scores = computeScores({ solar, satellite });
    return scores.credit_quality;
  }

  async green_impact(_args: any, context: GraphQLContext) {
    const solar = await context.loaders.solarLoader.load(parseInt(this.id, 10));
    const satellite = await context.loaders.satelliteLoader.load(parseInt(this.id, 10));
    const scores = computeScores({ solar, satellite });
    return scores.green_impact;
  }

  async financials(_args: any, context: GraphQLContext) {
    const solar = await context.loaders.solarLoader.load(parseInt(this.id, 10));
    const input = createDefaultFinancialInput(solar.max_power_kw, solar.efficiency_pct);
    const npvResult = calculateNPV(input);
    const paybackResult = calculatePaybackPeriod(input);

    const totalBenefits = npvResult.discounted_cash_flows.reduce((acc, cf) => acc + cf.revenue, 0);
    const totalOpsCosts = npvResult.discounted_cash_flows.reduce((acc, cf) => acc + cf.maintenance_cost, 0);
    const netBenefits = totalBenefits - totalOpsCosts + (input.salvage_value ?? 0);
    const roi = input.installation_cost > 0 ? (netBenefits - input.installation_cost) / input.installation_cost : 0;

    return {
      installation_cost: input.installation_cost,
      npv: npvResult.npv,
      payback_period_years: paybackResult.reaches_payback ? paybackResult.payback_years : null,
      roi_pct: roi * 100,
    };
  }
}

export const graphqlRoot = {
  project: async ({ id }: { id: string }, context: GraphQLContext) => {
    // Authenticate: require admin or consumer key
    if (!context.isAdmin && !context.isConsumer) {
      throw new Error("Unauthorized: Valid API Key is required");
    }
    const projectId = parseInt(id, 10);
    const total = await getTotalProjects();
    if (projectId < 1 || projectId > total) return null;
    return new ProjectResolver(id);
  },

  projects: async ({ limit = 10, offset = 0 }: { limit?: number; offset?: number }, context: GraphQLContext) => {
    if (!context.isAdmin && !context.isConsumer) {
      throw new Error("Unauthorized: Valid API Key is required");
    }
    const total = await getTotalProjects();
    const ids = Array.from({ length: total }, (_, i) => i + 1);
    const paginatedIds = ids.slice(offset, offset + (limit ?? 10));
    return paginatedIds.map((id) => new ProjectResolver(String(id)));
  },

  portfolioSummary: async (_args: any, context: GraphQLContext) => {
    if (!context.isAdmin && !context.isConsumer) {
      throw new Error("Unauthorized: Valid API Key is required");
    }
    const total = await getTotalProjects();
    const ids = Array.from({ length: total }, (_, i) => i + 1);

    let sumCq = 0;
    let sumGi = 0;
    let sumPower = 0;
    let bestProjId: number | null = null;
    let worstProjId: number | null = null;
    let bestScore = -1;
    let worstScore = 999;

    for (const id of ids) {
      const solar = getSolarData(id);
      const satellite = getSatelliteData(id);
      const scores = computeScores({ solar, satellite });
      sumCq += scores.credit_quality;
      sumGi += scores.green_impact;
      sumPower += solar.power_output_kw;

      const score = scores.credit_quality + scores.green_impact;
      if (score > bestScore) {
        bestScore = score;
        bestProjId = id;
      }
      if (score < worstScore) {
        worstScore = score;
        worstProjId = id;
      }
    }

    return {
      total_projects: total,
      avg_credit_quality: total > 0 ? Math.round((sumCq / total) * 100) / 100 : 0,
      avg_green_impact: total > 0 ? Math.round((sumGi / total) * 100) / 100 : 0,
      total_power_output_kw: Math.round(sumPower * 100) / 100,
      highest_score_project_id: bestProjId,
      lowest_score_project_id: worstProjId,
    };
  },

  updateProjectScores: async (
    { id, creditQuality, greenImpact }: { id: string; creditQuality: number; greenImpact: number },
    context: GraphQLContext
  ) => {
    if (!context.isAdmin) {
      throw new Error("Unauthorized: Admin access required");
    }
    const projectId = parseInt(id, 10);

    const { allowed, reason } = tryBeginUpdate(projectId);
    if (!allowed) {
      throw new Error(`Duplicate update: ${reason}`);
    }

    try {
      const tx_hash = await updateImpactScore(projectId, creditQuality, greenImpact);
      markCompleted(projectId);
      recordAudit({
        project_id: projectId,
        credit_quality: creditQuality,
        green_impact: greenImpact,
        tx_hash,
        triggered_by: "graphql",
      });
    } catch (err) {
      markFailed(projectId);
      throw err;
    }

    return new ProjectResolver(id);
  },
};
