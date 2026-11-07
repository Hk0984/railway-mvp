import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  reports = [];
await mkdir("artifacts", { recursive: true });
for (const kind of ["repeated", "sparse", "capacity-walk"])
  for (const size of [0, 1, 2]) {
    const pattern = kind + "-" + size,
      fixture = JSON.parse(
        await readFile("artifacts/v06-browser-" + pattern + ".json", "utf8"),
      );
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH ||
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(120000);
    const errors = [],
      outside = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!/^(http:\/\/127\.0\.0\.1:5173|data:|blob:)/.test(r.url()))
        outside.push(r.url());
    });
    const root = await browser.newBrowserCDPSession(),
      renderer = await page.context().newCDPSession(page);
    const samples = [];
    let pending = null;
    const sample = () => {
      if (pending) return pending;
      pending = (async () => {
        try {
          const info = await root.send("SystemInfo.getProcessInfo");
          const ids = info.processInfo
            .map((p) => Number(p.id))
            .filter((p) => Number.isSafeInteger(p) && p > 0);
          if (!ids.length) return;
          const result = await exec(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`,
            ],
            { windowsHide: true },
          );
          const bytes = Number(result.stdout.trim());
          if (Number.isFinite(bytes))
            samples.push({
              time: performance.now(),
              workingSetSumBytes: bytes,
              processes: ids.length,
            });
        } finally {
          pending = null;
        }
      })();
      return pending;
    };
    let timer;
    try {
      await page.goto("http://127.0.0.1:5173/");
      await page.locator('[data-page="1"]').click();
      await page
        .locator('[data-file="json"]')
        .setInputFiles(`artifacts/v06-browser-${pattern}.json`);
      await page
        .getByRole("status")
        .filter({ hasText: `v06-browser-${pattern}.json を読み込みました` })
        .waitFor();
      await page.locator('[data-page="11"]').click();
      await sample();
      const beforeHeap = await renderer.send("Runtime.getHeapUsage"),
        baseline = samples.at(-1)?.workingSetSumBytes ?? null;
      await page.evaluate(() => {
        globalThis.benchmarkBeat = {
          ticks: 0,
          maxGap: 0,
          last: performance.now(),
        };
        globalThis.benchmarkTimer = setInterval(() => {
          const now = performance.now();
          globalThis.benchmarkBeat.ticks++;
          globalThis.benchmarkBeat.maxGap = Math.max(
            globalThis.benchmarkBeat.maxGap,
            now - globalThis.benchmarkBeat.last,
          );
          globalThis.benchmarkBeat.last = now;
        }, 25);
      });
      timer = setInterval(() => {
        void sample().catch(() => {});
      }, 500);
      const start = performance.now();
      await page.locator('[data-net-action="run"]').click();
      await page.locator("#network-result").waitFor();
      const milliseconds = performance.now() - start;
      const heartbeat = await page.evaluate(() => {
        clearInterval(globalThis.benchmarkTimer);
        return globalThis.benchmarkBeat;
      });
      clearInterval(timer);
      if (pending) await pending;
      await sample();
      const afterHeap = await renderer.send("Runtime.getHeapUsage");
      assert.equal(
        await page.locator('#network-page [role="alert"]').count(),
        0,
      );
      const measured = await page.evaluate(() => globalThis.railwayPerformance);
      assert.ok(measured?.workerComputeMs >= 0);
      assert.ok(heartbeat.ticks > 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(outside, []);
      const peak = Math.max(...samples.map((s) => s.workingSetSumBytes));
      reports.push({
        pattern,
        stations: fixture.projects[0].stations.length,
        trains: fixture.projects.reduce(
          (s, p) => s + p.timetables[0].trains.length,
          0,
        ),
        odRecords: fixture.integration.demands.length,
        arrivalMode: "minute / 60 seconds",
        capacityConstrained:
          fixture.integration.config.capacityConstrained ?? false,
        stages: measured,
        milliseconds,
        mainRendererHeapBefore: beforeHeap.usedSize,
        mainRendererHeapAfter: afterHeap.usedSize,
        chromeWorkingSetBaseline: baseline,
        chromeWorkingSetObservedMax: peak,
        chromeWorkingSetIncrease: baseline === null ? null : peak - baseline,
        heartbeat,
        samples,
      });
      await page.screenshot({
        path: `artifacts/v06-browser-performance-${pattern}.png`,
        fullPage: false,
      });
      console.log(
        JSON.stringify({
          pattern,
          milliseconds,
          observedChromeWorkingSetMB: peak / 1e6,
          maxHeartbeatGapMs: heartbeat.maxGap,
        }),
      );
    } finally {
      clearInterval(timer);
      if (pending) await pending.catch(() => {});
      await browser.close();
    }
  }
await writeFile(
  "artifacts/browser-performance-v06.json",
  JSON.stringify(
    {
      note: "Fresh headless Chrome per workload. CDP main-renderer heap excludes Workers. OS WorkingSet64 summed for process IDs enumerated by this Chrome CDP session, sampled about every 500ms: includes shared pages more than once, excludes dedicated GPU memory, not a strict continuous peak. Timing includes button action, Worker, transfer and result rendering; excludes dataset import. Node heap and browser working set are separate measurements.",
      reports,
    },
    null,
    2,
  ),
);
