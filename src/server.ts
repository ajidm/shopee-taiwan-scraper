import "dotenv/config";
import express from "express";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { shopeeRouter } from "./routes/shopee.route";
import { errorHandler } from "./middleware/errorHandler";
import { sessionManager } from "./services/session.manager";

// Playwright/CDP internals (including third-party stealth plugin code) can throw from
// detached async callbacks that bypass our own try/catch blocks — e.g. when a proxy drops
// mid-navigation and the browser session closes underneath an in-flight CDP call. Without
// these handlers a single such error would crash the whole process, violating the uptime
// requirement. We log and keep running; the specific in-flight request will simply fail
// and get retried by the caller.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception (process kept alive)");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection (process kept alive)");
});

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(shopeeRouter);

app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info({ port }, "Shopee scraper API listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  server.close();
  await sessionManager.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
