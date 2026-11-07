import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { benchmarkData } from "../tests/benchmark-data";
import { assignDemand as beforeAssign } from "../artifacts/ref-v05/assignment";
import { buildRoutingIndex as beforeIndex } from "../artifacts/ref-v05/routing";
import { assignDemand } from "../src/assignment";
import { buildRoutingIndex } from "../src/routing";
import { clearAssignmentCache } from "../src/assignment-cache";
const [method, sizeText, kind] = process.argv.slice(2),
  size = Number(sizeText),
  stations = [5, 40, 110][size],
  capacity = kind === "capacity-walk",
  trains = capacity ? [4, 6, 8][size] : [12, 24, 32][size],
  records = capacity ? [12, 40, 80][size] : [40, 600, 2000][size],
  data = benchmarkData(
    stations,
    trains,
    records,
    kind === "repeated" ? "repeated" : "sparse",
  );
let projects = [data.project],
  links: any[] = [],
  config: any = { ...data.config };
if (capacity) {
  const rail = data.project,
    bus = structuredClone(rail);
  rail.datasetId = "bench-rail";
  bus.datasetId = "bench-bus";
  for (const p of [rail, bus])
    for (const t of p.timetables[0].trains) {
      t.capacity = p === rail ? 15 : 10;
      if (p === bus)
        for (const s of t.stops) {
          if (s.arrival !== undefined) s.arrival += stations * 30 + 1200;
          if (s.departure !== undefined) s.departure += stations * 30 + 1200;
        }
    }
  projects = [rail, bus];
  links = [
    {
      id: "explicit-walk",
      from: { datasetId: rail.datasetId, stationId: "s" + (stations - 1) },
      to: { datasetId: bus.datasetId, stationId: "s0" },
      walkingSeconds: 180,
      additionalTransferSeconds: 30,
      direction: "forward",
      basis: "fictional benchmark only",
    },
  ];
  data.demands = data.demands.map((d, i) => ({
    ...d,
    datasetId: rail.datasetId!,
    destinationDatasetId: bus.datasetId!,
    origin: "s" + (i % (stations - 1)),
    destination: "s" + (1 + ((i * 7) % (stations - 1))),
  }));
  config = {
    ...config,
    capacityConstrained: true,
    maxTransfers: 1,
    simulationEnd: 43200,
    arrivalModel: { mode: "minute", distribution: "uniform", stepSeconds: 60 },
    serviceMapping: {
      group: "benchmark",
      basis: "explicit fictional pairing",
      members: projects.map((p) => ({
        datasetId: p.datasetId,
        timetableId: "weekday",
        group: "benchmark",
      })),
    },
    competition: method === "before" ? "legacy" : "simultaneous",
    diagnosticMode: "summary",
  };
}
if (method === "fixture") {
  writeFileSync(
    `artifacts/v06-browser-${kind}-${size}.json`,
    JSON.stringify({
      schemaVersion: 1,
      projects,
      activeDatasetId: projects[0].datasetId,
      transferLinks: links,
      integration: {
        version: 1,
        permittedRestrictions: [],
        config: {
          ...config,
          arrivalModel: config.arrivalModel ?? {
            mode: "minute",
            distribution: "uniform",
            stepSeconds: 60,
          },
          serviceMapping: config.serviceMapping ?? {
            group: "benchmark",
            basis: "explicit fictional day",
            members: projects.map((p) => ({
              datasetId: p.datasetId,
              timetableId: "weekday",
              group: "benchmark",
            })),
          },
        },
        demands: data.demands,
      },
    }),
  );
  process.exit(0);
}
clearAssignmentCache();
(globalThis as any).gc?.();
const heapBefore = process.memoryUsage().heapUsed,
  start = performance.now(),
  idx = (method === "before" ? beforeIndex : buildRoutingIndex)(
    projects.map((project) => ({
      project,
      datasetId: project.datasetId!,
      timetableId: "weekday",
    })),
    links,
  ),
  indexed = performance.now(),
  r = (method === "before" ? beforeAssign : assignDemand)(
    idx,
    data.demands,
    config,
  ),
  finished = performance.now(),
  heapAfter = process.memoryUsage().heapUsed,
  peakRssKiB = process.resourceUsage().maxRSS;
const totals = r.capacity?.totals;
if (totals) {
  const sum = [
    "completed",
    "waiting",
    "walking",
    "noPath",
    "inTransit",
    "notStarted",
  ].reduce((s, k) => s + (totals[k as keyof typeof totals] ?? 0), 0);
  if (Math.abs(sum - totals.selected) > 1e-6) throw Error("Conservation");
}
const hash = createHash("sha256")
  .update(
    JSON.stringify({
      totals: r.totals,
      journeys: r.journeys,
      cohorts: r.cohorts,
      allocations: r.allocations,
      unallocated: r.unallocated,
      loads: r.loads,
    }),
  )
  .digest("hex");
console.log(
  JSON.stringify({
    method,
    stations,
    trains: capacity ? 2 * trains : trains,
    records,
    nonzero: data.demands.filter((d) => d.passengers > 0).length,
    indexMs: indexed - start,
    assignmentMs: finished - indexed,
    totalMs: finished - start,
    heapBefore,
    heapAfter,
    heapIncrease: heapAfter - heapBefore,
    peakRssKiB,
    timings: r.diagnostics.timings ?? null,
    capacityTotals: totals ?? null,
    candidateJourneys: r.diagnostics.candidateJourneys ?? null,
    hash,
  }),
);
