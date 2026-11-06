import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
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
  if (
    !r.url().startsWith("http://127.0.0.1:5173") &&
    !r.url().startsWith("data:") &&
    !r.url().startsWith("blob:")
  )
    outside.push(r.url());
});
await mkdir("artifacts", { recursive: true });
async function change(id, value) {
  await page.locator("#" + id).fill(value);
  await page.locator("#" + id).press("Tab");
}
async function station(id, name) {
  const value = await page
    .locator("#" + id + "-list option")
    .evaluateAll(
      (options, name) =>
        options.find((o) => o.value.startsWith(name + " ｜"))?.value,
      name,
    );
  assert.ok(value, "station option " + name);
  await change(id, value);
}
async function downloadJson(action, path) {
  const promise = page.waitForEvent("download");
  await page.locator(`[data-action="${action}"]`).click();
  await (await promise).saveAs(path);
  return JSON.parse(await readFile(path, "utf8"));
}
try {
  await page.goto("http://127.0.0.1:5173/");
  await page.locator('[data-page="6"]').click();
  await page.locator('[data-route-action="search"]').click();
  assert.ok((await page.locator(".journey-card").count()) > 1);
  assert.ok(await page.locator(".journey-timeline").first().innerText());
  await page.screenshot({
    path: "artifacts/route-sample-desktop.png",
    fullPage: true,
  });
  const first = await page.locator(".journey-card summary").first().innerText();
  await page.locator('[data-route-action="next"]').click();
  assert.notEqual(
    await page.locator(".journey-card summary").first().innerText(),
    first,
  );
  await page.locator('[data-route-action="previous"]').click();
  await page.locator("#route-mode").selectOption("arrive");
  await change("route-time", "08:30");
  assert.ok(await page.locator(".journey-card").count());
  await page.locator("#route-sort").selectOption("riding");
  assert.ok(await page.locator(".journey-card").count());
  await page.locator('[data-page="7"]').click();
  await page.locator('[data-temporal-action="generate"]').click();
  assert.ok(
    (await page.locator("#temporal-page").innerText()).includes("差分 0人"),
  );
  await change("temporal-manual-daily", "300");
  await page.locator("#temporal-source").selectOption("observed");
  await page.locator('[data-temporal-action="daily"]').click();
  assert.ok(
    (await page.locator("#temporal-page").innerText()).includes("300人"),
  );
  const slot = page.locator("[data-slot-start]").first();
  await slot.fill("20");
  await slot.press("Tab");
  assert.ok(
    (await page.locator("#temporal-page").innerText()).includes("手動設定値"),
  );
  await page.locator("#temporal-slot").selectOption("15");
  assert.equal(await page.locator('[data-time-purpose="commute"]').count(), 96);
  assert.ok(
    (await page.locator("#temporal-page").innerText()).includes("差分 0人"),
  );
  const csvPromise = page.waitForEvent("download");
  await page.locator('[data-temporal-action="csv"]').click();
  assert.equal((await csvPromise).suggestedFilename(), "temporal-od.csv");
  await page.screenshot({
    path: "artifacts/temporal-desktop.png",
    fullPage: true,
  });
  await page.locator('[data-page="1"]').click();
  const sample = await downloadJson("json", "artifacts/sample-temporal.json");
  assert.ok(sample.temporal.slots.length);
  assert.equal(sample.temporal.config.slotMinutes, 15);
  for (const file of [
    "琴町線.oud2",
    "堀電バス［は01］［は02］［は03］［北11］.oud2",
  ]) {
    await page.locator('[data-page="1"]').click();
    await page
      .locator('[data-file="oud2"]')
      .setInputFiles("tests/fixtures/real/" + file);
    await page
      .getByRole("status")
      .filter({ hasText: "基本データを取り込みました" })
      .waitFor();
    await page.locator('[data-page="6"]').click();
    await page.locator("#route-sort").selectOption("arrival");
    await page.locator("#route-mode").selectOption("depart");
    await change("route-time", "07:00");
    const rail = file.startsWith("琴");
    await station("route-origin", rail ? "峰浜" : "北斗本町駅");
    await station("route-destination", rail ? "燕崎" : "下松山営業所");
    assert.ok(await page.locator(".journey-card").count());
    assert.ok(
      (
        await page.locator(".journey-card summary").first().innerText()
      ).includes("乗換 1回"),
    );
    await page.locator("#route-direct").selectOption("direct");
    assert.equal(await page.locator(".journey-card").count(), 0);
    assert.ok(
      (await page.locator("#route-page").innerText()).includes(
        "経路がありません",
      ),
    );
    await page.locator("#route-direct").selectOption("allow");
    for (const dia of ["oud-dia1", "oud-dia2", "oud-dia0"]) {
      await page.locator("#diaId").selectOption(dia);
      assert.ok(await page.locator(".journey-card").count());
    }
    if (rail)
      await page.screenshot({
        path: "artifacts/route-kotomachi-transfer.png",
        fullPage: true,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: rail
        ? "artifacts/route-rail-mobile.png"
        : "artifacts/route-bus-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
  assert.equal(await page.locator("#route-dataset option").count(), 3);
  await page.locator("#route-sort").selectOption("riding");
  assert.ok(await page.locator(".journey-card").count());
  await page.locator("#storage-notice").waitFor({ state: "hidden" });
  await page.reload();
  await page.locator('[data-page="6"]').click();
  assert.equal(await page.locator("#route-dataset option").count(), 3);
  await page.locator('[data-page="1"]').click();
  const work = await downloadJson(
    "workspaceJson",
    "artifacts/workspace-routing.json",
  );
  assert.equal(work.projects.length, 3);
  assert.ok(
    work.projects.find((p) => p.datasetId === "sample-mirai").temporal.slots
      .length,
  );
  // Explicit synthetic network for the walking editor. No real rail/bus connection is assumed.
  for (const id of ["test-walk-a", "test-walk-b"]) {
    const synthetic = structuredClone(sample);
    delete synthetic.temporal;
    delete synthetic.temporalConfig;
    synthetic.datasetId = id;
    synthetic.name = id;
    synthetic.timetables = [
      {
        id: "weekday",
        name: "徒歩試験",
        trains: [
          {
            id: "walk-trip",
            number: "test",
            typeId: "local",
            direction: "down",
            stops: id.endsWith("a")
              ? [
                  { stationId: "s0", status: "stop", departure: 100 },
                  { stationId: "s1", status: "stop", arrival: 200 },
                ]
              : [
                  { stationId: "s1", status: "stop", departure: 400 },
                  { stationId: "s4", status: "stop", arrival: 500 },
                ],
          },
        ],
      },
    ];
    await page
      .locator('[data-file="json"]')
      .setInputFiles({
        name: id + ".json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(synthetic)),
      });
    await page
      .getByRole("status")
      .filter({ hasText: id + ".json を読み込みました" })
      .waitFor();
  }
  await page.locator('[data-page="6"]').click();
  await page.locator("#route-all").selectOption("all");
  await page.locator("#route-sort").selectOption("arrival");
  await page.locator("#route-mode").selectOption("depart");
  await change("route-time", "00:00");
  async function scopedStation(id, dataset, stationId) {
    const value = await page
      .locator("#" + id + "-list option")
      .evaluateAll(
        (options, { dataset, stationId }) =>
          options.find(
            (o) =>
              o.value.includes(" ｜ " + dataset + " ｜ ") &&
              o.value.endsWith(" / " + stationId),
          )?.value,
        { dataset, stationId },
      );
    assert.ok(value);
    await change(id, value);
  }
  await scopedStation("route-origin", "test-walk-a", "s0");
  await scopedStation("route-destination", "test-walk-b", "s4");
  assert.equal(await page.locator(".journey-card").count(), 0);
  await page
    .getByText("徒歩連絡の手動設定（列車間の乗換）", { exact: true })
    .click();
  await page
    .locator("#link-from")
    .selectOption(JSON.stringify(["test-walk-a", "s1"]));
  await page
    .locator("#link-to")
    .selectOption(JSON.stringify(["test-walk-b", "s1"]));
  await change("link-minutes", "1");
  await change(
    "link-basis",
    "自動テスト用の明示的な徒歩接続（実路線の接続を意味しない）",
  );
  await page.locator('[data-route-action="add-link"]').click();
  assert.ok(await page.locator(".journey-card").count());
  assert.ok(
    (await page.locator(".journey-timeline").first().innerText()).includes(
      "徒歩 1分",
    ),
  );
  await page
    .getByText("徒歩連絡の手動設定（列車間の乗換）", { exact: true })
    .click();
  await page.locator('[data-route-action^="delete-link:"]').click();
  assert.equal(await page.locator(".journey-card").count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(
    "Routing browser tests passed: sample routing, before/next, arrival mode, riding sort, temporal edit/15-minute conservation, real rail/bus transfers in all Dias, mobile, workspace persistence, explicit walking link editor.",
  );
} catch (error) {
  await page.screenshot({
    path: "artifacts/routing-test-failure.png",
    fullPage: true,
  });
  console.log((await page.locator("main").innerText()).slice(0, 4500));
  throw error;
} finally {
  await browser.close();
}
