import { Request, Response, NextFunction } from "express";
import compression from "compression";

// ── Configuration ───────────────────────────────────────────────────────────

export interface CompressionConfig {
  threshold: number;
  level: number;
  contentTypes: string[];
  excludePaths: string[];
}

const DEFAULT_CONTENT_TYPES = [
  "application/json",
  "application/javascript",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/vnd.api+json",
  "image/svg+xml",
  "text/html",
  "text/css",
  "text/javascript",
  "text/plain",
  "text/xml",
  "text/csv",
  "text/tab-separated-values",
  "font/opentype",
  "font/ttf",
  "application/wasm",
];

const DEFAULT_EXCLUDE = ["/health", "/ready", "/v1/metrics"];

// ── Compression metrics ─────────────────────────────────────────────────────

export interface CompressionMetrics {
  total_requests: number;
  compressed_requests: number;
  skipped_requests: number;
  bytes_before: number;
  bytes_after: number;
  ratio: number;
  by_encoding: Record<string, { count: number; bytes_before: number; bytes_after: number }>;
}

const metrics: CompressionMetrics = {
  total_requests: 0,
  compressed_requests: 0,
  skipped_requests: 0,
  bytes_before: 0,
  bytes_after: 0,
  ratio: 0,
  by_encoding: {},
};

export function getCompressionMetrics(): CompressionMetrics {
  const total = metrics.bytes_before;
  const after = metrics.bytes_after;
  return {
    ...metrics,
    ratio: total > 0 ? Math.round((1 - after / total) * 10000) / 100 : 0,
  };
}

export function resetCompressionMetrics(): void {
  metrics.total_requests = 0;
  metrics.compressed_requests = 0;
  metrics.skipped_requests = 0;
  metrics.bytes_before = 0;
  metrics.bytes_after = 0;
  metrics.ratio = 0;
  metrics.by_encoding = {};
}

// ── Middleware factory ───────────────────────────────────────────────────────

export function compressionMiddleware(userConfig?: Partial<CompressionConfig>): (req: Request, res: Response, next: NextFunction) => void {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const allExclude = new Set([...DEFAULT_EXCLUDE, ...config.excludePaths]);

  // Build a Set for exact mime matching
  const exactMimes = new Set(config.contentTypes.map((ct) => ct.toLowerCase()));

  const inner = compression({
    threshold: config.threshold,
    level: config.level,
    filter: (req: Request, res: Response) => {
      if (allExclude.has(req.path)) return false;
      const ct = (res.getHeader("content-type") as string) || "";
      const mime = ct.split(";")[0].trim().toLowerCase();
      return exactMimes.has(mime);
    },
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    metrics.total_requests++;

    const acceptEncoding = req.headers["accept-encoding"] as string | undefined;
    const isExcluded = allExclude.has(req.path);

    const originalSetHeader = res.setHeader.bind(res);
    let compressionDetected = false;

    res.setHeader = function (name: string, value: string | number | readonly string[]): Response {
      if (name.toLowerCase() === "content-encoding" && typeof value === "string" && value !== "identity") {
        compressionDetected = true;
        metrics.compressed_requests++;
        const encoding = value.split(",")[0].trim();

        const contentLength = Number(res.getHeader("content-length")) || 0;
        if (!metrics.by_encoding[encoding]) {
          metrics.by_encoding[encoding] = { count: 0, bytes_before: 0, bytes_after: 0 };
        }
        metrics.by_encoding[encoding].count++;

        (res as any).__compression_encoding = encoding;
        (res as any).__compression_content_length = contentLength;
      }
      return originalSetHeader(name, value);
    } as any;

    res.on("finish", () => {
      if (compressionDetected) {
        const encoding = (res as any).__compression_encoding;
        const originalSize = (res as any).__compression_content_length || 0;
        const compressedSize = Number(res.getHeader("content-length")) || 0;

        if (encoding && metrics.by_encoding[encoding]) {
          metrics.by_encoding[encoding].bytes_before += originalSize;
          metrics.by_encoding[encoding].bytes_after += compressedSize;
        }
        metrics.bytes_before += originalSize;
        metrics.bytes_after += compressedSize;
      } else if (!isExcluded && acceptEncoding) {
        metrics.skipped_requests++;
      }
    });

    inner(req, res, next);
  };
}

const DEFAULT_CONFIG: CompressionConfig = {
  threshold: 1024,
  level: 6,
  contentTypes: DEFAULT_CONTENT_TYPES,
  excludePaths: [],
};
