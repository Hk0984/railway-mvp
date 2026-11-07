import { createHash } from "node:crypto";
import { benchmarkData } from "../tests/benchmark-data";
import { writeFileSync } from "node:fs";
import { assignDemand as reference } from "../tests/helpers/assignment-v04";
import { assignDemand } from "../src/assignment";
import { buildRoutingIndex } from "../src/routing";
import { buildRoutingIndex as beforeIndex } from "../tests/helpers/routing-v04";
import { clearAssignmentCache } from "../src/assignment-cache";
const [method, sizeText, pattern] = process.argv.slice(2),
  size = Number(sizeText),
  [stations, trains, records] = [
    [5, 12, 40],
    [40, 24, 600],
    [110, 32, 2000],
  ][size];
const data = benchmarkData(
  stations,
  trains,
  records,
  pattern as "sparse" | "repeated",
);
clearAssignmentCache();
if (method === "fixture") {
  writeFileSync(
    `artifacts/v05-browser-${pattern}.json`,
    JSON.stringify({
      schemaVersion: 1,
      projects: [data.project],
      activeDatasetId: data.project.datasetId,
      transferLinks: [],
      integration: {
        version: 1,
        permittedRestrictions: [],
        config: {
          ...data.config,
          capacityConstrained: false,
          simulationEnd: 36000,
          arrivalModel: {
            mode: "minute",
            distribution: "uniform",
            stepSeconds: 60,
          },
          serviceMapping: {
            group: "性能検証日",
            basis: "架空ベンチマークの明示設定",
            members: [
              {
                datasetId: data.project.datasetId,
                timetableId: "weekday",
                group: "性能検証日",
              },
            ],
          },
        },
        demands: data.demands,
      },
    }),
  );
  process.exit(0);
}
(globalThis as typeof globalThis & { gc?: () => void }).gc?.();
const before = process.memoryUsage(),
  t0 = performance.now(),
  idx = (method === "before" ? beforeIndex : buildRoutingIndex)([
    {
      datasetId: data.project.datasetId!,
      project: data.project,
      timetableId: "weekday",
    },
  ]),
  t1 = performance.now(),
  r = (method === "before" ? reference : assignDemand)(
    idx,
    data.demands,
    data.config,
  ),
  t2 = performance.now(),
  after = process.memoryUsage();
const peakAfterAssignment = process.resourceUsage().maxRSS;
const exact = {
  totals: r.totals,
  allocations: r.allocations,
  cohorts: r.cohorts,
  unallocated: r.unallocated,
  loads: r.loads,
  journeys: r.journeys,
};
const hash = createHash("sha256").update(JSON.stringify(exact)).digest("hex");
process.stdout.write(
  JSON.stringify({
    method,
    stations,
    trains,
    records,
    nonzero: data.demands.filter((d) => d.passengers).length,
    uniqueNonzeroOD: new Set(
      data.demands
        .filter((d) => d.passengers)
        .map((d) => d.origin + ">" + d.destination),
    ).size,
    pattern,
    window: data.window,
    buildMs: t1 - t0,
    assignmentMs: t2 - t1,
    totalMs: t2 - t0,
    journeyCandidatesUsed: Object.keys(r.journeys).length,
    profiles: r.diagnostics.profiles,
    candidateJourneys: r.diagnostics.candidateJourneys ?? 0,
    beforeHeap: before.heapUsed,
    afterHeap: after.heapUsed,
    heapIncrease: after.heapUsed - before.heapUsed,
    rss: after.rss,
    peakProcessRssKiB: peakAfterAssignment,
    peakWithVerificationKiB: process.resourceUsage().maxRSS,
    hash,
  }),
);
