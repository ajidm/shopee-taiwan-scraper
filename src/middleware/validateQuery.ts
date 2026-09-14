import type { NextFunction, Request, Response } from "express";

const NUMERIC = /^\d+$/;

export function validateShopeeQuery(req: Request, res: Response, next: NextFunction): void {
  const { storeId, dealId } = req.query;

  if (typeof storeId !== "string" || typeof dealId !== "string" || !NUMERIC.test(storeId) || !NUMERIC.test(dealId)) {
    res.status(400).json({
      error: "invalid_request",
      message: "Query params 'storeId' and 'dealId' are required and must be numeric.",
    });
    return;
  }

  next();
}
