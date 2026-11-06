import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  remoteRequests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (
    !r.url().startsWith("http://127.0.0.1:5173") &&
    !r.url().startsWith("data:") &&
    !r.url().startsWith("blob:")
  )
    remoteRequests.push(r.url());
});
await mkdir("artifacts", { recursive: true });
try {
  for (const [file, count, name] of [
    ["琴町線.oud2", 31, "kotomachi"],
    ["堀電バス［は01］［は02］［は03］［北11］.oud2", 33, "bus"],
  ]) {
    await page.goto("http://127.0.0.1:5173/");
    await page.locator('[data-page="1"]').click();
    await page
      .locator('[data-file="oud2"]')
      .setInputFiles("tests/fixtures/real/" + file);
    await page
      .getByRole("status")
      .filter({ hasText: "基本データを取り込みました" })
      .waitFor();
    assert.equal(await page.locator("#diaId option").count(), 3);
    assert.ok(
      (await page.locator("main").innerText()).includes("UTF-8".toLowerCase()),
    );
    if (name === "kotomachi") {
      assert.ok((await page.locator("main").innerText()).includes("氷群"));
      assert.ok(
        (await page.locator("main").innerText()).includes("路線外発着"),
      );
      await page.screenshot({
        path: "artifacts/kotomachi-import.png",
        fullPage: true,
      });
    }
    for (let i = 0; i < 6; i++) {
      await page.locator(`[data-page="${i}"]`).click();
      assert.ok(await page.locator("h1").innerText());
    }
    await page.locator('[data-page="2"]').click();
    assert.equal(await page.locator("#origin option").count(), count);
    if (name === "kotomachi") {
      assert.equal(
        await page
          .locator("#origin option")
          .filter({ hasText: /^琴町$/ })
          .count(),
        1,
      );
      await page.locator("#destination").selectOption("oud-s23");
      assert.ok((await page.locator("main").innerText()).includes("氷群"));
    }
    await page.locator("#diaId").selectOption("oud-dia1");
    await page.locator("#diaId").selectOption("oud-dia2");
    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-page="1"]').click();
    await page.locator('[data-action="json"]').click();
    const downloaded = await downloadPromise;
    const path = "artifacts/" + name + "-project.json";
    await downloaded.saveAs(path);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.stations.length, count);
    assert.equal(saved.oud2.fileType, "OuDiaSecond.1.17");
    assert.equal(saved.oud2.encoding, "utf-8");
    assert.equal(saved.oud2.serviceDayStart, 14400);
    await page.locator("#storage-notice").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("railway-lab-v1")).codec,
      ),
      "gzip-base64",
    );
    await page.reload();
    await page.locator('[data-page="1"]').click();
    assert.equal(await page.locator("#diaId option").count(), 3);
    assert.ok(
      (await page.locator("main").innerText()).includes("読み込みの警告・制限"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: "artifacts/" + name + "-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log(
      file +
        ": import, 6 screens, Dia selection, canonical IDs, JSON, persistence passed",
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  console.log(
    "Real file browser tests passed; no runtime errors or external network requests.",
  );
} finally {
  await browser.close();
}
