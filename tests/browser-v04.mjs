import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
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
async function exportJson(path) {
  await nav(1);
  const d = page.waitForEvent("download");
  await page.locator('[data-action="json"]').click();
  await (await d).saveAs(path);
  return JSON.parse(await readFile(path, "utf8"));
}
async function number(id, value) {
  await page.locator("#" + id).fill(value);
  await page.locator("#" + id).press("Tab");
}
async function run() {
  await page.locator('[data-assignment-action="run"]').click();
  await page
    .locator("#assignment-progress")
    .filter({ hasText: "計算終了" })
    .waitFor({ timeout: 120000 });
}
try {
  await page.goto("http://127.0.0.1:5173/");
  const cdp = await page.context().newCDPSession(page);
  const heapBefore = await cdp.send("Runtime.getHeapUsage");
  await nav(7);
  await page.locator('[data-temporal-action="generate"]').click();
  await nav(9);
  const p = await exportJson("artifacts/v04-template.json");
  const t = (id, dep, arr) => ({
    id,
    number: id,
    typeId: "local",
    direction: "down",
    stops: [
      { stationId: "s0", status: "stop", departure: dep },
      {
        stationId: "s2",
        status: "stop",
        arrival: dep + 600,
        departure: dep + 720,
      },
      { stationId: "s4", status: "stop", arrival: arr },
    ],
  });
  p.datasetId = "v04-browser";
  p.name = "容量検証";
  p.timetables = [
    {
      id: "after",
      name: "増便後",
      trains: [t("a", 25800, 27600), t("b", 27000, 28800)],
    },
    { id: "before", name: "増便前", trains: [t("a", 25800, 27600)] },
  ];
  p.serviceClasses = {
    types: {
      local: { state: "passenger", basis: "試験で営業と明示" },
      rapid: { state: "nonPassenger", basis: "試験で非営業と明示" },
    },
    trains: {},
  };
  delete p.analytics;
  delete p.capacitySettings;
  delete p.typeCapacities;
  const config = p.temporal.config;
  config.slotMinutes = 15;
  config.rounding = "integer";
  config.purposes.forEach((x) => {
    x.timeWeights = Array(96).fill(1);
    x.returnShare = 0;
  });
  const row = {
    origin: "s0",
    destination: "s4",
    purpose: "commute",
    kind: "outbound",
    source: "manual",
    passengers: 100,
  };
  p.temporal = {
    config,
    costs: p.costs,
    dailyOutbound: [row],
    daily: [row],
    slots: [{ ...row, start: 25200, end: 26100 }],
    generated: 100,
    unallocated: 0,
    warnings: [],
  };
  p.assignmentConfig = {
    ...p.assignmentConfig,
    capacityConstrained: true,
    integer: true,
    start: 25200,
    end: 32400,
    simulationEnd: 32400,
  };
  await writeFile("artifacts/v04-input.json", JSON.stringify(p));
  await page
    .locator('[data-file="json"]')
    .setInputFiles("artifacts/v04-input.json");
  await page
    .getByRole("status")
    .filter({ hasText: "v04-input.json を読み込みました" })
    .waitFor();
  await nav(9);
  await page.locator('[data-assignment-action="run"]').click();
  await page
    .locator('[role="alert"]')
    .filter({ hasText: "輸送定員が不明" })
    .waitFor();
  await nav(8);
  for (const id of ["after", "before"]) {
    await page.locator("#capacity-target").fill(id);
    await page.locator("#capacity-value").fill("30");
    await page.locator("#capacity-basis").fill("Chrome検証用の設定輸送定員");
    await page.locator("#capacity-vehicle").fill("テスト車両");
    await page.locator('[data-capacity-action="apply"]').click();
  }
  await nav(9);
  await run();
  const body = await page.locator("#capacity-result").innerText();
  assert.match(body, /目的地へ輸送完了\s*60/);
  assert.match(body, /駅で待機\s*40/);
  assert.match(body, /人数収支差\s*0/);
  assert.match(body, /100%/);
  for (const action of ["capacity-events", "capacity-states", "segments-csv"]) {
    const d = page.waitForEvent("download");
    await page.locator(`[data-assignment-action="${action}"]`).click();
    await (await d).saveAs("artifacts/v04-" + action + ".csv");
  }
  await page.screenshot({
    path: "artifacts/v04-capacity-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/v04-capacity-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.locator("#assignment-capacity").selectOption("off");
  await run();
  assert.match(
    await page.locator("#assignment-page").innerText(),
    /配分済み\s*100/,
  );
  await page.locator("#assignment-capacity").selectOption("on");
  await run();
  await page.locator('[data-assignment-action="capacity-compare"]').click();
  await page.locator("#capacity-comparison").waitFor();
  assert.match(
    await page.locator("#capacity-comparison").innerText(),
    /最大断面需要/,
  );
  await page.locator("#assignment-capacity-view").selectOption("fastest");
  assert.match(
    await page.locator("#assignment-page").innerText(),
    /配分済み\s*100/,
  );
  await page
    .locator("#assignment-capacity-view")
    .selectOption("fastest:capacity");
  assert.match(
    await page.locator("#capacity-result").innerText(),
    /目的地へ輸送完了\s*60/,
  );
  await page.evaluate(() => {
    document.querySelector('[data-assignment-action="run"]').click();
    document.querySelector('[data-assignment-action="cancel"]').click();
  });
  assert.match(
    await page.locator("#assignment-page").innerText(),
    /計算を中止しました/,
  );
  await run();
  await nav(10);
  await page.locator('[data-lab-action="scenario-snapshot"]').click();
  const header =
    "kind,stationId,origin,destination,timetableId,trainId,segmentIndex,period,value,source,role";
  const obs = [
    header,
    "boarding,s0,,,,,,weekday-outbound,200,検証用観測,fit",
    "od,,s0,s4,,,,weekday-outbound,200,検証用観測,fit",
    "od,,s1,s3,,,,weekday-outbound,20,検証用観測,validation",
    "load,,,,after,a,0,weekday-outbound,30,検証用観測,validation",
  ].join("\n");
  await writeFile("artifacts/v04-observations.csv", obs);
  await page
    .locator("#observation-file")
    .setInputFiles("artifacts/v04-observations.csv");
  await page
    .locator("#lab-status")
    .filter({ hasText: "実測データ4件" })
    .waitFor();
  await page.locator("#lab-load-aligned").check();
  await page.locator('[data-lab-action="load-validate"]').click();
  assert.match(await page.locator("#lab-status").innerText(), /1件、MAE 0人/);
  await page.locator("#lab-trip-ends").check();
  await page.locator('[data-lab-action="calibrate"]').click();
  assert.match(await page.locator("#calibration-result").innerText(), /収束/);
  assert.match(
    await page.locator("#calibration-result").innerText(),
    /学習不使用/,
  );
  await page.locator('[data-lab-action="apply-calibration"]').click();
  await page.locator("#scenario-capacity").fill("45");
  await page.locator("#scenario-capacity").press("Tab");
  await page.locator('[data-lab-action="scenario-snapshot"]').click();
  assert.equal(await page.locator("[data-lab-scenario]").count(), 2);
  await page.locator("#compare-before").selectOption("before");
  await page.locator("#compare-after").selectOption("after");
  await page.locator("#compare-origin").selectOption("s0");
  await page.locator("#compare-destination").selectOption("s4");
  await page.locator('[data-lab-action="compare"]').click();
  await page.locator("#comparison-result").waitFor({ timeout: 120000 });
  assert.match(
    await page.locator("#comparison-result").innerText(),
    /固定需要/,
  );
  const d = page.waitForEvent("download");
  await page.locator('[data-lab-action="comparison-csv"]').click();
  await (await d).saveAs("artifacts/v04-comparison.csv");
  await page.screenshot({
    path: "artifacts/v04-calibration-comparison.png",
    fullPage: true,
  });
  await page.locator("#compare-mode").selectOption("scenario");
  await page.locator("#compare-scenario-b").selectOption({ index: 1 });
  await page.locator('[data-lab-action="compare"]').click();
  await page
    .locator("#comparison-result h2")
    .filter({ hasText: "シナリオ比較" })
    .waitFor({ timeout: 120000 });
  await page.locator("[data-lab-scenario]").first().click();
  const saved = await exportJson("artifacts/v04-saved.json");
  assert.equal(saved.analytics.scenarios[1].capacityOverride.value, 45);
  assert.equal(saved.analytics.observations.length, 4);
  assert.equal(saved.analytics.scenarios.length, 2);
  assert.ok(saved.analytics.calibrations[0].converged);
  assert.equal(saved.capacitySettings.timetables.after.value, 30);
  await page.reload();
  await page
    .getByRole("heading", { name: "ダッシュボード", exact: true })
    .waitFor();
  await nav(10);
  assert.equal(await page.locator("[data-lab-scenario]").count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/v04-analytics-mobile.png",
    fullPage: true,
  });
  await writeFile(
    "artifacts/browser-v04-memory.json",
    JSON.stringify(
      {
        note: "Chrome main-renderer JS heap only; Worker heaps excluded; not a peak measurement",
        before: heapBefore,
        after: await cdp.send("Runtime.getHeapUsage"),
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(
    "Chrome v0.4 passed: unknown capacity, metadata, constrained 60/40, unconstrained 100, cancellation, CSVs, observed import, train validation, IPF, scenarios, frozen-demand timetable/scenario comparison, persistence, mobile; no external requests.",
  );
} finally {
  await browser.close();
}
