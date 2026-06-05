import fs from "node:fs/promises";
import { text as streamToText } from "node:stream/consumers";
import { chromium } from "playwright";
import { parse } from "node-html-parser";

const DEBUG_DIR = "debug";

const WOLUME_ENDPOINT = normalizeBaseEndpoint(process.env.WOLUME_ENDPOINT || "");
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || "";
const ACTION_LABEL = mustEnv("ACTION_LABEL");
const MENU_LABEL = process.env.MENU_LABEL || "";
const MENU_SELECTOR = process.env.MENU_SELECTOR || "";
const CLOSE_DIALOG_LABEL = process.env.CLOSE_DIALOG_LABEL || "";
const TAB_LABELS = parseList(process.env.TAB_LABELS || "");
const CCFOLIA_STORAGE_STATE_JSON = process.env.CCFOLIA_STORAGE_STATE_JSON || "";
const WOLUME_GUILD_ID = normalizeOptionalDiscordId(
  process.env.WOLUME_GUILD_ID || "",
  "WOLUME_GUILD_ID"
);
const CHECK_ONLY = process.env.CHECK_ONLY === "1";
const WRITE_DEBUG = process.env.WRITE_DEBUG === "1";
const WRITE_SUMMARY = CHECK_ONLY || WRITE_DEBUG;
const INITIAL_UI_TIMEOUT_MS = 12_000;
const MAX_TARGETS = parseOptionalIntegerEnv("MAX_TARGETS", {
  min: 1,
  max: 50,
});
const MAX_TABS_PER_TARGET = parseOptionalIntegerEnv("MAX_TABS_PER_TARGET", {
  min: 1,
  max: 100,
});
const POLITE_DELAY_MS = parseIntegerEnv("POLITE_DELAY_MS", 1000, {
  min: 0,
  max: 10_000,
});

let debugDirReady = false;

async function main() {
  if (WRITE_SUMMARY || WRITE_DEBUG) {
    await prepareDebugDir();
  }

  const targets = await loadRunnerTargets();

  if (targets.length === 0) {
    await writeSummary({
      ok: true,
      count: 0,
      targets: [],
    });
    console.log("No active targets.");
    return;
  }

  let storageStateContextOption;
  try {
    storageStateContextOption = buildStorageStateContextOption();
  } catch (error) {
    await handleGlobalRunnerConfigFailure(targets, error);
    throw error;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    locale: "ja-JP",
    ...storageStateContextOption,
  });

  const page = await context.newPage();

  try {
    const targetSummaries = [];
    let totalItems = 0;
    const failures = [];

    for (const [targetIndex, target] of targets.entries()) {
      if (targetIndex > 0) {
        await politeDelay();
      }

      let result;
      try {
        result = await processTarget(page, target, targetIndex);
      } catch (error) {
        const failure = normalizeRunnerFailure(error);
        failures.push({ target, targetIndex, ...failure });
        targetSummaries.push({
          sourceId: target.sourceId,
          count: 0,
          error: failure.message,
          errorCode: failure.code,
          errorDetail: failure.detail,
        });
        console.warn(
          `target=${targetIndex + 1} failed code=${failure.code} message=${failure.message}`
        );

        await writeTargetFailureDebug(page, targetIndex, failure);

        if (!CHECK_ONLY) {
          await postCycle({
            sourceId: target.sourceId,
            guildId: WOLUME_GUILD_ID,
            error: failure.message,
            errorCode: failure.code,
            errorDetail: failure.detail,
          });
        }

        continue;
      }

      totalItems += result.count;
      targetSummaries.push(result.summary);

      if (!CHECK_ONLY) {
        await postCycle({
          sourceId: target.sourceId,
          guildId: WOLUME_GUILD_ID,
          tabs: result.tabs,
          missingTabs: result.missingTabs,
        });
      }
    }

    await writeSummary({
      ok: true,
      count: totalItems,
      failed: failures.length,
      targets: targetSummaries,
    });

    if (CHECK_ONLY) {
      if (failures.length > 0) {
        throw new Error(`${failures.length} target(s) failed during check.`);
      }

      if (totalItems === 0) {
        throw new Error("No entries were parsed from the exported files.");
      }

      console.log("CHECK_ONLY=1; skip submit.");
      return;
    }
  } catch (error) {
    await writeDebugText("error.txt", String(error?.stack || error));

    try {
      await saveScreenshot(page, "99-error");
      await saveClickables(page, "clickables-on-error.json");
    } catch {
      // ignore
    }

    throw error;
  } finally {
    await browser.close();
  }
}

