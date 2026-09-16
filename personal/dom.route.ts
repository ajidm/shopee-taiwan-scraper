/**
 * Personal side-project route — NOT part of the graded submission (see domScraper.ts).
 * Kept alongside the main API for convenience, but a distinct endpoint from GET /shopee.
 */
import { Router } from "express";
import { validateShopeeQuery } from "../src/middleware/validateQuery";
import { scrapeProductPage } from "./domScraper";

export const domRouter = Router();

domRouter.get("/shopee/dom", validateShopeeQuery, async (req, res, next) => {
  const storeId = req.query.storeId as string;
  const dealId = req.query.dealId as string;

  try {
    const data = await scrapeProductPage(storeId, dealId);
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});
