/**
 * Load/stability test for the Shopee scraper API.
 *
 * Usage:
 *   npm run loadtest
 *   TOTAL_REQUESTS=200 CONCURRENCY=4 DURATION_MINUTES=60 npm run loadtest
 *
 *   # Graduated ramp-up (recommended): step through increasing volume instead of
 *   # jumping straight to full concurrency, so a bad stage doesn't burn through the
 *   # whole target list before you notice — jumping straight to high concurrency is
 *   # suspected to have contributed to test items getting flagged by Shopee's anti-bot
 *   # during development.
 *   RAMP_UP=true npm run loadtest
 *   RAMP_UP=true RAMP_STAGES=1,5,10,25,50,100,200 RAMP_PAUSE_MS=5000 npm run loadtest
 *
 * Reads target storeId/dealId pairs from test/targets.json (falls back to
 * test/targets.example.json), cycling through them to reach TOTAL_REQUESTS.
 * For a real 200+ item / 30-60min stability run, replace test/targets.json
 * with 200+ distinct real product URLs.
 */
import fs from "node:fs";
import path from "node:path";

interface Target {
  storeId: string;
  dealId: string;
}

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const TOTAL_REQUESTS = Number(process.env.TOTAL_REQUESTS ?? 200);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES ?? 0); // 0 = run until TOTAL_REQUESTS done

const RAMP_UP = process.env.RAMP_UP === "true";
const RAMP_STAGES = (process.env.RAMP_STAGES ?? "1,5,10,25,50,100,200").split(",").map(Number);
const RAMP_PAUSE_MS = Number(process.env.RAMP_PAUSE_MS ?? 5000);
// Abort the ramp-up early if a stage's error rate exceeds this — no point burning through
// more targets once something is clearly wrong (aligns with the "circuit breaker" philosophy
// applied elsewhere in the codebase).
const RAMP_ABORT_ERROR_RATE = Number(process.env.RAMP_ABORT_ERROR_RATE ?? 50);