async function handleGlobalRunnerConfigFailure(targets, error) {
  const failure = normalizeRunnerFailure(error);

  await writeSummary({
    ok: false,
    count: 0,
    failed: targets.length,
    targets: targets.map((target) => ({
      sourceId: target.sourceId,
      count: 0,
      error: failure.message,
      errorCode: failure.code,
      errorDetail: failure.detail,
    })),
  });

  if (CHECK_ONLY) {
    return;
  }

  for (const target of targets) {
    await postCycle({
      sourceId: target.sourceId,
      guildId: WOLUME_GUILD_ID,
      error: failure.message,
      errorCode: failure.code,
      errorDetail: failure.detail,
    });
  }
}

async function processTarget(page, target, targetIndex) {
  const targetPrefix = `target-${String(targetIndex + 1).padStart(2, "0")}`;

  await page.goto(target.url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  await page.waitForTimeout(1500);
  await assertRoomAvailable(page, target.url);
  await waitForInitialUi(page);
  await closeBlockingDialogs(page);
  await assertRoomAvailable(page, target.url);

  await saveScreenshot(page, `${targetPrefix}-open`);
  await saveClickables(page, `${targetPrefix}-clickables-before-panel.json`);

  const availableTabs = await discoverLogTabs(page);
  const { targetTabs, missingTabs } = chooseTargetTabs(
    availableTabs,
    target.tabs,
    target.checkTabs
  );
  const tabSummaries = [];
  const tabResults = [];
  let totalItems = 0;

  await writeDebugText(
    `${targetPrefix}-tabs.json`,
    JSON.stringify(
      {
        target: {
          sourceId: target.sourceId,
          configuredTabs: target.tabs,
          checkTabs: target.checkTabs,
        },
        availableTabs,
        targetTabs,
        missingTabs,
      },
      null,
      2
    )
  );

  for (const [tabIndex, targetTab] of targetTabs.entries()) {
    if (tabIndex > 0) {
      await politeDelay();
    }

    await selectLogTab(page, targetTab);

    const debugPrefix = `${targetPrefix}-tab-${String(tabIndex + 1).padStart(2, "0")}`;
    const html = await exportCurrentLog(page, debugPrefix);
    const parsedItems = parseSourceHtml(html);
    const tabKey = parsedItems.find((item) => item.tab)?.tab || targetTab.key;
    const items = parsedItems.map((item) => ({
      ...item,
      tab: item.tab || tabKey,
    }));

    totalItems += items.length;
    tabResults.push({
      tabKey,
      tabName: targetTab.label,
      items,
    });

    tabSummaries.push({
      tab: targetTab.label,
      key: tabKey,
      count: items.length,
      first: summarizeItem(items[0]),
      last: summarizeItem(items[items.length - 1]),
    });

    console.log(
      `target=${targetIndex + 1} tab=${tabIndex + 1} items=${items.length}`
    );
  }

  return {
    count: totalItems,
    tabs: tabResults,
    missingTabs,
    summary: {
      sourceId: target.sourceId,
      count: totalItems,
      tabs: tabSummaries,
      missingTabs,
    },
  };
}

async function waitForInitialUi(page) {
  const waiters = [];

  if (MENU_SELECTOR) {
    waiters.push(waitForVisible(page.locator(MENU_SELECTOR)));
  }

  if (CLOSE_DIALOG_LABEL) {
    waiters.push(
      waitForVisible(
        page
          .getByRole("dialog")
          .getByRole("button", { name: CLOSE_DIALOG_LABEL, exact: true })
          .first()
      )
    );
  }

  if (MENU_LABEL) {
    waiters.push(
      waitForVisible(
        page.getByRole("button", { name: MENU_LABEL, exact: true }).first()
      )
    );
  }

  waiters.push(waitForVisible(page.locator("[role='tab']").first()));

  try {
    await Promise.any(waiters);
    console.log("initial UI ready");
  } catch {
    console.log("initial UI wait timed out; continuing");
  }
}

function waitForVisible(locator) {
  return locator.waitFor({
    state: "visible",
    timeout: INITIAL_UI_TIMEOUT_MS,
  });
}

async function discoverLogTabs(page) {
  await page.locator("[role='tab']").first().waitFor({
    state: "visible",
    timeout: 10_000,
  });

  const tabs = await page.evaluate(() => {
    function textWithoutDecorations(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue || "";
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      const element = node;
      if (
        element.matches(
          ".MuiBadge-badge,.MuiTouchRipple-root,svg,[aria-hidden='true']"
        )
      ) {
        return "";
      }

      return Array.from(element.childNodes)
        .map(textWithoutDecorations)
        .join(" ");
    }

    function visible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }

    return [...document.querySelectorAll("[role='tab']")]
      .map((element, index) => {
        const label = textWithoutDecorations(element)
          .replace(/\s+/g, " ")
          .trim();
        const disabled =
          element.hasAttribute("disabled") ||
          element.getAttribute("aria-disabled") === "true";

        return {
          index,
          key: ["main", "info", "other"][index] || label,
          label,
          disabled,
          selected: element.getAttribute("aria-selected") === "true",
          visible: visible(element),
        };
      })
      .filter((tab) => tab.visible && !tab.disabled && tab.label);
  });

  if (tabs.length === 0) {
    throw new Error("No log tabs were found.");
  }

  return tabs;
}

