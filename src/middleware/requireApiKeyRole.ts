/**
 * Middleware to enforce role-based access control for API key bearer tokens.
 */

import { Request, Response, NextFunction } from "express";
import { timingSafeCompare } from "../lib/timing-safe";
import { getApiKeyRole, hasRolePermission, ApiKeyRole } from "../lib/apiKeyRoles";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            apiKeyRole?: ApiKeyRole;
        }
    }
}

/**
 * Middleware to extract and validate the Bearer token from the Authorization header.
 * Sets req.apiKeyRole if a valid token is found, otherwise continues without auth.
 * Use this as the first auth middleware in a route.
 */
export function extractApiKeyRole(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    const authHeader = req.headers.authorization ?? "";

    // Extract the token from "Bearer <token>"
    const bearerPrefix = "Bearer ";
    if (!authHeader.startsWith(bearerPrefix)) {
        // No Bearer token provided, continue without role
        next();
        return;
    }

    const token = authHeader.substring(bearerPrefix.length);
    if (!token) {
        next();
        return;
    }

    // Look up the role for this token
    const role = getApiKeyRole(token);
    if (role) {
        req.apiKeyRole = role;
    }

    next();
}

/**
 * Middleware factory to enforce a required role.
 * Returns a 403 Forbidden if the request doesn't have the required role.
 */
export function requireApiKeyRole(requiredRole: ApiKeyRole) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!hasRolePermission(req.apiKeyRole, requiredRole)) {
            res.status(403).json({
                error: "forbidden",
                message: `This action requires the '${requiredRole}' role or higher`,
            });
            return;
        }
        next();
    };
}

/**
 * Middleware to require authentication but allow any valid role.
 * Returns 401 if no valid token is provided.
 */
export function requireApiKeyAuth(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    if (!req.apiKeyRole) {
        res.status(401).json({
            error: "unauthorized",
            message: "Missing or invalid bearer token",
        });
        return;
    }
    next();
}
