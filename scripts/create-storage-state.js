import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output, argv } from "node:process";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";

const outputPath = path.resolve(argv[2] || "storageState.json");
const startUrl = argv[3] || "https://ccfolia.com/";
const browserChannel = "msedge";

const browser = await chromium.launch({
  channel: browserChannel,
  headless: false,
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "ja-JP",
});

const page = await context.newPage();
await page.goto(startUrl, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});

const rl = createInterface({ input, output });

console.log("Microsoft Edge opens with a temporary Playwright profile.");
console.log("Sign in with the Wolume browser account in the opened window.");
console.log("When the signed-in page is visible, return here and press Enter.");
await rl.question("");
rl.close();

await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
await page.waitForTimeout(1000);

const state = await context.storageState({ indexedDB: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(state), "utf8");

await browser.close();

console.log(`Wrote ${outputPath}`);