function chooseTargetTabs(
  availableTabs,
  configuredTabs = [],
  checkTabs = configuredTabs
) {
  const missingTabs = findMissingTabs(availableTabs, checkTabs);
  const targetTabs =
    configuredTabs.length === 0
      ? availableTabs
      : configuredTabs.flatMap((label, labelIndex) => {
          const tab = findConfiguredTab(availableTabs, label);
          if (!tab) {
            return [];
          }

          return [tab];
        });

  const limitedTabs =
    TAB_LABELS.length === 0
      ? targetTabs
      : targetTabs.filter((tab) =>
          TAB_LABELS.some((label) => tab.label === label || tab.key === label)
        );

  if (limitedTabs.length === 0) {
    if (missingTabs.length > 0) {
      return { targetTabs: [], missingTabs };
    }

    throw new Error(
      "No tabs remained after applying configured tabs and TAB_LABELS. Run lume-check with debug artifact if labels need inspection."
    );
  }

  validateTargetTabs(limitedTabs);
  return { targetTabs: limitedTabs, missingTabs };
}

function findMissingTabs(availableTabs, checkTabs = []) {
  const missingTabs = [];
  const seen = new Set();

  for (const [labelIndex, label] of checkTabs.entries()) {
    if (findConfiguredTab(availableTabs, label)) {
      continue;
    }

    const normalized = normalizeTabReference(label);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    missingTabs.push({
      tabName: label,
      tabKey: label,
      configuredIndex: labelIndex,
    });
  }

  return missingTabs;
}

async function assertRoomAvailable(page, targetUrl) {
  assertRoomUrlStillMatches(page.url(), targetUrl);

  const text = await page
    .locator("body")
    .innerText({ timeout: 3_000 })
    .catch(() => "");
  const normalized = normalizeText(text);

  const blockers = [
    {
      code: "room-construction",
      message: "ココフォリア部屋は工事中です。",
      patterns: [/現在準備中のルームです/, /工事中モード/],
    },
    {
      code: "room-access-denied",
      message: "ゲストユーザーから閲覧できないココフォリア部屋です。",
      patterns: [/アクセスが制限されています/, /閲覧する権限がありません/],
    },
    {
      code: "room-login-required",
      message: "ココフォリア部屋の閲覧にログインが必要です。",
      patterns: [/ログインが必要/, /ログインしてください/],
    },
  ];

  for (const blocker of blockers) {
    if (blocker.patterns.some((pattern) => pattern.test(normalized))) {
      throw new RoomStateError(blocker.code, blocker.message);
    }
  }
}

