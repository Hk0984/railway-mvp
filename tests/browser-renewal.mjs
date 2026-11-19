import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = await chromium.launchPersistentContext(
  await mkdtemp(join(tmpdir(), "railway-renewal-")),
  {
    executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
    ],
    viewport: { width: 1440, height: 900 },
  },
);
try {
  const page = context.pages()[0];
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.RAILWAY_URL || "http://127.0.0.1:5173/");
  await page.getByRole("heading", { name: "乗換案内", exact: true }).waitFor();
  assert.equal(await page.locator("nav a").count(), 3);
  await page.getByRole("button", { name: "経路を検索" }).click();
  await page.locator(".journey-card").first().waitFor();
  assert.match(
    await page.locator(".journey-card").first().innerText(),
    /[0-9]{2}:[0-9]{2}/,
  );
  // Previous releases stored haze preferences without direction or stroke width.
  await page.evaluate(() => {
    localStorage.setItem(
      "railway-lab.diagram-haze",
      JSON.stringify({
        enabled: true,
        selectedOnly: false,
        width: 9,
        opacity: 0.55,
        limits: [100, 130, 160, 200],
        colors: ["#158c51", "#d7ab00", "#ed7c18", "#d93042", "#903bbe"],
      }),
    );
  });
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  const displayDirection = page.getByLabel("表示方向", { exact: true });
  const strokeWidth = page.getByRole("slider", { name: "スジ線の太さ" });
  assert.equal(await displayDirection.inputValue(), "all");
  assert.equal(await strokeWidth.inputValue(), "1.2");
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await page.locator("#diagram-train").selectOption("down-8");
  await page.locator("#diagram-section").selectOption("0");
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /混雑率 [0-9.]+%/,
  );
  const canvas = page.locator(".diagram-scroll canvas");
  const pixels = () =>
    canvas.evaluate(async (el) => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const data = el
        .getContext("2d")
        .getImageData(0, 0, el.width, el.height).data;
      return data.reduce((hash, value) => (Math.imul(hash, 31) + value) | 0, 0);
    });
  await page.locator(".diagram-scroll").evaluate((el) => {
    el.scrollLeft = 250;
  });
  const bothDirections = await pixels();
  const trainChoices = () =>
    page
      .locator("#diagram-train option:not([value=''])")
      .evaluateAll((options) => options.map((option) => option.value));
  await displayDirection.selectOption("down");
  assert.equal(await page.locator("#diagram-train").inputValue(), "down-8");
  assert.equal(await page.locator("#diagram-section").inputValue(), "0");
  let choices = await trainChoices();
  assert.equal(choices.length, 36);
  assert.ok(choices.every((id) => id.startsWith("down-")));
  assert.notEqual(await pixels(), bothDirections);
  await displayDirection.selectOption("up");
  assert.equal(await page.locator("#diagram-train").inputValue(), "");
  assert.equal(await page.locator("#diagram-section").isDisabled(), true);
  choices = await trainChoices();
  assert.equal(choices.length, 36);
  assert.ok(choices.every((id) => id.startsWith("up-")));
  assert.equal(
    await page.locator(".diagram-scroll").evaluate((el) => el.scrollLeft),
    250,
  );
  const on = await pixels();
  await page.locator("#diagram-enabled").uncheck();
  const thin = await pixels();
  assert.notEqual(thin, on);
  await strokeWidth.press("End");
  assert.equal(await strokeWidth.inputValue(), "4");
  assert.equal(
    await page.locator("#diagram-line-width-value").textContent(),
    "4 px",
  );
  assert.notEqual(await pixels(), thin);
  await page.getByText("計算完了", { exact: true }).waitFor();
  await page.reload();
  await displayDirection.waitFor();
  assert.equal(await displayDirection.inputValue(), "up");
  assert.equal(await strokeWidth.inputValue(), "4");
  await page.getByRole("link", { name: "データ設定" }).click();
  await page.getByRole("button", { name: "方面を追加" }).click();
  await page.getByPlaceholder("都心方面").fill("都心方面");
  await page.getByLabel("1日の流入", { exact: true }).fill("300");
  await page.getByLabel("1日の流出", { exact: true }).fill("150");
  await page.getByLabel("接続方法").selectOption("through");
  await page
    .getByLabel("流入に使う直通列車")
    .selectOption(["down-8", "down-9"]);
  await page.getByLabel("流出に使う直通列車").selectOption(["up-8", "up-9"]);
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page.getByText("路線外の配分対象　流入 300人・流出 150人").waitFor();
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await page.getByRole("link", { name: "データ設定" }).click();
  const timeBasis = page.getByLabel("時間帯の基準", { exact: true });
  assert.equal(await timeBasis.inputValue(), "boarding");
  await timeBasis.selectOption("arrival");
  assert.equal(await page.locator('[name^="arr-hour-up-"]').count(), 24);
  assert.equal(await page.locator('[name^="arr-hour-down-"]').count(), 24);
  await page.getByLabel("上り 24:00–25:00の到着割合").waitFor();
  await page.locator('[name^="arr-hour-"]').evaluateAll((inputs) => {
    for (const input of inputs) input.value = "0";
  });
  const upEleven = page.getByLabel("上り 11:00–12:00の到着割合", {
    exact: true,
  });
  const downNoon = page.getByLabel("下り 12:00–13:00の到着割合", {
    exact: true,
  });
  await upEleven.fill("90");
  await downNoon.fill("100");
  assert.equal(
    await page.locator('[data-arrival-total="up"]').textContent(),
    "90%",
  );
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "上りの目的地到着割合を合計100%" })
    .waitFor();
  await upEleven.fill("100");
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await page.locator("#demand-preview summary").click();
  const arrivalRow = (time) =>
    page
      .locator("#demand-preview tr")
      .filter({ hasText: time })
      .locator("td")
      .allTextContents();
  const eleven = await arrivalRow("11:00–12:00");
  const noon = await arrivalRow("12:00–13:00");
  assert.equal(eleven.length, 4);
  assert.equal(noon.length, 4);
  assert.ok(Number(eleven[2].replaceAll(",", "")) > 0);
  assert.equal(eleven[3], "0");
  assert.equal(noon[2], "0");
  assert.ok(Number(noon[3].replaceAll(",", "")) > 0);
  await page.getByRole("link", { name: "データ設定" }).click();
  await page.reload();
  assert.equal(await timeBasis.inputValue(), "arrival");
  assert.equal(await upEleven.inputValue(), "100");
  assert.equal(await downNoon.inputValue(), "100");
  assert.equal(
    await page.getByPlaceholder("都心方面").inputValue(),
    "都心方面",
  );
  const fixture = await (
    await fetch(new URL("samples/basic-1.07.oud2", page.url()))
  ).arrayBuffer();
  await page.locator("#open-file").setInputFiles({
    name: "basic-1.07.oud2",
    mimeType: "text/plain",
    buffer: Buffer.from(fixture),
  });
  await page.getByText("basic-1.07.oud2 を読み込みました").waitFor();
  await page.locator("#active-dia").selectOption("oud-dia1");
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page
    .locator("#diagram-train")
    .selectOption({ label: "201 ／ 普通 ／ 上り" });
  await page.locator("#diagram-section").selectOption("0");
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /23:50–24:10[\s\S]*未算出/,
  );
  await displayDirection.selectOption("down");
  await page
    .getByText("選択した表示条件に該当する列車がありません。")
    .waitFor();
  assert.deepEqual(await trainChoices(), []);
  await displayDirection.selectOption("all");
  assert.deepEqual(await trainChoices(), ["oud-1-Nobori-0"]);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Renewal smoke passed: route, worker, haze, direction, stroke width, hourly destination arrivals, external trains, save/reload, OuDia2nd, midnight, mobile",
  );
} finally {
  await context.close();
}
