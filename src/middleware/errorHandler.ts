import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path, query: req.query }, "Request failed");
  res.status(502).json({
    error: "upstream_fetch_failed",
    message: err instanceof Error ? err.message : "Unknown error while fetching product detail",
  });
}