function assertRoomUrlStillMatches(currentUrl, targetUrl) {
  let current;
  let target;

  try {
    current = new URL(currentUrl);
    target = new URL(targetUrl);
  } catch {
    throw new RoomStateError(
      "room-url-invalid",
      "ココフォリア部屋URLを確認できませんでした。"
    );
  }

  const currentPath = current.pathname.replace(/\/$/, "");
  const targetPath = target.pathname.replace(/\/$/, "");

  if (
    current.hostname !== target.hostname ||
    !currentPath.startsWith("/rooms/") ||
    currentPath !== targetPath
  ) {
    throw new RoomStateError(
      "room-unavailable",
      "ココフォリア部屋を開けません（削除済み、URL違い、または公開されていない可能性があります）。"
    );
  }
}

function findConfiguredTab(availableTabs, label) {
  return availableTabs.find(
    (candidate) => candidate.label === label || candidate.key === label
  );
}

async function selectLogTab(page, targetTab) {
  await closeTransientMenus(page);
  await closeBlockingDialogs(page);

  const tabs = page.locator("[role='tab']");
  const tab = tabs.nth(targetTab.index);
  const selected = await tab
    .getAttribute("aria-selected", { timeout: 10_000 })
    .catch(() => "");

  if (selected !== "true") {
    await tab.click({ timeout: 10_000 });
  }

  await page.waitForFunction(
    (index) => {
      const element = document.querySelectorAll("[role='tab']")[index];
      return element?.getAttribute("aria-selected") === "true";
    },
    targetTab.index,
    { timeout: 10_000 }
  );

  await page.waitForTimeout(500);
}

async function exportCurrentLog(page, debugPrefix) {
  await closeBlockingDialogs(page);

  await openMenu(page);

  if (WRITE_DEBUG) {
    await page.waitForTimeout(300);
  }

  await saveScreenshot(page, `${debugPrefix}-panel-open`);
  await saveClickables(page, `${debugPrefix}-clickables-after-panel.json`);

  const downloadPromise = page.waitForEvent("download", {
    timeout: 60_000,
  });

  await clickActionMenuItem(page);

  const download = await downloadPromise;
  const html = await readDownloadText(download);

  await closeTransientMenus(page);
  await writeDebugText(`${debugPrefix}-snapshot.html`, html);

  return html;
}

async function closeTransientMenus(page) {
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } catch {
    // Ignore; this is only cleanup before the next tab click.
  }
}

async function closeBlockingDialogs(page) {
  if (!CLOSE_DIALOG_LABEL) {
    return;
  }

  const closeButtons = page.getByRole("dialog").getByRole("button", {
    name: CLOSE_DIALOG_LABEL,
    exact: true,
  });

  const count = await closeButtons.count().catch(() => 0);
  if (count === 0) {
    return;
  }

  for (let i = 0; i < count; i += 1) {
    try {
      await closeButtons.nth(i).click({ timeout: 5_000 });
      await page.waitForTimeout(500);
      console.log("dialog button clicked");
    } catch {
      // Continue if another click already changed the dialog.
    }
  }
}

async function openMenu(page) {
  if (MENU_SELECTOR) {
    await page.locator(MENU_SELECTOR).click({ timeout: 10_000 });
    console.log("menu clicked by selector");
    return;
  }

  if (!MENU_LABEL) {
    throw new Error("Set MENU_LABEL or MENU_SELECTOR.");
  }

  const menu = page.getByRole("button", {
    name: MENU_LABEL,
    exact: true,
  });

  try {
    await menu.click({ timeout: 10_000 });
    console.log("menu clicked by role");
    return;
  } catch {
    // Throw with the configured lookup values below.
  }

  throw new Error(
    "Menu control was not found. Run lume-check with debug artifact if labels or selectors need inspection."
  );
}

async function clickActionMenuItem(page) {
  const menuItem = page.getByRole("menuitem", {
    name: ACTION_LABEL,
    exact: true,
  });

  try {
    await menuItem.click({ timeout: 15_000 });
    console.log("action clicked by role");
    return;
  } catch {
    // Fallback for labels that are exposed only as text.
  }

  await page.getByText(ACTION_LABEL, { exact: true }).click({ timeout: 15_000 });
  console.log("action clicked by text");
}

async function readDownloadText(download) {
  try {
    const downloadPath = await download.path();

    if (downloadPath) {
      return await fs.readFile(downloadPath, "utf8");
    }

    const stream = await download.createReadStream();
    if (!stream) {
      throw new Error("Download stream was not available.");
    }

    return await streamToText(stream);
  } finally {
    await cleanupDownload(download);
  }
}

