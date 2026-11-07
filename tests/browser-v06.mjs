import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("artifacts", { recursive: true });
const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(60000);
const errors = [],
  outside = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (!/^(http:\/\/127\.0\.0\.1:5173|blob:|data:)/.test(r.url()))
    outside.push(r.url());
});
const nav = async (n) => page.locator(`[data-page="${n}"]`).first().click(),
  action = async (n) => page.locator(`[data-net-action="${n}"]`).click();
async function run(n = "run") {
  await action(n);
  await page.locator("#network-result").waitFor();
  assert.equal(await page.locator('#network-page [role="alert"]').count(), 0);
}
async function download(actionName, name) {
  const d = page.waitForEvent("download");
  await action(actionName);
  await (await d).saveAs(name);
  return JSON.parse(await readFile(name, "utf8"));
}
try {
  await page.goto("http://127.0.0.1:5173");
  await nav(11);
  await action("sample");
  await page
    .locator("#net-competition")
    .evaluate((el) => (el.closest("details").open = true));
  await page.locator("#net-diagnostic").selectOption("full");
  await action("save-settings");
  await run();
  assert.match(
    await page.locator("#assignment-diagnostic").innerText(),
    /収支エラー 0件/,
  );
  await page.locator("#diag-time").fill("26460");
  await page.locator("#diag-time").dispatchEvent("change");
  assert.match(
    await page.locator("#assignment-diagnostic").innerText(),
    /徒歩・乗換中 40人/,
  );
  let r = await download("diagnostic-json", "artifacts/v06-diagnostic.json");
  assert.ok(r.audit.events.some((e) => e.kind === "reroute"));
  assert.ok(r.packets.some((p) => p.parentId !== undefined));
  await page.locator("#diag-demand").selectOption("0");
  await page.screenshot({
    path: "artifacts/v06-diagnostic-desktop.png",
    fullPage: true,
  });
  await run("precision");
  assert.equal(
    await page
      .locator("#precision-comparison > .table-wrap")
      .first()
      .locator("tbody tr")
      .count(),
    4,
  );
  r = await download("result-json", "artifacts/v06-precision.json");
  assert.equal(r.comparisonResults.length, 4);
  assert.deepEqual(
    r.comparisonResults.map((r) => r.capacity.totals.completed),
    [40, 44, 40, 40],
  );
  await run("scenario-range");
  assert.equal(
    await page
      .locator("#precision-comparison > .table-wrap")
      .first()
      .locator("tbody tr")
      .count(),
    11,
  );
  assert.match(
    await page.locator("#precision-comparison").innerText(),
    /統計的な信頼区間ではありません/,
  );
  await page
    .locator("#net-competition")
    .evaluate((el) => (el.closest("details").open = true));
  await page.locator("#net-timing").selectOption("weighted");
  await page.locator("#net-integration").fill("5");
  await action("save-settings");
  const workspace = await download("workspace", "artifacts/v06-workspace.json");
  assert.equal(workspace.integration.config.competition, "simultaneous");
  await page.reload();
  await nav(11);
  assert.equal(await page.locator("#net-timing").inputValue(), "weighted");
  assert.equal(await page.locator("#net-diagnostic").inputValue(), "full");
  await run();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/v06-diagnostic-mobile.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    document.querySelector("[data-net-action=run]").click();
    document.querySelector("[data-net-action=cancel]")?.click();
  });
  assert.equal(await page.locator("#network-result").count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  await writeFile(
    "artifacts/v06-browser-report.json",
    JSON.stringify(
      {
        errors,
        outside,
        performance: await page.evaluate(() => globalThis.railwayPerformance),
      },
      null,
      2,
    ),
  );
  console.log(
    "Chrome 0.6 passed: simultaneous capacity, full traces and splits, intermediate conservation, four timing methods, eleven assumption variants, export/restore, cancel and 390px.",
  );
} catch (e) {
  await page.screenshot({ path: "artifacts/v06-failure.png", fullPage: true });
  console.error((await page.locator("main").innerText()).slice(-1800));
  throw e;
} finally {
  await browser.close();
}
