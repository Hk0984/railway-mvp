// Uses an already installed local Chrome. Start `npm run dev -- --port 5173` first.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("artifacts", { recursive: true });
try {
  await page.goto("http://127.0.0.1:5173/");
  await page
    .getByRole("heading", { name: "ダッシュボード", exact: true })
    .waitFor();
  await page.screenshot({
    path: "artifacts/dashboard-desktop.png",
    fullPage: true,
  });
  for (let i = 1; i <= 5; i++) {
    await page.locator(`[data-page="${i}"]`).click();
    assert.ok(await page.locator("h1").innerText());
  }
  await page.locator('[data-page="2"]').click();
  assert.ok((await page.locator("main").innerText()).includes("20 分"));
  await page.locator("#origin").selectOption("s4");
  await page.locator("#destination").selectOption("s0");
  assert.ok((await page.locator("main").innerText()).includes("最速到着基準"));
  await page.locator('[data-page="4"]').click();
  await page.locator('[data-action="generate"]').click();
  assert.equal(await page.locator("h1").innerText(), "OD行列・出力");
  assert.ok((await page.locator("main").innerText()).includes("9,900"));
  await page.screenshot({
    path: "artifacts/od-matrix-desktop.png",
    fullPage: true,
  });
  await page.reload();
  await page.locator('[data-page="5"]').click();
  assert.ok((await page.locator("main").innerText()).includes("9,900"));
  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-action="odCsv"]').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "od-demand.csv");
  await download.saveAs("artifacts/od-demand.csv");
  await page.locator('[data-page="1"]').click();
  await page.locator("#encoding").selectOption("utf-8");
  await page
    .locator('[data-file="oud2"]')
    .setInputFiles("public/samples/basic-1.07.oud2");
  await page
    .getByRole("status")
    .filter({ hasText: "基本データを取り込みました" })
    .waitFor();
  assert.equal(await page.locator("#diaId option").count(), 2);
  await page.locator("#diaId").selectOption("oud-dia1");
  await page.locator('[data-page="2"]').click();
  await page.locator("#origin").selectOption("oud-s1");
  await page.locator("#destination").selectOption("oud-s0");
  await page.locator("#end").fill("25");
  await page.locator("#end").press("Tab");
  await page.locator("#start").fill("23");
  await page.locator("#start").press("Tab");
  assert.ok((await page.locator("main").innerText()).includes("24:10"));
  // A rejected import must preserve the current project and timetables.
  await page.locator('[data-page="1"]').click();
  await page.locator('[data-file="json"]').setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"schemaVersion":999}'),
  });
  await page.getByRole("status").filter({ hasText: "データ検証" }).waitFor();
  assert.equal(await page.locator("#diaId option").count(), 2);
  await page.locator('[data-action="sample"]').click();
  await page.locator('[data-page="0"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "artifacts/dashboard-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: 6 screens, OD 9900, persistence, CSV download, multiple Dia, overnight, failed import, mobile layout; no runtime errors.",
  );
} finally {
  await browser.close();
}