async function cleanupDownload(download) {
  try {
    await download.delete();
  } catch {
    console.warn("download cleanup skipped; runner cleanup will remove it at job end.");
  }
}

function parseSourceHtml(html) {
  const root = parse(html);

  return root
    .querySelectorAll("p")
    .map((p, index) => {
      const spans = p.querySelectorAll("span");
      if (spans.length === 0) return null;

      const first = normalizeText(spans[0]?.textContent || "");

      let tab = "main";
      let name = "";
      let text = "";

      if (/^\[[^\]]+\]$/.test(first)) {
        tab = first.replace("[", "").replace("]", "").trim();
        name = normalizeText(spans[1]?.textContent || "");
        text = normalizeText(spans.slice(2).map((s) => s.textContent || "").join("\n"));
      } else {
        tab = "";
        name = normalizeText(spans[0]?.textContent || "");
        text = normalizeText(spans.slice(1).map((s) => s.textContent || "").join("\n"));
      }

      const style = p.getAttribute("style") || "";
      const color = (style.match(/color\s*:\s*([^;]+)/i)?.[1] || "").trim();

      return {
        index,
        tab,
        name,
        text: text || "（本文なし）",
        color,
      };
    })
    .filter((item) => item && item.name);
}

async function postCycle(payload) {
  const res = await fetch(`${WOLUME_ENDPOINT}/runner/cycle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RUNNER_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`runner cycle error ${res.status}; check Worker logs for details.`);
  }

  logCycleResponse(body);
}

function logCycleResponse(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.log("cycle ok");
    return;
  }

  if (parsed?.ok === false) {
    throw new Error(
      `cycle reported failure mode=${parsed.mode || "unknown"} failed=${
        Number(parsed.failed) || 0
      }`
    );
  }

  console.log(
    `cycle ok mode=${parsed.mode || "unknown"} total=${
      Number(parsed.total) || 0
    } sent=${Number(parsed.sent) || 0} tabs=${Number(parsed.tabs) || 0}`
  );
}

async function prepareDebugDir() {
  if (debugDirReady) {
    return;
  }

  await fs.rm(DEBUG_DIR, { recursive: true, force: true });
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  debugDirReady = true;
}

async function writeSummary(summary) {
  if (!WRITE_SUMMARY) {
    return;
  }

  await prepareDebugDir();
  await fs.writeFile(`${DEBUG_DIR}/summary.json`, JSON.stringify(summary, null, 2), "utf8");
}

async function writeTargetFailureDebug(page, targetIndex, failure) {
  if (!WRITE_DEBUG) {
    return;
  }

  const targetPrefix = `target-${String(targetIndex + 1).padStart(2, "0")}`;
  await writeDebugText(
    `${targetPrefix}-error.txt`,
    [
      failure.code,
      failure.message,
      failure.detail || "",
      "",
      "--- raw redacted error ---",
      failure.rawMessage || "",
    ].join("\n")
  );

  try {
    await saveScreenshot(page, `${targetPrefix}-error`);
    await saveClickables(page, `${targetPrefix}-clickables-on-error.json`);
  } catch {
    // Best-effort diagnostics only.
  }
}

async function writeDebugText(filename, content) {
  if (!WRITE_DEBUG) {
    return;
  }

  await prepareDebugDir();
  await fs.writeFile(`${DEBUG_DIR}/${filename}`, content, "utf8");
}

async function saveScreenshot(page, name) {
  if (!WRITE_DEBUG) {
    return;
  }

  await prepareDebugDir();
  await page.screenshot({
    path: `${DEBUG_DIR}/${name}.png`,
    fullPage: true,
  });
}

async function saveClickables(page, filename) {
  if (!WRITE_DEBUG) {
    return;
  }

  await prepareDebugDir();

  const items = await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }

    return [...document.querySelectorAll("button, [role='button'], [aria-label], [title], a")]
      .filter(visible)
      .slice(0, 300)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();

        return {
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          title: el.getAttribute("title") || "",
          text: String(el.textContent || "").trim().slice(0, 120),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });
  });

  await fs.writeFile(`${DEBUG_DIR}/${filename}`, JSON.stringify(items, null, 2), "utf8");
}

function summarizeItem(item) {
  if (!item) return null;

  return {
    tab: item.tab,
    name: item.name,
    textPreview: item.text.slice(0, 80),
    color: item.color,
  };
}

function normalizeText(value) {
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function parseList(value) {
  return String(value)
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildStorageStateContextOption() {
  const raw = String(CCFOLIA_STORAGE_STATE_JSON || "").trim();
  if (!raw) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RunnerConfigError(
      "ccfolia-storage-state-invalid",
      "GitHub Secret CCFOLIA_STORAGE_STATE_JSON がJSONとして読めません。storageState.json の中身全体を入れ直してください。"
    );
  }

  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const origins = Array.isArray(parsed?.origins) ? parsed.origins : [];
  if (cookies.length === 0 && origins.length === 0) {
    throw new RunnerConfigError(
      "ccfolia-storage-state-empty",
      "GitHub Secret CCFOLIA_STORAGE_STATE_JSON にPlaywright storageStateデータが入っていません。storageState.json を作り直してください。"
    );
  }

  return {
    storageState: {
      cookies,
      origins,
    },
  };
}

function parseOptionalIntegerEnv(name, { min = 0, max = 10_000 } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    return null;
  }

  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}.`
    );
  }

  return value;
}

