import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
const errors = [],
  outside = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (!/^(http:\/\/127\.0\.0\.1:5173|data:|blob:)/.test(r.url()))
    outside.push(r.url());
});
await mkdir("artifacts", { recursive: true });
const nav = async (n) => page.locator(`[data-page="${n}"]`).first().click();
async function run(action = "run") {
  await page.locator(`[data-net-action="${action}"]`).click();
  await page.locator("#network-result").waitFor({ timeout: 120000 });
  assert.equal(await page.locator('#network-page [role="alert"]').count(), 0);
}
async function download(action, path) {
  const d = page.waitForEvent("download");
  await page.locator(`[data-net-action="${action}"]`).click();
  await (await d).saveAs(path);
  return readFile(path, "utf8");
}
try {
  await page.goto("http://127.0.0.1:5173/");
  await nav(11);
  await page.locator('[data-net-action="sample"]').click();
  assert.match(await page.locator("#network-progress").innerText(), /架空/);
  await run();
  let body = await page.locator("#network-result").innerText();
  assert.match(body, /輸送完了\s*40/);
  assert.match(body, /経路なし\s*20/);
  assert.match(body, /乗車イベント 80/);
  const busKey = JSON.stringify(["fiction-bus", "weekday", "same-id"]);
  await page.locator("#net-analysis-train").selectOption(busKey);
  assert.match(
    await page.locator("#network-train-detail").innerText(),
    /最大車内 25人/,
  );
  assert.match(
    await page.locator("#network-train-detail").innerText(),
    /うち乗換乗車/,
  );
  const result = JSON.parse(
    await download("result-json", "artifacts/v05-result.json"),
  );
  assert.equal(result.result.capacity.totals.selected, 60);
  assert.equal(result.result.capacity.totals.completed, 40);
  assert.ok(
    result.result.capacity.events.every((e) => e.datasetId && e.eventId),
  );
  await download("od-csv", "artifacts/v05-od.csv");
  await download("paths-csv", "artifacts/v05-paths.csv");
  await download("untransported-csv", "artifacts/v05-untransported.csv");
  await page.screenshot({
    path: "artifacts/v05-network-desktop.png",
    fullPage: true,
  });
  await page.locator("#net-distribution").selectOption("front");
  assert.equal(await page.locator("#network-result").count(), 0);
  await page.locator('[data-net-action="run"]').click();
  assert.match(
    await page.locator('#network-page [role="alert"]').innerText(),
    /保存/,
  );
  assert.equal(await page.locator("#net-distribution").inputValue(), "front");
  await page.locator('[data-net-action="save-settings"]').click();
  await run("compare-arrival");
  assert.equal(await page.locator("#net-result-index option").count(), 2);
  assert.match(
    await page.locator("#network-result").innerText(),
    /輸送完了\s*54/,
  );
  await page.locator("#net-result-index").selectOption("0");
  assert.match(
    await page.locator("#network-result").innerText(),
    /輸送完了\s*40/,
  );
  await page.locator("#net-result-index").selectOption("1");
  await page.locator("#net-horizon").fill("07:21:40");
  await page.locator("#net-horizon").press("Tab");
  await page.locator('[data-net-action="save-settings"]').click();
  await run();
  assert.match(
    await page.locator("#network-result").innerText(),
    /徒歩・アクセス中\s*54/,
  );
  assert.match(
    await page.locator("#network-result").innerText(),
    /輸送完了\s*0/,
  );
  await page.locator("#net-horizon").fill("08:00");
  await page.locator("#net-horizon").press("Tab");
  await page.locator('[data-net-action="save-settings"]').click();
  await page.locator('[data-net-toggle="fiction-walk"]').click();
  await run();
  assert.match(
    await page.locator("#network-result").innerText(),
    /経路なし\s*60/,
  );
  await page.locator('[data-net-toggle="fiction-walk"]').click();
  await run();
  assert.match(
    await page.locator("#network-result").innerText(),
    /輸送完了\s*54/,
  );
  await page.evaluate(() => {
    document.querySelector('[data-net-action="run"]').click();
    document.querySelector('[data-net-action="cancel"]').click();
  });
  assert.equal(await page.locator("#network-result").count(), 0);
  assert.match(await page.locator("#network-progress").innerText(), /中止/);
  await run();
  const saved = JSON.parse(
    await download("workspace", "artifacts/v05-workspace.json"),
  );
  assert.equal(saved.integration.version, 1);
  assert.equal(
    saved.integration.demands[0].destinationDatasetId,
    "fiction-bus",
  );
  assert.equal(saved.transferLinks[0].additionalTransferSeconds, 60);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/v05-network-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page
    .getByRole("heading", { name: "ダッシュボード", exact: true })
    .waitFor();
  await nav(11);
  await page.locator('[data-net-use="fiction-rail"]:checked').waitFor();
  await run();
  assert.match(
    await page.locator("#network-result").innerText(),
    /輸送完了\s*54/,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(
    "Chrome v0.5 passed: integrated rail/bus capacity, explicit walking, scoped IDs, arrival distributions and legacy comparison, walking cutoff, disabled links, cancellation, CSV/JSON, persistence, mobile.",
  );
} catch (error) {
  console.error((await page.locator("main").innerText()).slice(-4000));
  await page.screenshot({ path: "artifacts/v05-failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}
