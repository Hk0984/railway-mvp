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
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
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
  const on = await pixels();
  await page.locator("#diagram-enabled").uncheck();
  assert.notEqual(await pixels(), on);
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
  await page.reload();
  assert.equal(
    await page.getByPlaceholder("都心方面").inputValue(),
    "都心方面",
  );
  const fixture = await (
    await fetch(new URL("samples/basic-1.07.oud2", page.url()))
  ).arrayBuffer();
  await page
    .locator("#open-file")
    .setInputFiles({
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
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Renewal smoke passed: route, worker, haze, external trains, save/reload, OuDia2nd, midnight, mobile",
  );
} finally {
  await context.close();
}
