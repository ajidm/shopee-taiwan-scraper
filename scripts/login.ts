/**
 * One-time interactive login capture (not part of the API): opens a real, visible browser
 * using this project's own anti-detection stack, lets you log in to Shopee manually
 * (including any OTP/captcha step — never automated here), then saves the resulting
 * cookies + localStorage to a storage state file for AUTH_MODE=login to reuse.
 *
 * Usage:
 *   npm run login
 *   SHOPEE_DOMAIN=shopee.co.id npm run login   # target a different region
 *
 * The saved file contains live session cookies — treat it like a password. It's gitignored
 * (.auth/) and must never be committed.
 */
import "dotenv/config";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { getConfiguredBrowserEngine } from "../src/techniques/browserEngine";

const MAC_ARCH = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
const REBROWSER_CACHE_DIR = `${process.env.HOME}/Library/Caches/rebrowser-chromium-manual`;
const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  `${REBROWSER_CACHE_DIR}/chrome-${MAC_ARCH}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const SHOPEE_DOMAIN = process.env.SHOPEE_DOMAIN || "shopee.tw";
const STORAGE_STATE_PATH = process.env.LOGIN_STORAGE_STATE_PATH || `${process.cwd()}/.auth/shopee-login-state.json`;

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const chromium = getConfiguredBrowserEngine();
  const browser = await chromium.launch({
    headless: false,
    executablePath: CHROME_EXECUTABLE_PATH,
  });
  const context = await browser.newContext({
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();

  await page.goto(`https://${SHOPEE_DOMAIN}/buyer/login`, { waitUntil: "domcontentloaded" }).catch((err) => {
    console.error("Navigation failed:", err.message);
  });

  console.log("\nBrowser is open. Log in manually (email/password, OTP, captcha — whatever Shopee asks for).");
  console.log("Once you're fully logged in and can see your account/homepage, come back here.");
  await waitForEnter("Press Enter here when login is complete... ");

  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log(`\nSaved logged-in session to ${STORAGE_STATE_PATH}`);
  console.log("Set AUTH_MODE=login (and LOGIN_STORAGE_STATE_PATH if you moved the file) to use it.");

  await browser.close();
}

main().catch((err) => {
  console.error("login.ts failed:", err);
  process.exit(1);
});
