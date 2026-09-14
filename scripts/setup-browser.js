#!/usr/bin/env node
/**
 * rebrowser-playwright bundles its own patched playwright-core with a pinned Chromium
 * revision, but its CLI installer conflicts with a hoisted top-level "playwright" package
 * (ERR_PACKAGE_PATH_NOT_EXPORTED) in npm's flat node_modules layout. This script downloads
 * the exact Chrome-for-Testing build rebrowser-playwright expects directly from Google's
 * CDN and stages it where session.manager.ts's default CHROME_EXECUTABLE_PATH looks for it,
 * bypassing the broken installer entirely.
 *
 * Currently targets macOS (arm64/x64). On other platforms, install manually and set
 * CHROME_EXECUTABLE_PATH yourself, or delete "rebrowser-playwright" from browsers.json
 * requirements and fall back to plain playwright-extra + stealth.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execSync } = require("child_process");

const browsersJsonPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "rebrowser-playwright",
  "node_modules",
  "playwright-core",
  "browsers.json"
);

if (!fs.existsSync(browsersJsonPath)) {
  console.error("[setup-browser] browsers.json not found, skipping (is rebrowser-playwright installed?)");
  process.exit(0);
}

const browsers = JSON.parse(fs.readFileSync(browsersJsonPath, "utf-8")).browsers;
const chromium = browsers.find((b) => b.name === "chromium");
const headlessShell = browsers.find((b) => b.name === "chromium-headless-shell");

if (process.platform !== "darwin") {
  console.warn(
    "[setup-browser] Non-macOS platform detected. Skipping automatic staging — " +
      "install a matching Chrome for Testing build manually and set CHROME_EXECUTABLE_PATH."
  );
  process.exit(0);
}

const arch = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
const cacheDir = path.join(os.homedir(), "Library", "Caches", "rebrowser-chromium-manual");
fs.mkdirSync(cacheDir, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 307 || res.statusCode === 302) {
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

async function stageBuild(browserVersion, zipName, targetDirName) {
  const targetDir = path.join(cacheDir, targetDirName);
  if (fs.existsSync(targetDir)) {
    console.log(`[setup-browser] ${targetDirName} already staged, skipping`);
    return;
  }
  const url = `https://cdn.playwright.dev/builds/cft/${browserVersion}/${arch}/${zipName}-${arch}.zip`;
  const zipPath = path.join(cacheDir, `${targetDirName}.zip`);
  console.log(`[setup-browser] Downloading ${zipName} ${browserVersion}...`);
  await download(url, zipPath);
  execSync(`unzip -q -o "${zipPath}" -d "${cacheDir}"`, { stdio: "inherit" });
  const extractedName = `${zipName}-${arch}`;
  fs.renameSync(path.join(cacheDir, extractedName), targetDir);
  fs.unlinkSync(zipPath);
  execSync(`xattr -cr "${targetDir}"`, { stdio: "ignore" });
  console.log(`[setup-browser] Staged ${targetDirName}`);
}

(async () => {
  try {
    await stageBuild(chromium.browserVersion, "chrome", `chrome-${arch}`);
    await stageBuild(headlessShell.browserVersion, "chrome-headless-shell", `chrome-headless-shell-${arch}`);

    execSync(`chmod +x "${cacheDir}/chrome-headless-shell-${arch}/chrome-headless-shell"`, {
      stdio: "ignore",
    });
    execSync(
      `chmod +x "${cacheDir}/chrome-${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"`,
      { stdio: "ignore" }
    );
    console.log("[setup-browser] Done.");
  } catch (err) {
    console.error("[setup-browser] Failed:", err.message);
    console.error("[setup-browser] You can install manually — see README 'Batasan yang Diketahui'.");
  }
})();
