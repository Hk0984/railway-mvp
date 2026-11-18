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
const errors = [],
  outside = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("request", (r) => {
  if (!/^(http:\/\/127\.0\.0\.1:5173|blob:|data:)/.test(r.url()))
    outside.push(r.url());
});
const nav = async (n) => p.locator(`[data-page="${n}"]`).first().click();
const change = async (selector, value) => {
  await p.locator(selector).fill(value);
  await p.locator(selector).dispatchEvent("change");
};
async function exportProject(name) {
  await nav(1);
  const d = p.waitForEvent("download");
  await p.locator('[data-action="json"]').click();
  await (await d).saveAs(name);
  return JSON.parse(await readFile(name, "utf8"));
}
try {
  await p.goto("http://127.0.0.1:5173");
  const project = await exportProject("artifacts/ui065-base.json");
  project.datasetId = "ui-065";
  project.name = "UI検証路線";
  project.timetables = [
    {
      id: "weekday",
      name: "表示しない検証ダイヤ名",
      trains: [
        {
          id: "t",
          number: "123",
          typeId: "local",
          direction: "down",
          operations: [
            {
              positionId: "p0",
              phase: "before",
              code: 3,
              raw: "3/0700$LINK/01C",
            },
          ],
          stops: [
            {
              stationId: "s0",
              positionId: "p0",
              status: "stop",
              departure: 25200,
              track: "0",
            },
            {
              stationId: "s1",
              positionId: "p1",
              status: "pass",
              departure: 25500,
            },
            {
              stationId: "s2",
              positionId: "p2",
              status: "stop",
              arrival: 25800,
              departure: 25860,
              track: "1",
            },
            {
              stationId: "s4",
              positionId: "p4",
              status: "stop",
              arrival: 26400,
              track: "0",
            },
          ],
        },
      ],
    },
  ];
  project.oud2 = {
    fileType: "OuDiaSecond.1.17",
    serviceDayStart: 0,
    emptyColumns: 0,
    warnings: [],
    links: [],
    externalTerminals: [],
    positions: project.stations.map((s, i) => ({
      id: "p" + i,
      stationId: s.id,
      name: s.name,
      tracks: ["3番線", "7番線"],
      outerTerminalIds: [],
    })),
  };
  project.demands = [];
  project.typeCapacities = { local: 200 };
  delete project.capacitySettings;
  project.serviceClasses.trains = {};
  await writeFile("artifacts/ui065-input.json", JSON.stringify(project));
  await p
    .locator('[data-file="json"]')
    .setInputFiles("artifacts/ui065-input.json");
  await p
    .getByRole("status")
    .filter({ hasText: "ui065-input.json を読み込みました" })
    .waitFor();
  await nav(8);
  await p.locator('[data-class-type="local"][value="passenger"]').uncheck();
  assert.ok(
    await p.locator('[data-class-type="local"][value="review"]').isChecked(),
  );
  await p.locator('[data-class-type="local"][value="nonPassenger"]').check();
  assert.ok(
    await p
      .locator('[data-class-type="local"][value="nonPassenger"]')
      .isChecked(),
  );
  await p.locator('[data-class-type="local"][value="passenger"]').check();
  await p.locator('[data-class-train="t"][value="nonPassenger"]').check();
  await p.locator('[data-class-train="t"][value="inherit"]').check();
  await p.locator('[data-operation-capacity-enable="C"]').check();
  await change('[data-operation-capacity="C"]', "120");
  assert.match(
    await p.locator('[data-train-capacity="t"]').locator("..").innerText(),
    /現在 120人/,
  );
  await change('[data-train-operation="t"]', "02D");
  await p.locator('[data-operation-capacity-enable="D"]').check();
  await change('[data-operation-capacity="D"]', "240");
  assert.match(
    await p.locator('[data-train-capacity="t"]').locator("..").innerText(),
    /現在 240人/,
  );
  await p.locator('[data-train-capacity-enable="t"]').check();
  await change('[data-train-capacity="t"]', "300");
  assert.match(
    await p.locator('[data-train-capacity="t"]').locator("..").innerText(),
    /現在 300人/,
  );
  await p.locator('[data-train-capacity-enable="t"]').uncheck();
  assert.match(
    await p.locator('[data-train-capacity="t"]').locator("..").innerText(),
    /現在 240人/,
  );
  await p.locator("#capacity-editor").scrollIntoViewIfNeeded();
  await p.screenshot({
    path: "artifacts/ui065-capacity-desktop.png",
    fullPage: false,
  });
  for(const transport of [false,true]){
    await p.locator('#capacity-scope').selectOption('operationGroups');
    await p.locator('#capacity-target').fill('D');
    await p.locator('#capacity-value').fill('240');
    await p.locator('#capacity-basis').fill('チェックボックスの座席・輸送切替検証');
    await p.locator('#capacity-kind').setChecked(transport);
    await p.locator('[data-capacity-action="apply"]').click();
    assert.match(await p.locator('[data-train-capacity="t"]').locator('..').innerText(),transport?/現在 240人/:/現在 不明/);
  }
  const exported = await exportProject("artifacts/ui065-export.json");
  assert.equal(exported.capacitySettings.operationGroups.C.value, 120);
  assert.equal(exported.capacitySettings.operationGroups.D.value, 240);
  assert.deepEqual(exported.timetables[0].trains[0].operationNumbers, ["02D"]);
  await p.reload();
  await nav(8);
  assert.equal(
    await p.locator('[data-operation-capacity="D"]').inputValue(),
    "240",
  );
  await p.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await p.screenshot({
    path: "artifacts/ui065-capacity-mobile.png",
    fullPage: false,
  });
  await nav(6);
  for (const [id, index] of [
    ["route-origin", 0],
    ["route-destination", 2],
  ]) {
    const label = await p
      .locator("#" + id + "-list option")
      .evaluateAll(
        (options, name) =>
          options.find((o) => o.value.startsWith(name + " ｜")).value,
        project.stations[index].name,
      );
    await change("#" + id, label);
  }
  await change("#route-time", "06:59");
  await p.locator('[data-route-action="search"]').click();
  await p.locator(".journey-card").first().waitFor();
  const timeline = p
    .locator(".journey-card")
    .first()
    .locator(".journey-timeline");
  assert.match(
    await timeline.locator(".train-badge").innerText(),
    new RegExp(project.stations[4].name + "行"),
  );
  assert.ok(!(await timeline.innerText()).includes(project.stations[1].name));
  assert.ok(!(await timeline.innerText()).includes("表示しない検証ダイヤ名"));
  assert.match(
    await timeline.locator(".timeline-station").first().innerText(),
    /3番線/,
  );
  assert.match(
    await timeline.locator(".timeline-station").last().innerText(),
    /7番線/,
  );
  assert.match(await timeline.locator("summary").innerText(), /途中の停車 0駅/);
  await timeline.scrollIntoViewIfNeeded();
  await p.screenshot({
    path: "artifacts/ui065-route-mobile.png",
    fullPage: false,
  });
  assert.ok(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await p.setViewportSize({ width: 1440, height: 1000 });
  await timeline.scrollIntoViewIfNeeded();
  await p.screenshot({
    path: "artifacts/ui065-route-desktop.png",
    fullPage: false,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(outside, []);
  console.log(
    "Chrome UI 0.65 passed: three-state checkboxes, capacity switches, operation-letter capacity and overrides, persistence, type/destination, omitted pass, endpoint tracks, mobile; no outside requests.",
  );
} catch (e) {
  await p.screenshot({ path: "artifacts/ui065-failure.png", fullPage: true });
  console.error((await p.locator("main").innerText()).slice(-1000));
  throw e;
} finally {
  await b.close();
}
