import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtemp, readFile } from "node:fs/promises";
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
  const legacyStored = '{"schemaVersion":1,"name":"旧形式のブラウザ保存"}';
  await page.evaluate(
    (value) => localStorage.setItem("railway-lab-v1", value),
    legacyStored,
  );
  await page.reload();
  await page.getByText(/ブラウザに旧形式の設定が残っています/).waitFor();
  assert.equal(await page.locator("nav a").count(), 3);
  assert.equal(
    await page.getByRole("heading", { name: "路線の駅" }).count(),
    0,
  );
  await page.locator('#journey-form input[name="time"]').fill("07:10");
  await page.getByRole("button", { name: "経路を検索" }).click();
  const firstJourney = page.locator(".journey-card").first();
  await firstJourney.waitFor();
  const journeyOptions = page.locator(".journey-option");
  assert.ok((await journeyOptions.count()) > 1);
  assert.equal(await page.locator(".journey-card:visible").count(), 1);
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector(".journey-options").getBoundingClientRect()
          .bottom <=
        document.querySelector(".journey-card").getBoundingClientRect().top,
    ),
  );
  for (const time of await page
    .locator(".journey-time, .journey-stop-time time")
    .allTextContents()) {
    assert.match(time, /\d{2}:\d{2}/);
    assert.doesNotMatch(time, /\d{2}:\d{2}:\d{2}/);
  }
  await journeyOptions.nth(1).click();
  assert.equal(
    await journeyOptions.nth(1).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page.locator(".journey-card:visible").getAttribute("id"),
    "journey-detail-1",
  );
  await journeyOptions.first().click();
  assert.deepEqual(
    await firstJourney.locator(".journey-stop-name").allTextContents(),
    ["緑丘ニュータウン", "中央市", "港ビジネス街", "東雲学園"],
  );
  const routeIntervals = firstJourney.locator(
    ".journey-interval .journey-crowding",
  );
  assert.equal(await routeIntervals.count(), 3);
  assert.match(await routeIntervals.first().innerText(), /未算出/);
  await page.getByRole("button", { name: "混雑を計算", exact: true }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  assert.equal(
    await firstJourney.locator(".journey-interval [data-band]").count(),
    3,
  );
  await page.getByText("駅間混雑の目安（6段階）", { exact: true }).click();
  assert.equal(
    await page.locator(".journey-crowding-legend li:visible").count(),
    6,
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
  const legend = page.locator('[aria-label="混雑率の凡例"]');
  assert.match(await legend.innerText(), /40%未満 全員着席レベル/);
  assert.match(await legend.innerText(), /40〜100% 比較的余裕あり/);
  const displayDirection = page.getByLabel("表示方向", { exact: true });
  const strokeWidth = page.getByRole("slider", { name: "スジ線の太さ" });
  assert.equal(await displayDirection.inputValue(), "all");
  assert.equal(await strokeWidth.inputValue(), "1.2");
  const zoom = page.locator("#diagram-zoom");
  assert.equal(await zoom.inputValue(), "640");
  assert.equal(await zoom.locator("option:checked").innerText(), "100%");
  assert.equal(await zoom.locator('option[value="160"]').innerText(), "25%");
  await zoom.selectOption("160");
  assert.equal(await zoom.locator("option:checked").innerText(), "25%");
  await zoom.selectOption("640");
  const segmentDetail = page.locator("#diagram-segment-detail");
  const interior = segmentDetail.getByRole("img", { name: /車内の模式図/ });
  const diagramTrain = page.locator("#diagram-train");
  const section = page.locator("#diagram-section");
  const localCars = page.getByLabel("普通の編成両数", { exact: true });
  const rapidCars = page.getByLabel("快速の編成両数", { exact: true });
  const transferSeconds = page.getByLabel("最低乗換時間（秒）", {
    exact: true,
  });
  await diagramTrain.selectOption("down-8");
  await section.selectOption("0");
  assert.equal(await interior.count(), 0);
  await segmentDetail.getByRole("link", { name: "データ設定" }).click();
  await localCars.fill("8");
  await rapidCars.fill("6");
  assert.equal(await transferSeconds.inputValue(), "60");
  await transferSeconds.fill("90");
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await diagramTrain.selectOption("down-8");
  await section.selectOption("0");
  await zoom.selectOption("320");
  const plot = page.locator(".diagram-scroll");
  await plot.evaluate((el) => {
    el.scrollLeft = 250;
  });
  await page.getByRole("button", { name: "混雑を再計算", exact: true }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  assert.equal(await zoom.inputValue(), "320");
  assert.equal(await diagramTrain.inputValue(), "down-8");
  assert.equal(await section.inputValue(), "0");
  assert.equal(await plot.evaluate((el) => el.scrollLeft), 250);
  await zoom.selectOption("640");
  assert.match(
    await page.locator("#diagram-train-detail").innerText(),
    /編成両数 8両/,
  );
  const trainChart = page.locator("#diagram-train-detail .diagram-train-chart");
  assert.deepEqual(
    await trainChart.locator(".diagram-chart-station").allTextContents(),
    ["緑丘ニュータウン", "東雲学園"],
  );
  const boardingChart = page.getByRole("region", { name: "駅別の乗降グラフ" });
  assert.deepEqual(
    await boardingChart.locator(".diagram-chart-station").allTextContents(),
    ["緑丘ニュータウン", "桜川", "中央市", "港ビジネス街", "東雲学園"],
  );
  assert.ok(
    (await boardingChart.locator("rect.diagram-boarding-board").count()) > 0,
  );
  assert.ok(
    (await boardingChart.locator("rect.diagram-boarding-alight").count()) > 0,
  );
  const stationNumbers = page.locator(".diagram-boarding details");
  await stationNumbers.locator("summary").click();
  assert.equal(await stationNumbers.locator("tbody tr").count(), 5);
  await stationNumbers.locator("summary").click();
  await page.locator("#diagram-section").selectOption("0");
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /混雑率 [0-9.]+%/,
  );
  await interior.waitFor();
  const count = Number(
    (await interior.getAttribute("aria-label")).match(/推定(\d+)人/)[1],
  );
  assert.ok(count > 0);
  assert.equal(await interior.locator("circle").count(), count);
  assert.equal(await interior.locator("rect.diagram-interior-door").count(), 4);
  await page.locator("#diagram-section").selectOption("1");
  assert.match(await segmentDetail.innerText(), /停車中/);
  assert.equal(await interior.count(), 0);
  await page.locator("#diagram-section").selectOption("0");
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
  assert.equal(await localCars.inputValue(), "8");
  assert.equal(await rapidCars.inputValue(), "6");
  assert.equal(await transferSeconds.inputValue(), "90");
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
  const saveError = page.locator(".save-bar [role=alert]");
  assert.match(await saveError.innerText(), /上りの目的地到着割合を合計100%/);
  assert.equal(
    await page.locator(".save-bar #form-state").innerText(),
    "未保存の変更があります",
  );
  await upEleven.fill("100");
  const curve = page.getByRole("img", { name: "上り・下りの到着需要の推移" });
  const smoothing = page.getByRole("checkbox", {
    name: "到着需要をなだらかに補間",
  });
  assert.equal(await smoothing.isChecked(), true);
  await smoothing.uncheck();
  const unsmoothed = await curve.evaluate((canvas) => canvas.toDataURL());
  await smoothing.check();
  assert.notEqual(
    await curve.evaluate((canvas) => canvas.toDataURL()),
    unsmoothed,
  );
  assert.equal(
    await page.locator('[data-arrival-total="up"]').textContent(),
    "100%",
  );
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await page.locator("#demand-preview summary").click();
  await page
    .getByText("時間内の到着需要を曲線で補間しています。", { exact: true })
    .waitFor();
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
  assert.equal(await smoothing.isChecked(), true);
  assert.equal(await downNoon.inputValue(), "100");
  assert.equal(
    await page.getByPlaceholder("都心方面").inputValue(),
    "都心方面",
  );
  const cap = page.getByLabel("乗車上限の混雑率（%）", { exact: true });
  await cap.fill("10");
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  assert.match(
    await page.locator("#train-diagram > p.muted").first().innerText(),
    /乗車上限 10%/,
  );
  await page.locator("#demand-preview summary").click();
  const waiting = await page
    .getByText(/上限で後続便待ちになった人数/)
    .innerText();
  assert.ok(
    Number(waiting.match(/人数 ([\d,.]+)/)?.[1].replaceAll(",", "")) > 0,
  );
  await page.locator("#diagram-train").selectOption("up-15");
  const peak = await page.locator("#diagram-train-detail").innerText();
  assert.match(peak, /最大混雑率 10%/);
  await page.locator("#diagram-section").selectOption("0");
  const seated = await interior
    .locator("g.diagram-interior-seated circle")
    .count();
  assert.equal(seated, 2);
  assert.equal(
    await interior.locator("g.diagram-interior-standing circle").count(),
    0,
  );
  await zoom.selectOption("160");
  const lightBluePixels = () =>
    canvas.evaluate(async (el) => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const data = el
        .getContext("2d")
        .getImageData(0, 0, el.width, el.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i + 3] > 40 &&
          Math.abs(data[i] - 56) < 5 &&
          Math.abs(data[i + 1] - 189) < 5 &&
          Math.abs(data[i + 2] - 248) < 5
        )
          count++;
      }
      return count;
    });
  const haze = page.locator("#diagram-enabled");
  await haze.check();
  assert.ok(
    (await lightBluePixels()) > 0,
    "low crowding draws light-blue haze",
  );
  await haze.uncheck();
  assert.equal(await lightBluePixels(), 0);
  await page.getByRole("link", { name: "データ設定" }).click();
  await page.reload();
  assert.equal(await cap.inputValue(), "10");
  const primary = page.getByLabel("緑丘ニュータウンの主属性", { exact: true });
  const secondary = page.getByLabel("緑丘ニュータウンの副属性", {
    exact: true,
  });
  const commute = page.getByLabel("緑丘ニュータウンの通勤の割合（%）", {
    exact: true,
  });
  const school = page.getByLabel("緑丘ニュータウンの通学の割合（%）", {
    exact: true,
  });
  const other = page.getByLabel("緑丘ニュータウンの非定期の割合（%）", {
    exact: true,
  });
  await primary.selectOption("high-density-residential");
  assert.equal(await commute.getAttribute("placeholder"), "55");
  await secondary.selectOption("commercial");
  assert.equal(await commute.getAttribute("placeholder"), "48.75");
  await commute.fill("65");
  await school.fill("20");
  await other.fill("20");
  const save = page.getByRole("button", { name: "設定を保存", exact: true });
  await save.click();
  await page.getByRole("alert").filter({ hasText: "割合を合計100%" }).waitFor();
  await other.fill("15");
  await timeBasis.selectOption("profile");
  await cap.fill("");
  await save.click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page.reload();
  assert.equal(await timeBasis.inputValue(), "profile");
  assert.equal(await primary.inputValue(), "high-density-residential");
  assert.equal(await secondary.inputValue(), "commercial");
  assert.equal(await commute.inputValue(), "65");
  assert.equal(await school.inputValue(), "20");
  assert.equal(await other.inputValue(), "15");
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page
    .getByText(/駅から出発する需要の内訳.*通勤.*通学.*非定期/)
    .waitFor();
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await page.locator("#diagram-train").selectOption("up-8");
  assert.match(
    await page.locator("#diagram-train-detail").innerText(),
    /最大混雑率 [\d.]+%/,
  );
  await page.getByRole("link", { name: "データ設定" }).click();
  const day = page.getByRole("combobox", { name: "需要の日区分", exact: true });
  const board = page.getByLabel("緑丘ニュータウンの乗車人数", { exact: true });
  const alight = page.getByLabel("緑丘ニュータウンの降車人数", { exact: true });
  assert.equal(await day.inputValue(), "weekday");
  await day.selectOption("friday");
  assert.equal(await board.inputValue(), "24000");
  await page
    .locator("#demand-day-status")
    .filter({ hasText: "平日（月〜木）の需要を使用" })
    .waitFor();
  await board.fill("1200");
  await alight.fill("1300");
  await timeBasis.selectOption("boarding");
  for (const [i, share] of ["0", "100", "0", "0"].entries())
    await page.locator(`[name="local${i}"]`).fill(share);
  page.once("dialog", (dialog) => dialog.dismiss());
  await day.selectOption("holiday");
  assert.equal(await day.inputValue(), "friday");
  assert.equal(await board.inputValue(), "1200");
  await save.click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page
    .locator("#demand-day-status")
    .filter({ hasText: "金曜日の専用設定" })
    .waitFor();

  await day.selectOption("holiday");
  assert.equal(await board.inputValue(), "24000");
  await board.fill("7600");
  await alight.fill("7800");
  await timeBasis.selectOption("boarding");
  for (const [i, share] of ["0", "0", "100", "0"].entries())
    await page.locator(`[name="local${i}"]`).fill(share);
  await save.click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  await page.reload();
  assert.equal(await day.inputValue(), "holiday");
  assert.equal(await board.inputValue(), "7600");
  assert.equal(await alight.inputValue(), "7800");
  assert.equal(await page.locator('[name="local2"]').inputValue(), "100");
  await day.selectOption("weekday");
  assert.equal(await board.inputValue(), "24000");
  assert.equal(await alight.inputValue(), "24000");
  assert.equal(await timeBasis.inputValue(), "profile");
  await day.selectOption("friday");
  assert.equal(await board.inputValue(), "1200");
  assert.equal(await alight.inputValue(), "1300");
  assert.equal(await page.locator('[name="local1"]').inputValue(), "100");
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  const periodDemand = page.locator("#demand-preview .preview-periods strong");
  const friday = (await periodDemand.allTextContents()).map((value) =>
    Number(value.replace(/[, 人]/g, "")),
  );
  assert.ok(friday[1] > 0 && friday[0] === 0 && friday[2] === 0);
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await day.selectOption("holiday");
  assert.equal(await page.getByText("計算完了", { exact: true }).count(), 0);
  const holiday = (await periodDemand.allTextContents()).map((value) =>
    Number(value.replace(/[, 人]/g, "")),
  );
  assert.ok(holiday[2] > friday[1] && holiday[0] === 0 && holiday[1] === 0);
  await page.getByRole("button", { name: "混雑を計算" }).click();
  await page.getByText("計算完了", { exact: true }).waitFor();
  await page.getByRole("link", { name: "データ設定" }).click();

  const fixture = await (
    await fetch(new URL("samples/basic-1.07.oud2", page.url()))
  ).arrayBuffer();
  const oud = new TextDecoder()
    .decode(fixture)
    .replace(
      "Syubetsumei=普通",
      "Syubetsumei=普通\nDiagramSenColor=00FE6100\nJikokuhyouMojiColor=000076EC",
    );
  const openOud = (name, contents) =>
    page.locator("#open-file").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(contents),
    });
  await openOud("basic-1.07.oud2", oud);
  await page
    .getByText(
      "basic-1.07.oud2を読み込みました。設定JSONを読み込むか、下にスクロールして駅利用者数・駅属性と利用目的・時間帯の振り分け・営業区分と輸送定員を設定してください。",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("heading", { name: "駅の属性と利用目的", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "営業区分と輸送定員", exact: true })
    .waitFor();
  await page
    .getByRole("columnheader", { name: "輸送定員（人／編成）", exact: true })
    .waitFor();
  await page.locator("#active-dia").selectOption("oud-dia1");
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await day.selectOption("holiday");
  await page.reload();
  assert.equal(await page.locator("#active-dia").inputValue(), "oud-dia1");
  assert.equal(await day.inputValue(), "holiday");
  await page
    .locator("#diagram-train")
    .selectOption({ label: "201 ／ 普通 ／ 上り" });
  await page.getByText("駅別の乗降人数 未算出", { exact: true }).waitFor();
  await page.locator("#diagram-section").selectOption("0");
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /23:50–24:10[\s\S]*未算出/,
  );
  assert.equal(await interior.count(), 0);
  await displayDirection.selectOption("down");
  await page
    .getByText("選択した表示条件に該当する列車がありません。")
    .waitFor();
  assert.deepEqual(await trainChoices(), []);
  await displayDirection.selectOption("all");
  assert.deepEqual(await trainChoices(), ["oud-1-Nobori-0"]);
  await page.getByRole("link", { name: "データ設定" }).click();
  assert.equal(
    await page.getByText("種別色だけ読み込む", { exact: true }).count(),
    0,
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "設定のJSONを保存" }).click(),
  ]);
  assert.equal(download.suggestedFilename(), "railway-lab-v2.json");
  const backup = await readFile(await download.path());
  const saved = JSON.parse(backup.toString("utf8"));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.types[0].diagramColor, "#0061fe");
  assert.equal(saved.types[0].timetableColor, "#ec7600");
  const importBackup = (name, buffer) =>
    page
      .locator("#open-file")
      .setInputFiles({ name, mimeType: "application/json", buffer });
  await importBackup(
    "old.json",
    Buffer.from(JSON.stringify({ ...saved, schemaVersion: 1 })),
  );
  await page
    .getByRole("alert")
    .filter({ hasText: "旧形式のJSONです" })
    .waitFor();
  assert.equal(await page.locator("#active-dia").inputValue(), "oud-dia1");
  const incomplete = structuredClone(saved);
  delete incomplete.types[0].diagramColor;
  await importBackup(
    "missing-color.json",
    Buffer.from(JSON.stringify(incomplete)),
  );
  await page.getByRole("alert").filter({ hasText: "種別色には" }).waitFor();
  await page.getByRole("button", { name: "サンプルを開く" }).click();
  await importBackup("railway-lab-v2.json", backup);
  await page.getByText(/railway-lab-v2\.jsonを読み込みました/).waitFor();
  assert.equal(await page.locator("#active-dia").inputValue(), "oud-dia1");
  assert.equal(await day.inputValue(), "holiday");
  const revisedBoard = page.locator('[name="board0"]');
  const capacity = page.locator('[name="cap0"]');
  await revisedBoard.fill("1000");
  await page.locator('[name="alight1"]').fill("1000");
  await page
    .locator('[name="station-primary-0"]')
    .selectOption("low-density-residential");
  await capacity.fill("600");
  await page.locator('[name="class0"]').selectOption("passenger");
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  await page.getByText("設定を保存しました", { exact: true }).waitFor();
  const [settingsDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "設定のJSONを保存" }).click(),
  ]);
  const olderSettings = await readFile(await settingsDownload.path());

  await revisedBoard.fill("1200");
  await openOud(
    "new-timetable.oud2",
    oud.replace("235000,1;241000", "235500,1;241500"),
  );
  await page
    .getByText(/駅利用者数などの設定を新しいダイヤに引き継ぎました/)
    .waitFor();
  assert.match(
    await page.locator("#messages").innerText(),
    /下にスクロールして駅属性と利用目的を設定してください/,
  );
  assert.equal(await revisedBoard.inputValue(), "1200");
  assert.equal(await capacity.inputValue(), "600");
  assert.equal(await page.locator('[name="class0"]').inputValue(), "passenger");
  assert.equal(await page.locator("#active-dia").inputValue(), "oud-dia1");
  assert.equal(await day.inputValue(), "holiday");

  await importBackup("old-timetable-settings.json", olderSettings);
  await page.getByText(/現在のダイヤにJSONの設定を適用しました/).waitFor();
  assert.equal(await revisedBoard.inputValue(), "1000");
  assert.equal(await capacity.inputValue(), "600");
  await page.reload();
  assert.equal(await revisedBoard.inputValue(), "1000");
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await page
    .locator("#diagram-train")
    .selectOption({ label: "201 ／ 普通 ／ 上り" });
  await page.locator("#diagram-section").selectOption("0");
  assert.match(
    await page.locator("#diagram-segment-detail").innerText(),
    /23:55–24:15/,
  );

  // Different timetable start times must keep the clock time at the left edge.
  const stations = Array.from(
    { length: 30 },
    (_, i) => `Eki.\nEkimei=駅${i + 1}\n.\n`,
  ).join("");
  const timetables = [
    [6, 11, 19],
    [7, 11, 18],
    [12, 14, 16],
  ]
    .map((hours, i) => {
      const trains = hours.map((hour) => {
        const times = Array.from(
          { length: 30 },
          (_, index) => `1;${hour * 100 + index}`,
        ).join(",");
        return `Ressya.\nHoukou=Kudari\nSyubetsu=0\nEkiJikoku=${times}\n.\n`;
      });
      return `Dia.\nDiaName=ダイヤ${i + 1}\nKudari.\n${trains.join("")}.\n.\n`;
    })
    .join("");
  await page.getByRole("link", { name: "データ設定" }).click();
  await openOud(
    "viewport.oud2",
    `FileType=OuDiaSecond.1.17\nRosen.\nRosenmei=表示位置の検証\n${stations}Ressyasyubetsu.\nSyubetsumei=普通\n.\n${timetables}.\n`,
  );
  await page.getByText(/viewport\.oud2を読み込みました/).waitFor();
  await page.getByRole("link", { name: "混雑ダイヤ図" }).click();
  await zoom.selectOption("320");
  await diagramTrain.selectOption("oud-0-Kudari-1");
  await section.selectOption("0");
  const typeEmphasis = page.getByLabel("強調する種別");
  await typeEmphasis.selectOption({ label: "普通" });
  await plot.evaluate((el) => el.scrollTo(1200, 180));
  const plotPosition = () => plot.evaluate((el) => [el.scrollLeft, el.scrollTop]);
  assert.deepEqual(await plotPosition(), [1200, 180]);

  const timetable = page.locator("#active-dia");
  await timetable.selectOption("oud-dia1");
  assert.equal(await zoom.inputValue(), "320");
  assert.deepEqual(await plotPosition(), [880, 180]);
  assert.equal(await diagramTrain.inputValue(), "");
  assert.equal(await section.isDisabled(), true);
  assert.equal(await typeEmphasis.inputValue(), "0");
  await timetable.selectOption("oud-dia0");
  assert.deepEqual(await plotPosition(), [1200, 180]);
  await day.selectOption("friday");
  assert.deepEqual(await plotPosition(), [1200, 180]);
  await timetable.selectOption("oud-dia2");
  assert.deepEqual(await plotPosition(), [0, 180]);

  assert.equal(
    await page.evaluate(() => localStorage.getItem("railway-lab-v1")),
    legacyStored,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Renewal smoke passed: route, worker, haze, direction, stroke width, zoom scale, smoothed hourly destination arrivals, capacity limit, external trains, versioned JSON, timetable updates, midnight, mobile",
  );
} finally {
  await context.close();
}
