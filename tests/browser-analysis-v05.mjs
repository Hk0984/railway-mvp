import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
async function exportProject(path) {
  await nav(1);
  const d = page.waitForEvent("download");
  await page.locator('[data-action="json"]').click();
  await (await d).saveAs(path);
  return JSON.parse(await readFile(path, "utf8"));
}
try {
  await page.goto("http://127.0.0.1:5173/");
  await nav(7);
  await page.locator('[data-temporal-action="generate"]').click();
  const before = await exportProject("artifacts/v05-model-before.json");
  await nav(10);
  const text =
    "kind,stationId,origin,destination,timetableId,trainId,segmentIndex,period,value,source,role\nboarding,s0,,,,,,人工日間観測,500,検証用の人工値,fit\nod,,s0,s4,,,,人工日間観測,150,学習しない人工検証値,validation";
  await writeFile("artifacts/v05-model-observations.csv", text);
  await page
    .locator("#observation-file")
    .setInputFiles("artifacts/v05-model-observations.csv");
  await page.locator("#lab-status").filter({ hasText: "2件" }).waitFor();
  await page.locator("#lab-trip-ends").check();
  await page.locator('[data-lab-action="calibrate"]').click();
  assert.equal(
    await page.locator("#independent-validation svg circle").count(),
    1,
  );
  assert.match(
    await page.locator("#independent-validation").innerText(),
    /平均誤差/,
  );
  assert.match(
    await page.locator("#independent-validation").innerText(),
    /過大|過小/,
  );
  await page.locator("#sensitivity-method").selectOption("logit");
  await page.locator('[data-lab-action="sensitivity"]').click();
  await page.locator("#sensitivity-result").waitFor({ timeout: 120000 });
  assert.equal(await page.locator("#sensitivity-result tbody tr").count(), 9);
  assert.equal(await page.locator('#analytics-page [role="alert"]').count(), 0);
  let d = page.waitForEvent("download");
  await page.locator('[data-lab-action="sensitivity-json"]').click();
  await (await d).saveAs("artifacts/v05-sensitivity.json");
  const sensitivity = JSON.parse(
    await readFile("artifacts/v05-sensitivity.json", "utf8"),
  );
  assert.equal(sensitivity.rows.length, 9);
  assert.ok(sensitivity.rows.every((r) => !r.error));
  await page.screenshot({
    path: "artifacts/v05-model-validation-sensitivity.png",
    fullPage: true,
  });
  await page.locator("#compare-origin").selectOption("s0");
  await page.locator("#compare-destination").selectOption("s4");
  await page.locator('[data-lab-action="compare"]').click();
  await page.locator("#passenger-benefits").waitFor({ timeout: 120000 });
  assert.match(
    await page.locator("#passenger-benefits").innerText(),
    /比較対象外/,
  );
  d = page.waitForEvent("download");
  await page.locator('[data-lab-action="comparison-json"]').click();
  await (await d).saveAs("artifacts/v05-benefits.json");
  const compare = JSON.parse(
    await readFile("artifacts/v05-benefits.json", "utf8"),
  ).comparison;
  assert.equal(compare.benefits.comparable, true);
  assert.equal(compare.benefits.travelChangePersonSeconds, 0);
  assert.equal(compare.benefits.worsened, 0);
  assert.equal(compare.benefits.improved, 0);
  assert.ok(compare.rows.some((r) => r.label.includes("総旅客時間")));
  d = page.waitForEvent("download");
  await page.locator('[data-lab-action="benefits-csv"]').click();
  await (await d).saveAs("artifacts/v05-benefits.csv");
  const after = await exportProject("artifacts/v05-model-after.json");
  assert.deepEqual(after.temporal, before.temporal);
  assert.deepEqual(after.stations, before.stations);
  await nav(10);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/v05-model-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(
    "Chrome v0.5 model checks passed: held-out scatter/mean error, 9 sensitivity conditions, immutable source demand, fixed-demand weighted benefits, exports and mobile.",
  );
} catch (error) {
  console.error((await page.locator("main").innerText()).slice(-3000));
  throw error;
} finally {
  await browser.close();
}
