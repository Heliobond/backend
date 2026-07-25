import { Request, Response, NextFunction } from "express";
import {
  evaluateFlag,
  evaluateFlags,
  evaluateVariant,
  listFlags,
  getFlagAnalytics,
  loadFlags,
  mergeFlags,
  type EvaluationContext,
  type EvaluationResult,
  type FlagSet,
} from "../lib/feature-flags";

// ── Express middleware ───────────────────────────────────────────────────────

/**
 * Attaches an evaluation context to each request based on wallet address
 * or x-user-id header. Adds helper methods to res.locals for use in route handlers.
 */
export function featureFlagContext(req: Request, _res: Response, next: NextFunction): void {
  const userId =
    (req.headers["x-user-id"] as string) ||
    (req.query.user_id as string) ||
    undefined;

  const ctx: EvaluationContext = {
    user_id: userId,
    environment: process.env.NODE_ENV || "development",
    attributes: {
      ip: req.ip ?? "",
      user_agent: req.headers["user-agent"] ?? "",
    },
  };

  // Attach context and helpers to res.locals for downstream handlers
  const locals = _res.locals as Record<string, unknown>;
  locals.featureFlagContext = ctx;
  locals.isFeatureEnabled = (flagName: string): boolean => {
    return evaluateFlag(flagName, ctx).value;
  };
  locals.getFeatureVariant = (flagName: string): { enabled: boolean; variant?: unknown } => {
    return evaluateVariant(flagName, ctx);
  };
  locals.evaluateFeatureFlags = (flagNames: string[]): Record<string, EvaluationResult> => {
    return evaluateFlags(flagNames, ctx);
  };

  next();
}

// ── Helper to get context from res.locals ────────────────────────────────────

export function getFeatureFlagContext(res: Response): EvaluationContext {
  return (res.locals as Record<string, unknown>).featureFlagContext as EvaluationContext;
}

export function isFeatureEnabled(res: Response, flagName: string): boolean {
  return ((res.locals as Record<string, unknown>).isFeatureEnabled as (name: string) => boolean)(flagName);
}

// ── Admin API routes ────────────────────────────────────────────────────────

/**
 * Register admin-only feature flag management routes on the given router.
 *
 * Endpoints:
 *   GET  /flags              — list all flags with evaluation for current user
 *   GET  /flags/:name        — evaluate a specific flag
 *   POST /flags/load         — replace all flags from request body
 *   POST /flags/merge        — merge flags from request body
 *   GET  /flags/analytics    — evaluation analytics summary
 */
export function registerFlagRoutes(router: import("express").Router): void {
  // ── Static routes first (before :name param route) ──────────────────────

  // List all flags with current evaluation
  router.get("/flags", (req: Request, res: Response) => {
    const ctx: EvaluationContext = {
      user_id: (req.headers["x-user-id"] as string) || (req.query.user_id as string) || undefined,
      environment: process.env.NODE_ENV || "development",
    };

    const allFlags = listFlags();
    const evaluated: Record<string, { definition: unknown; evaluation: EvaluationResult }> = {};

    for (const [name, def] of Object.entries(allFlags)) {
      evaluated[name] = {
        definition: def,
        evaluation: evaluateFlag(name, ctx),
      };
    }

    res.json({ count: Object.keys(evaluated).length, flags: evaluated });
  });

  // Replace all flags (admin only)
  router.post("/flags/load", (req: Request, res: Response) => {
    try {
      const flagSet = req.body as FlagSet;
      if (!flagSet || typeof flagSet !== "object") {
        res.status(400).json({ error: "Request body must be a flag set object" });
        return;
      }
      loadFlags(flagSet);
      res.json({ message: "Flags loaded", count: Object.keys(flagSet).length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Merge additional flags (admin only)
  router.post("/flags/merge", (req: Request, res: Response) => {
    try {
      const partial = req.body as FlagSet;
      if (!partial || typeof partial !== "object") {
        res.status(400).json({ error: "Request body must be a flag set object" });
        return;
      }
      mergeFlags(partial);
      res.json({ message: "Flags merged", count: Object.keys(partial).length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Analytics summary
  router.get("/flags/analytics", (_req: Request, res: Response) => {
    res.json(getFlagAnalytics());
  });

  // ── Parameterized route (must be last under /flags) ─────────────────────

  // Evaluate a specific flag
  router.get("/flags/:name", (req: Request, res: Response) => {
    const ctx: EvaluationContext = {
      user_id: (req.headers["x-user-id"] as string) || (req.query.user_id as string) || undefined,
      environment: process.env.NODE_ENV || "development",
    };

    const result = evaluateFlag(String(req.params.name), ctx);
    res.json(result);
  });
}
