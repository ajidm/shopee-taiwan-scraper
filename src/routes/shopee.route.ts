import { Router } from "express";
import { getProductDetail } from "../services/shopee.client";
import { validateShopeeQuery } from "../middleware/validateQuery";

export const shopeeRouter = Router();

shopeeRouter.get("/shopee", validateShopeeQuery, async (req, res, next) => {
  const storeId = req.query.storeId as string;
  const dealId = req.query.dealId as string;

  try {
    const data = await getProductDetail({ storeId, dealId });
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});
