import { it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { sampleProject } from "../src/sample";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand } from "../src/assignment";
import { assignDemand as beforeAssign } from "./helpers/assignment-v03";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
import { cachedProfile, clearAssignmentCache } from "../src/assignment-cache";
import { queryFor } from "../src/assignment";
it("measures small/medium/large aggregate OD workloads and preserves all allocations", () => {
  const reports = [];
  for (const [size, count, trains] of [
    ["small", 20, 12],
    ["medium", 200, 48],
    ["large", 2000, 120],
  ] as const) {
    const p = sampleProject();
    p.timetables[0].trains = p.timetables[0].trains.slice(
      0,
      Math.min(trains, 72),
    );
    while (p.timetables[0].trains.length < trains) {
      const t = structuredClone(
        p.timetables[0].trains[p.timetables[0].trains.length % 36],
      );
      t.id += "-extra-" + p.timetables[0].trains.length;
      p.timetables[0].trains.push(t);
    }
    const idx = buildRoutingIndex([
      { datasetId: p.datasetId!, project: p, timetableId: p.timetables[0].id },
    ]);
    const c = { ...defaultAssignmentConfig(), maxTransfers: 0 };
    const input: AssignmentDemand[] = Array.from({ length: count }, (_, i) => ({
      datasetId: p.datasetId!,
      origin: "s0",
      destination: i % 2 ? "s3" : "s4",
      purpose: i % 2 ? "school" : "commute",
      kind: "outbound",
      source: "estimated",
      start: 25200,
      end: 28800,
      passengers: 10 + (i % 7),
    }));
    const heapBefore = process.memoryUsage().heapUsed,
      t0 = performance.now();
    const before = [
      beforeAssign(idx, input, c),
      beforeAssign(idx, input, { ...c, method: "logit" }),
    ];
    const beforeMs = performance.now() - t0,
      heapMiddle = process.memoryUsage().heapUsed;
    clearAssignmentCache();
    const t1 = performance.now();
    const after = [
      assignDemand(idx, input, c),
      assignDemand(idx, input, { ...c, method: "logit" }),
    ];
    const afterMs = performance.now() - t1,
      heapAfter = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2; i++) {
      expect(after[i].totals).toEqual(before[i].totals);
      expect(after[i].cohorts).toEqual(before[i].cohorts);
      expect(after[i].allocations).toEqual(before[i].allocations);
      expect(after[i].unallocated).toEqual(before[i].unallocated);
      expect(after[i].loads).toEqual(before[i].loads);
    }
    reports.push({
      size,
      odRecords: count,
      trains,
      beforeMs,
      afterMs,
      improvementPercent: (1 - afterMs / beforeMs) * 100,
      beforeHeapDelta: heapMiddle - heapBefore,
      afterHeapDelta: heapAfter - heapMiddle,
      heapUsed: heapAfter,
      rss: process.memoryUsage().rss,
      maxRssProcessKiB: process.resourceUsage().maxRSS,
      sameResults: true,
    });
  }
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/assignment-performance.json",
    JSON.stringify(
      {
        node: process.version,
        seed: "deterministic-no-randomness",
        workload:
          "fastest + logit, direct only, repeated OD/time/purpose records; one process; GC not controlled; memory is process observation, not isolated peak per method",
        reports,
      },
      null,
      2,
    ),
  );
  console.log(reports);
}, 120000);
it("isolates profile cache by timetable snapshot and transfer conditions", () => {
  const p = sampleProject();
  const idx = buildRoutingIndex([
    { datasetId: p.datasetId!, project: p, timetableId: p.timetables[0].id },
  ]);
  const row: AssignmentDemand = {
    datasetId: p.datasetId!,
    origin: "s0",
    destination: "s4",
    purpose: "commute",
    kind: "outbound",
    source: "manual",
    passengers: 1,
    start: 25200,
    end: 28800,
  };
  const q = queryFor(
    row,
    { ...defaultAssignmentConfig(), maxTransfers: 0 },
    25200,
  );
  expect(cachedProfile(idx, q)).toBe(cachedProfile(idx, q));
  expect(cachedProfile(idx, { ...q, minimumTransferSeconds: 999 })).not.toBe(
    cachedProfile(idx, q),
  );
  p.serviceClasses!.types.local.state = "nonPassenger";
  const next = buildRoutingIndex([
    { datasetId: p.datasetId!, project: p, timetableId: p.timetables[0].id },
  ]);
  expect(cachedProfile(next, q)).not.toBe(cachedProfile(idx, q));
  expect(
    cachedProfile(next, q).every((j) =>
      j.legs.every((l) => l.typeId === "rapid"),
    ),
  ).toBe(true);
});
