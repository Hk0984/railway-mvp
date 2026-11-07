import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand, validateAssignment } from "../src/assignment";
import {
  defaultAssignmentConfig,
  type AssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
function data() {
  const p = sampleProject();
  p.timetables[0].trains = [100, 300, 500, 900].map((time, i) => ({
    id: "t" + i,
    number: "" + i,
    typeId: "local",
    direction: "down",
    capacity: 20,
    stops: [
      { stationId: "s0", status: "stop", departure: time },
      { stationId: "s4", status: "stop", arrival: time + 100 },
    ],
  }));
  const idx = buildRoutingIndex([
    { datasetId: p.datasetId!, project: p, timetableId: "weekday" },
  ]);
  const input: AssignmentDemand[] = [
    {
      datasetId: p.datasetId!,
      origin: "s0",
      destination: "s4",
      start: 0,
      end: 900,
      purpose: "commute",
      kind: "outbound",
      source: "manual",
      passengers: 90,
    },
  ];
  const config: AssignmentConfig = {
    ...defaultAssignmentConfig(),
    start: 0,
    end: 900,
    maxTransfers: 0,
    integer: true,
    arrivalModel: { mode: "minute", distribution: "uniform", stepSeconds: 60 },
  };
  return { p, idx, input, config };
}
it("creates minute arrivals, respects departure boundaries and conserves integer demand", () => {
  const { idx, input, config } = data(),
    r = assignDemand(idx, input, config);
  expect(r.totals.assigned).toBe(90);
  expect(r.cohorts.every((c) => c.end - c.start <= 60)).toBe(true);
  for (const a of r.allocations) {
    const c = r.cohorts.find((c) => c.id === a.cohortId)!;
    expect(r.journeys[a.journeyId].departure).toBeGreaterThanOrEqual(c.arrival);
  }
  expect(validateAssignment(idx, r)).toEqual([]);
});
it("distinguishes front, back and arbitrary arrival weights reproducibly", () => {
  const { idx, input, config } = data();
  const run = (distribution: "front" | "back" | "custom") =>
    assignDemand(idx, input, {
      ...config,
      arrivalModel: {
        mode: "minute",
        distribution,
        stepSeconds: 60,
        weights: [0, 0, 1],
      },
    });
  const a = run("front"),
    b = run("back"),
    c = run("custom");
  expect(a.loads[0].peakLoad).toBeGreaterThan(b.loads[0].peakLoad);
  expect(c.loads.slice(0, 3).every((l) => l.peakLoad === 0)).toBe(true);
  expect(c.totals.assigned).toBe(90);
  expect(run("front").allocations).toEqual(a.allocations);
});
it("adds access time only when explicitly supplied and keeps pre-arrival trains unavailable", () => {
  const { idx, input, config } = data(),
    r = assignDemand(
      idx,
      input.map((d) => ({ ...d, accessSeconds: 200 })),
      config,
    );
  expect(r.loads[0].peakLoad).toBe(0);
  expect(r.cohorts.every((c) => c.arrival >= c.start + 200)).toBe(true);
  expect(r.totals.assigned + r.totals.unassigned).toBe(90);
  expect(validateAssignment(idx, r)).toEqual([]);
});
it("maintains legacy representative mode and capacity conservation for minute arrivals", () => {
  const { idx, input, config } = data();
  const old = assignDemand(idx, input, { ...config, arrivalModel: undefined }),
    legacy = assignDemand(idx, input, {
      ...config,
      arrivalModel: {
        mode: "representative",
        distribution: "uniform",
        stepSeconds: 60,
      },
    });
  expect(old.allocations).toEqual(legacy.allocations);
  const precise = assignDemand(idx, input, {
    ...config,
    capacityConstrained: true,
  });
  expect(
    precise.capacity!.totals.completed +
      precise.capacity!.totals.waiting +
      precise.capacity!.totals.noPath,
  ).toBe(90);
  expect(precise.capacity!.loads.every((l) => l.peakLoad <= 20)).toBe(true);
});
it("works on an explicit 24-hour-plus time axis", () => {
  const { p, input, config } = data();
  p.timetables[0].trains.forEach((t) =>
    t.stops.forEach((s) => {
      if (s.departure !== undefined) s.departure += 86400;
      if (s.arrival !== undefined) s.arrival += 86400;
    }),
  );
  const idx = buildRoutingIndex([
    { datasetId: p.datasetId!, project: p, timetableId: "weekday" },
  ]);
  const r = assignDemand(
    idx,
    input.map((d) => ({ ...d, start: d.start + 86400, end: d.end + 86400 })),
    { ...config, start: 86400, end: 87300 },
  );
  expect(r.totals.assigned).toBe(90);
  expect(r.cohorts.every((c) => c.arrival >= 86400)).toBe(true);
});
