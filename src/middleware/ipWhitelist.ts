import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

interface CidrRange {
  network: string;
  prefix: number;
}

function ipToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidrMatch(ip: string, cidr: CidrRange): boolean {
  const ipNum = ipToNumber(ip);
  const networkNum = ipToNumber(cidr.network);
  const mask = ~((1 << (32 - cidr.prefix)) - 1) >>> 0;
  return (ipNum & mask) === (networkNum & mask);
}

function parseCidr(cidrString: string): CidrRange {
  const [network, prefixStr] = cidrString.trim().split("/");
  const prefix = prefixStr ? parseInt(prefixStr, 10) : 32;

  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(network)) {
    throw new Error(`Invalid IP address: ${network}`);
  }

  if (prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${prefix}`);
  }

  return { network, prefix };
}

function isPrivateIP(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  return false;
}

function parseIPList(envValue: string | undefined): CidrRange[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseCidr);
}

let allowedIPs: CidrRange[] = [];
let bypassPrivateNetworks = true;

function reloadConfig(): void {
  allowedIPs = parseIPList(process.env.ADMIN_IP_WHITELIST);
  bypassPrivateNetworks = process.env.ADMIN_IP_WHITELIST_BYPASS_PRIVATE !== "false";
}

reloadConfig();

export function refreshIPWhitelist(): void {
  reloadConfig();
}

export function ipWhitelist(req: Request, res: Response, next: NextFunction): void {
  if (allowedIPs.length === 0) {
    return next();
  }

  const clientIP =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] as string ||
    req.socket.remoteAddress ||
    "";

  const normalizedIP = clientIP.replace(/^::ffff:/, "");

  if (bypassPrivateNetworks && isPrivateIP(normalizedIP)) {
    return next();
  }

  const isAllowed = allowedIPs.some((cidr) => {
    if (cidr.prefix === 32) {
      return normalizedIP === cidr.network;
    }
    return cidrMatch(normalizedIP, cidr);
  });

  if (isAllowed) {
    return next();
  }

  logger.warn("Admin request blocked by IP whitelist", {
    ip: normalizedIP,
    path: req.originalUrl,
    method: req.method,
  });

  res.status(403).json({
    error: "forbidden",
    message: "Your IP address is not authorized to access admin endpoints",
  });
}