function parseIntegerEnv(name, defaultValue, { min = 0, max = 10_000 } = {}) {
  return parseOptionalIntegerEnv(name, { min, max }) ?? defaultValue;
}

async function loadRunnerTargets() {
  if (!WOLUME_ENDPOINT) {
    throw new Error("missing env: WOLUME_ENDPOINT");
  }
  if (!RUNNER_TOKEN) {
    throw new Error("missing env: RUNNER_TOKEN");
  }

  const endpoint = new URL(`${WOLUME_ENDPOINT}/runner/targets`);
  if (WOLUME_GUILD_ID) {
    endpoint.searchParams.set("guild_id", WOLUME_GUILD_ID);
  }

  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${RUNNER_TOKEN}`,
    },
  });
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`runner targets error ${res.status}; check Worker logs for details.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`runner targets response is not valid JSON: ${error.message}`);
  }

  const entries = parsed.targets || [];
  if (!Array.isArray(entries)) {
    throw new Error("runner targets response must contain targets array.");
  }

  const targets = entries.map((entry, index) => normalizeRunnerTarget(entry, index));
  validateTargets(targets);
  return targets;
}

function normalizeRunnerTarget(entry, index) {
  const sourceId = String(entry?.sourceId || entry?.source_id || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) {
    throw new Error(`target[${index}] sourceId is invalid.`);
  }

  const tabs = parseTargetTabs(entry?.tabs);
  const checkTabs = parseTargetTabs(entry?.checkTabs || entry?.check_tabs);

  return {
    sourceId,
    url: normalizeTargetUrl(entry?.url || entry?.targetUrl || "", index),
    tabs,
    checkTabs: checkTabs.length > 0 ? checkTabs : tabs,
  };
}

function parseTargetTabs(value) {
  return parseList(Array.isArray(value) ? value.join("\n") : value || "");
}

function normalizeTargetUrl(value, index) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error(`target[${index}] is missing url.`);
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`target[${index}] url is invalid.`);
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "ccfolia.com" ||
    !isCcfRoomPath(url.pathname)
  ) {
    throw new Error(`target[${index}] url must be a ccfolia room URL.`);
  }

  url.pathname = url.pathname.replace(/\/+$/g, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isCcfRoomPath(pathname) {
  return /^\/rooms\/[^/]+\/?$/.test(String(pathname || ""));
}

function normalizeOptionalDiscordId(value, name) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (!/^\d{10,30}$/.test(raw)) {
    throw new Error(`${name} must be a Discord snowflake id.`);
  }

  return raw;
}

function validateTargets(targets) {
  if (MAX_TARGETS != null && targets.length > MAX_TARGETS) {
    throw new Error(
      `Too many targets. Reduce active Wolume sources to ${MAX_TARGETS} or fewer entries, or raise MAX_TARGETS intentionally.`
    );
  }

  const sourceIds = new Set();
  const urls = new Set();

  for (const target of targets) {
    if (sourceIds.has(target.sourceId)) {
      throw new Error("runner targets response contains duplicate sourceIds.");
    }
    sourceIds.add(target.sourceId);

    if (urls.has(target.url)) {
      throw new Error("runner targets response contains duplicate target URLs.");
    }
    urls.add(target.url);
  }
}

