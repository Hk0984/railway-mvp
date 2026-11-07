import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "vite";
import { resolve } from "node:path";
const source = execFileSync("git", ["show", "69edfe8:src/assignment.ts"], {
  encoding: "utf8",
})
  .replaceAll('from "./', 'from "../../src/')
  .replace('from "../../src/routing"', 'from "./routing-v04"')
  .replace('import { cachedProfile } from "../../src/assignment-cache";', "")
  .replace("journeys = cachedProfile(", "journeys = journeyProfile(")
  .replace(
    "result.diagnostics.profiles++;",
    "result.diagnostics.profiles++;result.diagnostics.candidateJourneys=(result.diagnostics.candidateJourneys??0)+journeys.length;",
  );
writeFileSync(
  "tests/helpers/routing-v04.ts",
  execFileSync("git", ["show", "69edfe8:src/routing.ts"], {
    encoding: "utf8",
  }).replaceAll('from "./', 'from "../../src/'),
);
writeFileSync("tests/helpers/assignment-v04.ts", source);
mkdirSync("artifacts", { recursive: true });
await build({
  configFile: false,
  logLevel: "error",
  build: {
    lib: {
      entry: resolve("scripts/benchmark-v05-entry.ts"),
      formats: ["cjs"],
      fileName: () => "benchmark-v05.cjs",
    },
    outDir: "artifacts/benchmark-v05",
    emptyOutDir: false,
    minify: false,
    rollupOptions: { external: ["node:crypto", "node:fs"] },
  },
});
const reports = [];
for (let size = 0; size < 3; size++)
  for (const pattern of ["repeated", "sparse"]) {
    const pair = [];
    for (const method of ["before", "after"]) {
      const r = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--expose-gc",
            "artifacts/benchmark-v05/benchmark-v05.cjs",
            method,
            String(size),
            pattern,
          ],
          { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
        ),
      );
      pair.push(r);
    }
    if (
      pair[0].hash !== pair[1].hash ||
      pair[0].candidateJourneys !== pair[1].candidateJourneys
    )
      throw new Error("Result mismatch " + size + " " + pattern);
    const report = {
      before: pair[0],
      after: pair[1],
      sameResults: true,
      timeReductionPercent:
        (1 - pair[1].assignmentMs / pair[0].assignmentMs) * 100,
    };
    reports.push(report);
    console.log(
      JSON.stringify({
        stations: pair[0].stations,
        pattern,
        beforeMs: pair[0].assignmentMs,
        afterMs: pair[1].assignmentMs,
        sameResults: true,
      }),
    );
  }
writeFileSync(
  "artifacts/sparse-performance-v05.json",
  JSON.stringify(
    {
      node: process.version,
      mode: "isolated child process for every method/workload; representative arrival, fastest, direct; deterministic, GC before measurement; process peak RSS includes JS runtime, heap is before/after only; not Chrome or Worker peak",
      reports,
    },
    null,
    2,
  ),
);