function loadTargets(): Target[] {
  const customPath = path.join(__dirname, "targets.json");
  const examplePath = path.join(__dirname, "targets.example.json");
  const file = fs.existsSync(customPath) ? customPath : examplePath;
  const targets: Target[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (targets.length === 0) throw new Error(`No targets found in ${file}`);
  console.log(`Loaded ${targets.length} target(s) from ${file}`);
  return targets;
}

interface Result {
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
}

async function hitOnce(target: Target): Promise<Result> {
  const start = Date.now();
  const url = `${BASE_URL}/shopee?storeId=${target.storeId}&dealId=${target.dealId}`;
  try {
    const res = await fetch(url);
    const ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, ms, error: body.slice(0, 200) };
    }
    await res.json();
    return { ok: true, status: res.status, ms };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - start, error: (err as Error).message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(results: Result[], startedAt: number): {
  successes: number;
  failures: number;
  errorRate: number;
  avgMs: number;
  durationSec: number;
} {
  const successes = results.filter((r) => r.ok).length;
  const failures = results.length - successes;
  const errorRate = results.length ? (failures / results.length) * 100 : 0;
  const avgMs = results.length ? results.reduce((sum, r) => sum + r.ms, 0) / results.length : 0;
  const durationSec = (Date.now() - startedAt) / 1000;
  return { successes, failures, errorRate, avgMs, durationSec };
}

function printSummary(label: string, results: Result[], startedAt: number): ReturnType<typeof summarize> {
  const s = summarize(results, startedAt);
  console.log(`\n=== ${label} ===`);
  console.log(`Total requests : ${results.length}`);
  console.log(`Successes      : ${s.successes}`);
  console.log(`Failures       : ${s.failures}`);
  console.log(`Error rate     : ${s.errorRate.toFixed(2)}%`);
  console.log(`Avg latency    : ${s.avgMs.toFixed(0)}ms`);
  console.log(`Duration       : ${s.durationSec.toFixed(1)}s`);
  return s;
}

/** Runs `count` requests against `targets` at the given concurrency, cycling the target list. */
async function runBatch(targets: Target[], count: number, concurrency: number): Promise<Result[]> {
  const results: Result[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < count) {
      const target = targets[nextIndex % targets.length];
      nextIndex += 1;

      const result = await hitOnce(target);
      results.push(result);

      const n = results.length;
      if (n % 10 === 0 || !result.ok) {
        const failures = results.filter((r) => !r.ok).length;
        console.log(
          `[${n}/${count}] status=${result.status} ok=${result.ok} ms=${result.ms} ` +
            `running_error_rate=${((failures / n) * 100).toFixed(1)}%` +
            (result.error ? ` err="${result.error}"` : "")
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  return results;
}

async function runRampUp(targets: Target[]): Promise<void> {
  console.log(
    `Starting ramp-up load test: baseUrl=${BASE_URL} stages=[${RAMP_STAGES.join(", ")}] ` +
      `concurrency=${CONCURRENCY} abortErrorRate=${RAMP_ABORT_ERROR_RATE}%`
  );

  const allResults: Result[] = [];
  const overallStart = Date.now();

  for (const stageCount of RAMP_STAGES) {
    console.log(`\n--- Stage: ${stageCount} requests ---`);
    const stageStart = Date.now();
    const stageResults = await runBatch(targets, stageCount, CONCURRENCY);
    allResults.push(...stageResults);
    const stageSummary = printSummary(`Stage ${stageCount} Summary`, stageResults, stageStart);

    if (stageSummary.errorRate > RAMP_ABORT_ERROR_RATE) {
      console.error(
        `\nABORTING ramp-up: stage ${stageCount} error rate ${stageSummary.errorRate.toFixed(1)}% ` +
          `exceeds threshold ${RAMP_ABORT_ERROR_RATE}%. Investigate before continuing to a higher stage — ` +
          `escalating volume against a target that's already failing tends to make things worse, not better.`
      );
      break;
    }

    if (stageCount !== RAMP_STAGES[RAMP_STAGES.length - 1]) {
      console.log(`Cooling down ${RAMP_PAUSE_MS}ms before next stage...`);
      await sleep(RAMP_PAUSE_MS);
    }
  }

  const finalSummary = printSummary("Overall Ramp-Up Summary", allResults, overallStart);
  console.log(
    allResults.length >= 200 && finalSummary.errorRate < 10
      ? "PASS: meets 200+ items / <10% error rate criteria"
      : "Check criteria: needs 200+ requests and <10% error rate"
  );
}

async function runFixed(targets: Target[]): Promise<void> {
  const results: Result[] = [];
  const deadline = DURATION_MINUTES > 0 ? Date.now() + DURATION_MINUTES * 60_000 : null;
  const startedAt = Date.now();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (deadline && Date.now() >= deadline) return;
      if (!deadline && nextIndex >= TOTAL_REQUESTS) return;

      const target = targets[nextIndex % targets.length];
      nextIndex += 1;

      const result = await hitOnce(target);
      results.push(result);

      const n = results.length;
      if (n % 10 === 0 || !result.ok) {
        const failures = results.filter((r) => !r.ok).length;
        console.log(
          `[${n}] status=${result.status} ok=${result.ok} ms=${result.ms} ` +
            `running_error_rate=${((failures / n) * 100).toFixed(1)}%` +
            (result.error ? ` err="${result.error}"` : "")
        );
      }
    }
  }

  console.log(
    `Starting load test: baseUrl=${BASE_URL} concurrency=${CONCURRENCY} ` +
      (deadline ? `duration=${DURATION_MINUTES}min` : `totalRequests=${TOTAL_REQUESTS}`)
  );

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const s = printSummary("Load Test Summary", results, startedAt);
  console.log(
    results.length >= 200 && s.errorRate < 10
      ? "PASS: meets 200+ items / <10% error rate criteria"
      : "Check criteria: needs 200+ requests and <10% error rate"
  );
}

async function main(): Promise<void> {
  const targets = loadTargets();
  if (RAMP_UP) {
    await runRampUp(targets);
  } else {
    await runFixed(targets);
  }
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});
