import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));
const canvas = page.locator(".diagram-scroll canvas");
const frame = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const pixels = () =>
  canvas.evaluate((el) => {
    const ctx = el.getContext("2d");
    const read = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    return { first: read(302, 79), second: read(358, 109) };
  });
async function importJson(project) {
  await page.locator('[data-page="1"]').click();
  await page.locator('[data-file="json"]').setInputFiles({
    name: "diagram-test.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page
    .getByRole("status")
    .filter({ hasText: "を読み込みました" })
    .waitFor();
}
try {
  await page.goto("http://127.0.0.1:5173/");
  await page.locator('[data-page="1"]').click();
  await page.locator("#encoding").selectOption("utf-8");
  await page
    .locator('[data-file="oud2"]')
    .setInputFiles("public/samples/basic-1.07.oud2");
  await page
    .getByRole("status")
    .filter({ hasText: "基本データを取り込みました" })
    .waitFor();
  await page.locator("#diaId").selectOption("oud-dia1");
  await page.locator('[data-page="12"]').click();
  await page
    .locator("#diagram-train")
    .selectOption({ label: "201 ／ 普通 ／ 上り" });
  await page.locator("#diagram-section").selectOption("0");
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /23:50–24:10.*\n.*\n.*未算出/s,
  );

  // Controlled demand enters the actual assignment worker via the regular project import.
  const project = await page.evaluate(async () => {
    const { sampleProject } = await import("/src/sample.ts");
    const { defaultTemporalConfig } = await import("/src/temporal-demand.ts");
    const p = sampleProject();
    p.datasetId = "diagram-browser-test";
    const train = p.timetables[0].trains[0];
    train.id = "diagram-test-101";
    train.number = "D101";
    train.stops = [
      { stationId: "s0", status: "stop", departure: 27900 },
      { stationId: "s1", status: "stop", arrival: 29100, departure: 29220 },
      { stationId: "s2", status: "stop", arrival: 30300 },
    ];
    p.timetables[0].trains = [train];
    p.capacitySettings = {
      trains: {},
      timetables: {},
      types: {
        local: {
          kind: "transport",
          value: 100,
          basis: "ブラウザ検証用設定",
          carCount: 2,
        },
      },
    };
    delete train.capacity;
    const config = defaultTemporalConfig();
    config.slotMinutes = 15;
    config.purposes.forEach((purpose) => {
      purpose.timeWeights = Array(96).fill(1);
    });
    const row = {
      destination: "s2",
      purpose: "commute",
      kind: "outbound",
      source: "manual",
    };
    const a = { ...row, origin: "s0", passengers: 65 };
    const b = { ...row, origin: "s1", passengers: 50 };
    p.temporal = {
      config,
      costs: {},
      dailyOutbound: [a, b],
      daily: [a, b],
      slots: [
        { ...a, start: 27000, end: 27900 },
        { ...b, start: 27900, end: 28800 },
      ],
      generated: 115,
      unallocated: 0,
      warnings: [],
    };
    return p;
  });
  await importJson(project);
  await page.locator('[data-page="9"]').click();
  await page.locator('[data-assignment-action="run"]').click();
  await page
    .locator("#assignment-progress")
    .filter({ hasText: "計算終了" })
    .waitFor();
  await page
    .getByRole("button", { name: "配分結果を列車ダイヤ図で表示" })
    .click();
  await frame();
  await mkdir("artifacts", { recursive: true });
  await page.locator("#diagram-enabled").uncheck();
  await frame();
  const bare = await pixels();
  await canvas.screenshot({ path: "artifacts/diagram-normal.png" });
  await page.locator("#diagram-enabled").check();
  await frame();
  const colored = await pixels();
  assert.notDeepEqual(colored.first, bare.first);
  assert.notDeepEqual(colored.second, bare.second);
  assert.ok(colored.first[1] > colored.first[0], "first interval is green");
  assert.ok(colored.second[0] > colored.second[1], "second interval is yellow");
  await canvas.screenshot({ path: "artifacts/diagram-crowding.png" });

  await canvas.click({ position: { x: 358, y: 104 } });
  assert.match(
    await page.locator("#diagram-train-detail").innerText(),
    /D101.*2両.*平均混雑率 90%.*最大混雑率 115%/s,
  );
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /桜川 → 中央市.*115人.*100人.*115%.*推計値/s,
  );
  await page.locator("#diagram-section").selectOption("1");
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /停車中/,
  );
  await page.locator("#diagram-train").selectOption("");
  await page.locator("#diagram-scope").selectOption("selected");
  await frame();
  assert.deepEqual(await pixels(), bare);
  await page.locator("#diagram-scope").selectOption("all");
  await page.locator("#train-diagram summary").click();
  await page.locator("[data-haze-limit='0']").fill("60");
  await frame();
  const recolored = (await pixels()).first;
  assert.ok(
    recolored[0] > recolored[1],
    "threshold adjustment recolors the first interval",
  );
  await page.locator('[data-page="0"]').click();
  await page.locator('[data-page="12"]').click();
  await page.locator("#train-diagram summary").click();
  assert.equal(await page.locator("[data-haze-limit='0']").inputValue(), "60");
  await page.locator("[data-haze-limit='0']").fill("100");
  await page.locator("#diagram-zoom").selectOption("640");
  await canvas.evaluate((el) => {
    el.parentElement.scrollLeft = 600;
  });
  await frame();
  const zoomX = await canvas.evaluate(
    (el) => 862 - el.parentElement.scrollLeft,
  );
  await canvas.click({ position: { x: zoomX, y: 74 } });
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /緑丘ニュータウン → 桜川.*65%/s,
  );

  const dense = structuredClone(project);
  dense.datasetId = "diagram-browser-dense";
  const base = dense.timetables[0].trains[0];
  dense.timetables[0].trains = Array.from({ length: 2500 }, (_, i) => ({
    ...base,
    id: "dense-" + i,
    number: String(i),
    stops: base.stops.map((s) => ({
      ...s,
      arrival: s.arrival === undefined ? undefined : s.arrival + i * 16,
      departure: s.departure === undefined ? undefined : s.departure + i * 16,
    })),
  }));
  await importJson(dense);
  const started = Date.now();
  await page.locator('[data-page="12"]').click();
  await frame();
  const mounted = Date.now() - started;
  assert.equal(await page.locator("#diagram-train option").count(), 2501);
  assert.ok(mounted < 5000, "dense diagram should render promptly");
  // Benchmark the renderer in isolation with synthetic dense loads.
  const redraw = await page.evaluate(async (p) => {
    const { mountDiagram } = await import("/src/diagram-ui.ts");
    const target = document.querySelector("#train-diagram");
    const timetable = p.timetables[0];
    const loads = timetable.trains.map((train, i) => ({
      datasetId: p.datasetId,
      timetableId: timetable.id,
      trainId: train.id,
      stops: train.stops,
      segmentLoads: [65, 115 + (i % 110)],
      occupancies: [0.65, (115 + (i % 110)) / 100],
    }));
    const stop = mountDiagram(target, p, timetable.id, {
      config: { start: 0, end: 86400, maxJourneySeconds: 3600 },
      loads,
    });
    const nextFrame = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    await nextFrame();
    const canvas = target.querySelector("canvas");
    const plot = canvas.parentElement;
    const enabled = target.querySelector("#diagram-enabled");
    const measure = async (on) => {
      enabled.checked = on;
      enabled.dispatchEvent(new Event("change", { bubbles: true }));
      const start = performance.now();
      for (const left of [0, 100, 200, 300, 400, 500]) {
        plot.scrollLeft = left;
        await nextFrame();
      }
      return Math.round(performance.now() - start);
    };
    const without = await measure(false);
    const withHaze = await measure(true);
    stop();
    return { without, withHaze };
  }, dense);
  assert.ok(
    redraw.withHaze < 2000,
    "dense haze redraws should remain responsive",
  );
  console.log("2,500-train scroll, six frames (ms):", redraw);
  assert.deepEqual(errors, []);
  console.log(
    `Diagram browser smoke passed. 2,500 trains, initial display ${mounted} ms.`,
  );
} catch (error) {
  console.error(await page.getByRole("status").allTextContents());
  throw error;
} finally {
  await browser.close();
}
