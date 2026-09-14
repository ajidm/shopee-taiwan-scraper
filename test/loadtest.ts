/**
 * Load/stability test for the Shopee scraper API.
 *
 * Usage:
 *   npm run loadtest
 *   TOTAL_REQUESTS=200 CONCURRENCY=4 DURATION_MINUTES=60 npm run loadtest
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

async function main(): Promise<void> {
  const targets = loadTargets();
  const results: Result[] = [];
  const deadline = DURATION_MINUTES > 0 ? Date.now() + DURATION_MINUTES * 60_000 : null;

  let nextIndex = 0;
  const startedAt = Date.now();

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

  const durationSec = (Date.now() - startedAt) / 1000;
  const successes = results.filter((r) => r.ok).length;
  const failures = results.length - successes;
  const errorRate = results.length ? (failures / results.length) * 100 : 0;
  const avgMs = results.length ? results.reduce((sum, r) => sum + r.ms, 0) / results.length : 0;

  console.log("\n=== Load Test Summary ===");
  console.log(`Total requests : ${results.length}`);
  console.log(`Successes      : ${successes}`);
  console.log(`Failures       : ${failures}`);
  console.log(`Error rate     : ${errorRate.toFixed(2)}% (target: < 10%)`);
  console.log(`Avg latency    : ${avgMs.toFixed(0)}ms`);
  console.log(`Total duration : ${durationSec.toFixed(1)}s`);
  console.log(
    results.length >= 200 && errorRate < 10
      ? "PASS: meets 200+ items / <10% error rate criteria"
      : "Check criteria: needs 200+ requests and <10% error rate"
  );
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});
