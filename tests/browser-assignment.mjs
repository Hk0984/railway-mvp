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
page.setDefaultTimeout(60000);
const errors = [],
  outside = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (!/^(http:\/\/127\.0\.0\.1:5173|data:|blob:)/.test(r.url()))
    outside.push(r.url());
});
await mkdir("artifacts", { recursive: true });
async function exportProject(path) {
  await page.locator('[data-page="1"]').click();
  const d = page.waitForEvent("download");
  await page.locator('[data-action="json"]').click();
  await (await d).saveAs(path);
  return JSON.parse(await readFile(path, "utf8"));
}
async function importProject(p, path) {
  await writeFile(path, JSON.stringify(p));
  await page.locator('[data-page="1"]').click();
  await page.locator('[data-file="json"]').setInputFiles(path);
  await page
    .getByRole("status")
    .filter({ hasText: "を読み込みました" })
    .waitFor();
}
function demand(p, o, d, amount = 100) {
  const row = {
    origin: o,
    destination: d,
    purpose: "commute",
    kind: "outbound",
    source: "manual",
    passengers: amount,
  };
  const config = structuredClone(template.temporal.config);
  config.slotMinutes = 60;
  config.purposes.forEach((p) => {
    p.timeWeights = Array(24).fill(1);
    p.returnShare = 0;
  });
  p.temporal = {
    config,
    costs: {},
    dailyOutbound: [row],
    daily: [row],
    slots: [{ ...row, start: 25200, end: 28800 }],
    generated: amount,
    unallocated: 0,
    warnings: [],
  };
  p.temporalConfig = config;
}
async function run(compare = false) {
  await page.locator('[data-page="9"]').click();
  await page
    .locator(`[data-assignment-action="${compare ? "compare" : "run"}"]`)
    .click();
  try {
    await page
      .locator("#assignment-progress")
      .filter({ hasText: "計算終了" })
      .waitFor({ timeout: 120000 });
  } catch (error) {
    console.error(await page.locator("#assignment-page").innerText());
    throw error;
  }
  assert.equal(
    await page.locator('#assignment-page [role="alert"]').count(),
    0,
  );
  assert.match(
    await page.locator("#assignment-page").innerText(),
    /需要の収支差\s*0/,
  );
}
let template;
try {
  await page.goto("http://127.0.0.1:5173/");
  await page.locator('[data-page="7"]').click();
  await page.locator('[data-temporal-action="generate"]').click();
  template = await exportProject("artifacts/assignment-template.json");
  const p = structuredClone(template);
  p.datasetId = "browser-assignment";
  p.name = "配分検証";
  p.types = [
    { id: "local", name: "旅客便" },
    { id: "rapid", name: "回送" },
  ];
  p.serviceClasses = {
    types: {
      local: { state: "passenger", basis: "テスト設定" },
      rapid: { state: "nonPassenger", basis: "テスト設定" },
    },
    trains: {},
  };
  p.timetables = [
    {
      id: "test",
      name: "乗換検証",
      trains: [
        {
          id: "a",
          number: "A",
          typeId: "local",
          direction: "down",
          stops: [
            { stationId: "s0", status: "stop", departure: 27000 },
            { stationId: "s2", status: "stop", arrival: 27600 },
          ],
        },
        {
          id: "b",
          number: "B",
          typeId: "local",
          direction: "down",
          stops: [
            { stationId: "s2", status: "stop", departure: 27720 },
            { stationId: "s4", status: "stop", arrival: 28200 },
          ],
        },
        {
          id: "c",
          number: "C",
          typeId: "rapid",
          direction: "down",
          stops: [
            { stationId: "s0", status: "stop", departure: 27000 },
            { stationId: "s4", status: "stop", arrival: 27500 },
          ],
        },
      ],
    },
  ];
  delete p.oud2;
  delete p.assignmentConfig;
  demand(p, "s0", "s4");
  await importProject(p, "artifacts/assignment-input.json");
  await run(true);
  // Uniform arrivals 07:00–08:00: the first half boards A then B, the second half remains unallocated.
  let body = await page.locator("#assignment-page").innerText();
  assert.match(body, /配分済み\s*50/);
  assert.match(body, /未配分需要\s*50/);
  assert.match(body, /乗車イベント 100/);
  assert.equal(await page.locator("[data-assignment-load]").count(), 2);
  await page.locator("#assignment-result-method").selectOption("logit");
  assert.match(
    await page.locator("#assignment-page").innerText(),
    /配分済み\s*50/,
  );
  assert.match(
    await page.locator("#train-load-detail").innerText(),
    /定員不明/,
  );
  for (const action of [
    "trains-csv",
    "segments-csv",
    "allocations-csv",
    "unallocated-csv",
  ]) {
    const d = page.waitForEvent("download");
    await page.locator(`[data-assignment-action="${action}"]`).click();
    const download = await d;
    await download.saveAs("artifacts/" + download.suggestedFilename());
    assert.ok(
      (await readFile("artifacts/" + download.suggestedFilename(), "utf8"))
        .length > 100,
    );
  }
  await page.locator('[data-page="8"]').first().click();
  await page.locator('[data-type-capacity-enable="local"]').check();
  await page.locator('[data-type-capacity="local"]').fill("25");
  await page.locator('[data-type-capacity="local"]').press("Tab");
  await run();
  assert.match(await page.locator("#train-load-detail").innerText(), /200%/);
  await page.screenshot({
    path: "artifacts/assignment-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/assignment-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  // Explicit per-train override, persisted with capacity and old JSON-compatible schema.
  await page.locator('[data-page="8"]').first().click();
  await page.locator('[data-class-train="a"][value="nonPassenger"]').check();
  await run();
  assert.match(
    await page.locator("#assignment-page").innerText(),
    /未配分需要\s*100/,
  );
  const saved = await exportProject("artifacts/assignment-saved.json");
  assert.equal(saved.typeCapacities.local, 25);
  assert.equal(
    Object.values(saved.serviceClasses.trains)[0].state,
    "nonPassenger",
  );
  for (const file of [
    "琴町線.oud2",
    "堀電バス［は01］［は02］［は03］［北11］.oud2",
  ]) {
    await page
      .locator('[data-file="oud2"]')
      .setInputFiles("tests/fixtures/real/" + file);
    await page
      .getByRole("status")
      .filter({ hasText: "基本データを取り込みました" })
      .waitFor();
    await page.locator('[data-page="8"]').first().click();
    assert.match(
      await page.locator("#classification-page").innerText(),
      /営業（運休除外）\s*0/,
    );
    await page.locator('[data-class-action="preset"]').click();
    const real = await exportProject(
      "artifacts/assignment-" +
        (file.startsWith("琴") ? "rail" : "bus") +
        ".json",
    );
    demand(
      real,
      file.startsWith("琴") ? "oud-s23" : "oud-s0",
      file.startsWith("琴") ? "oud-s31" : "oud-s20",
      101,
    );
    await importProject(real, "artifacts/assignment-real-input.json");
    await run();
    assert.ok(await page.locator("[data-assignment-load]").count());
    assert.match(
      await page.locator("#assignment-page").innerText(),
      /対象時間窓の需要\s*101/,
    );
    await page.screenshot({
      path:
        "artifacts/assignment-" +
        (file.startsWith("琴") ? "rail" : "bus") +
        ".png",
      fullPage: false,
    });
    await page.locator('[data-page="1"]').click();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(
    "Chrome assignment: synthetic transfer, conservation, logit comparison, capacity, override, 4 CSVs, mobile, rail 峰浜→燕崎 and bus 北斗本町駅→下松山営業所 passed.",
  );
} finally {
  await browser.close();
}
