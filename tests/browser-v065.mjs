import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
await mkdir("artifacts", { recursive: true });
const b = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  }),
  p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
p.setDefaultTimeout(30000);
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const nav = async (n) => p.locator(`[data-page="${n}"]`).first().click();
const run = async () => {
  await p.locator('[data-service-action="run"]').click();
  await p.locator("#analysis-effective-count").waitFor();
};
try {
  await p.goto("http://127.0.0.1:5173");
  await nav(1);
  const d = p.waitForEvent("download");
  await p.locator('[data-action="json"]').click();
  await (await d).saveAs("artifacts/v065-base.json");
  const project = JSON.parse(
    await readFile("artifacts/v065-base.json", "utf8"),
  );
  project.datasetId = "effective-example";
  project.name = "有効本数の検証例";
  const t = (id, from, to, departure, arrival) => ({
    id,
    number: id,
    typeId: "local",
    direction: "down",
    stops: [
      { stationId: from, status: "stop", departure },
      { stationId: to, status: "stop", arrival },
    ],
  });
  project.timetables = [
    {
      id: "weekday",
      name: "検証用",
      trains: [
        t("先発直通", "s0", "s4", 25200, 28800),
        t("後発速達", "s0", "s1", 25800, 26400),
        t("接続1", "s1", "s2", 26520, 27000),
        t("接続2", "s2", "s4", 27120, 28800),
      ],
    },
  ];
  project.demands = [];
  delete project.capacitySettings;
  project.serviceClasses.trains = {};
  await writeFile("artifacts/v065-example.json", JSON.stringify(project));
  await p
    .locator('[data-file="json"]')
    .setInputFiles("artifacts/v065-example.json");
  await p
    .getByRole("status")
    .filter({ hasText: "v065-example.json を読み込みました" })
    .waitFor();
  await nav(2);
  await run();
  assert.match(await p.locator("#analysis-effective-count").innerText(), /^1/);
  assert.equal(
    await p
      .locator("#analysis-od-service .table-wrap")
      .first()
      .locator("tbody tr td")
      .first()
      .innerText(),
    "07:10",
  );
  assert.match(
    await p.locator("#analysis-replaced-direct").innerText(),
    /先発直通/,
  );
  await p.locator("#analysis-replaced-direct summary").click();
  assert.match(await p.locator("#analysis-replaced-direct").innerText(), /2回/);
  await p.locator("#analysis-od-service").scrollIntoViewIfNeeded();
  await p.screenshot({
    path: "artifacts/v065-effective-desktop.png",
    fullPage: false,
  });
  await p.locator("#analysis-service-transfers").selectOption("1");
  assert.equal(await p.locator("#analysis-effective-count").count(), 0);
  await run();
  assert.equal(
    await p
      .locator("#analysis-od-service .table-wrap")
      .first()
      .locator("tbody tr td")
      .first()
      .innerText(),
    "07:00",
  );
  await p.locator("#analysis-service-transfers").selectOption("2");
  await run();
  await p.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await p.locator("#analysis-od-service").scrollIntoViewIfNeeded();
  await p.screenshot({
    path: "artifacts/v065-effective-mobile.png",
    fullPage: false,
  });
  await p.locator("#direction").selectOption("up");
  assert.equal(await p.locator("#analysis-effective-count").count(), 0);
  await run();
  assert.match(await p.locator("#analysis-effective-count").innerText(), /^0/);
  await p.evaluate(() => {
    document.querySelector("[data-service-action=run]").click();
    document.querySelector("[data-service-action=cancel]")?.click();
  });
  assert.equal(await p.locator("#analysis-effective-count").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Chrome 0.65 passed: later two-transfer journey replaces direct, one-transfer limit retains direct, proof table, invalidation, filters, cancellation, mobile.",
  );
} finally {
  await b.close();
}
