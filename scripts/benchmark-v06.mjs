import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { build } from "vite";
import { resolve } from "node:path";
mkdirSync("artifacts/ref-v05", { recursive: true });
const names = [
  "assignment",
  "routing",
  "assignment-cache",
  "capacity-assignment",
  "integrated-assignment",
  "arrival-distribution",
  "event-queue",
];
for (const name of names) {
  let s = execFileSync("git", ["show", `9b52aad:src/${name}.ts`], {
    encoding: "utf8",
  });
  s = s.replace(
    /from "\.\/([^"\n]+)"/g,
    (_, file) => `from "${names.includes(file) ? "./" : "../../src/"}${file}"`,
  );
  writeFileSync(`artifacts/ref-v05/${name}.ts`, s);
}
await build({
  configFile: false,
  logLevel: "error",
  build: {
    lib: {
      entry: resolve("scripts/benchmark-v06-entry.ts"),
      formats: ["cjs"],
      fileName: () => "benchmark-v06.cjs",
    },
    outDir: "artifacts/benchmark-v06",
    emptyOutDir: false,
    minify: false,
    rollupOptions: { external: ["node:crypto", "node:fs"] },
  },
});
const reports = [];
for (const kind of ["repeated", "sparse", "capacity-walk"])
  for (let size = 0; size < 3; size++) {
    const pair = [];
    for (const method of ["before", "after"]) {
      try {
        pair.push(
          JSON.parse(
            execFileSync(
              process.execPath,
              [
                "--expose-gc",
                "artifacts/benchmark-v06/benchmark-v06.cjs",
                method,
                String(size),
                kind,
              ],
              {
                encoding: "utf8",
                windowsHide: true,
                maxBuffer: 2e6,
                timeout: 30000,
              },
            ),
          ),
        );
      } catch (error) {
        pair.push({
          method,
          error: error.code ?? error.message,
          timeoutMs: 30000,
        });
      }
    }
    if (
      kind !== "capacity-walk" &&
      !pair.some((x) => x.error) &&
      pair[0].hash !== pair[1].hash
    )
      throw Error("Regression " + kind + size);
    reports.push({
      kind,
      size,
      before: pair[0],
      after: pair[1],
      sameResults:
        kind === "capacity-walk" || pair.some((x) => x.error)
          ? null
          : pair[0].hash === pair[1].hash,
    });
    console.log(JSON.stringify(reports.at(-1)));
  }
writeFileSync(
  "artifacts/performance-v06.json",
  JSON.stringify(
    {
      node: process.version,
      note: "Fresh Node process per sample, GC before. Node heap before/after is not peak heap. maxRSS captured before JSON verification. Capacity compares explicitly changed competition rules; equality is not claimed. Single cold run, no confidence interval. 30-second timeout reports no measurement.",
      reports,
    },
    null,
    2,
  ),
);