function normalizeBaseEndpoint(value) {
  const raw = String(value || "").trim().replace(/\/+$/g, "");
  if (!raw) {
    return "";
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WOLUME_ENDPOINT is invalid.");
  }

  if (url.protocol !== "https:") {
    throw new Error("WOLUME_ENDPOINT must be https.");
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("WOLUME_ENDPOINT must be the Worker base URL without a path.");
  }

  url.hash = "";
  url.search = "";
  url.pathname = "/";
  return url.toString().replace(/\/+$/g, "");
}

function validateTargetTabs(targetTabs) {
  if (MAX_TABS_PER_TARGET != null && targetTabs.length > MAX_TABS_PER_TARGET) {
    throw new Error(
      `Too many tabs selected. Set TAB_LABELS to reduce the scope, or raise MAX_TABS_PER_TARGET intentionally.`
    );
  }

  const indexes = new Set();
  for (const tab of targetTabs) {
    if (indexes.has(tab.index)) {
      throw new Error("TAB_LABELS contains duplicate tabs.");
    }
    indexes.add(tab.index);
  }
}

async function politeDelay() {
  if (POLITE_DELAY_MS <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, POLITE_DELAY_MS));
}

function mustEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`missing env: ${name}`);
  }

  return value;
}

class RoomStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomStateError";
    this.code = code;
  }
}

class RunnerConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunnerConfigError";
    this.code = code;
  }
}

function normalizeRunnerFailure(error) {
  const rawMessage = redactText(error?.message || error || "");
  const code = normalizeFailureCode(error, rawMessage);
  const message = normalizeFailureMessage(rawMessage);
  const detail = normalizeFailureDetail(rawMessage);

  return {
    code,
    message,
    detail,
    rawMessage: rawMessage.trim().slice(0, 4_000),
  };
}

function normalizeFailureCode(error, rawMessage) {
  const fallback = /locator\.click: Timeout/i.test(rawMessage)
    ? "ui-click-timeout"
    : /Timeout \d+ms exceeded/i.test(rawMessage)
      ? "ui-timeout"
      : "log-export-failed";

  return String(error?.code || fallback)
    .replace(/[^a-z0-9_-]/gi, "-")
    .slice(0, 80) || fallback;
}

function normalizeFailureMessage(rawMessage) {
  const message = rawMessage
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  if (/locator\.click: Timeout/i.test(rawMessage)) {
    if (/\[role=['"]tab['"]\]/i.test(rawMessage)) {
      return "ココフォリアのチャットタブをクリックできませんでした。広告やダイアログ等が重なっている可能性があります。";
    }

    return "ココフォリア画面のクリック操作がタイムアウトしました。広告やダイアログ等が重なっている可能性があります。";
  }

  if (/Timeout \d+ms exceeded/i.test(rawMessage)) {
    return "ココフォリア画面の操作がタイムアウトしました。";
  }

  return message || "ココフォリア部屋のログ取得に失敗しました。";
}

function normalizeFailureDetail(rawMessage) {
  const compact = rawMessage.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  const timeout = compact.match(/Timeout \d+ms exceeded/i)?.[0] || "";

  if (/locator\.click: Timeout/i.test(rawMessage)) {
    const locator = compact.match(/waiting for locator\(([^)]+)\)/i)?.[1] || "";
    return [`locator.click`, timeout, locator ? `locator(${locator})` : ""]
      .filter(Boolean)
      .join(" / ")
      .slice(0, 240);
  }

  if (timeout) {
    return timeout.slice(0, 240);
  }

  return compact.slice(0, 240);
}

main().catch((error) => {
  console.error(redactError(error));
  process.exit(1);
});

function redactError(error) {
  return redactText(error?.stack || error || "unknown error");
}

function redactText(value) {
  return String(value).replace(
    /https:\/\/ccfolia\.com\/rooms\/[^\s"'<>\\)]+/g,
    "[ccfolia-room-url]"
  );
}
