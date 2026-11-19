import { describe, expect, it } from "vitest";
import { assignDemand, queryFor } from "../src/assignment";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
import { lineAssignmentProfile } from "../src/line-assignment-profile";
import { buildRoutingIndex, journeyProfile } from "../src/routing";
import { sampleProject } from "../src/sample";
import {
  defaultLineDemand,
  estimateLineDemand,
  serviceDay,
} from "../src/line-demand";

describe("fast single-line assignment", () => {
  it("preserves assigned demand and all station-to-station loads across a sample day", () => {
    const p = sampleProject();
    p.lineDemand = defaultLineDemand(true);
    const dia = p.timetables[0];
    const config = { ...defaultAssignmentConfig(), ...serviceDay(p) };
    const index = buildRoutingIndex([
      { datasetId: p.datasetId!, project: p, timetableId: dia.id },
    ]);
    const rows = estimateLineDemand(p, dia.id).rows;
    const usual = assignDemand(index, rows, config);
    const fast = assignDemand(
      index,
      rows,
      config,
      undefined,
      lineAssignmentProfile(index),
    );
    expect(fast.totals.assigned).toBeCloseTo(usual.totals.assigned, 7);
    expect(fast.totals.unassigned).toBeCloseTo(usual.totals.unassigned, 7);
    for (let i = 0; i < fast.loads.length; i++) {
      expect(fast.loads[i].trainId).toBe(usual.loads[i].trainId);
      fast.loads[i].segmentLoads.forEach((count, j) =>
        expect(count).toBeCloseTo(usual.loads[i].segmentLoads[j], 7),
      );
    }
  });

  it("keeps a useful later departure when the maximum initial wait excludes it for earlier arrivals", () => {
    const p = sampleProject();
    const dia = p.timetables[0];
    const [first, direct, transfer] = dia.trains;
    first.stops = [
      { stationId: "s0", status: "stop", departure: 300 },
      { stationId: "s2", status: "stop", arrival: 420 },
    ];
    direct.stops = [
      { stationId: "s0", status: "stop", departure: 480 },
      { stationId: "s4", status: "stop", arrival: 840 },
    ];
    transfer.stops = [
      { stationId: "s2", status: "stop", departure: 540 },
      { stationId: "s4", status: "stop", arrival: 660 },
    ];
    dia.trains = [first, direct, transfer];
    const config = {
      ...defaultAssignmentConfig(),
      start: 100,
      end: 500,
      maxWaitSeconds: 220,
      maxJourneySeconds: 600,
    };
    const rows: AssignmentDemand[] = [
      {
        datasetId: p.datasetId!,
        origin: "s0",
        destination: "s4",
        purpose: "private",
        kind: "outbound",
        source: "manual",
        start: 100,
        end: 500,
        passengers: 400,
      },
    ];
    const index = buildRoutingIndex([
      { datasetId: p.datasetId!, project: p, timetableId: dia.id },
    ]);
    const result = assignDemand(
      index,
      rows,
      config,
      undefined,
      lineAssignmentProfile(index),
    );
    expect(result.loads.map((l) => l.segmentLoads[0])).toEqual([200, 180, 200]);
    expect(result.totals.unassigned).toBe(20);
  });

  it("supports a restricted boundary stop with explicit passing time", () => {
    const p = sampleProject();
    const dia = p.timetables[0];
    const first = dia.trains.find(({ id }) => id === "down-3")!;
    first.stops[0].status = "pass";
    const last = dia.trains.find(({ id }) => id === "up-3")!;
    last.stops.at(-1)!.status = "pass";
    last.stops.at(-1)!.departure = last.stops.at(-1)!.arrival;
    delete last.stops.at(-1)!.arrival;
    const config = { ...defaultAssignmentConfig(), start: 21600, end: 28800 };
    const index = buildRoutingIndex(
      [{ datasetId: p.datasetId!, project: p, timetableId: dia.id }],
      [],
      { includeBoundaryBoards: true },
    );
    const row = {
      datasetId: p.datasetId!,
      origin: "s0",
      destination: "s4",
      purpose: "private",
      kind: "outbound",
      source: "manual",
      start: config.start,
      end: config.end,
      passengers: 100,
    } as const;
    const rows = [
      { ...row, boundaryOriginTrains: [first.id] },
      {
        ...row,
        origin: "s4",
        destination: "s0",
        boundaryDestinationTrains: [last.id],
      },
    ];
    const fast = lineAssignmentProfile(index);
    for (const r of rows) {
      const query = queryFor(r, config, config.start);
      const reference = journeyProfile(index, query);
      const optimized = fast(query);
      expect(optimized.length).toBeGreaterThan(0);
      expect(Math.min(...optimized.map((j) => j.arrival))).toBe(
        Math.min(...reference.map((j) => j.arrival)),
      );
    }
    const reference = assignDemand(index, rows, config);
    const result = assignDemand(index, rows, config, undefined, fast);
    expect(result.totals.assigned).toBeCloseTo(reference.totals.assigned, 7);
    expect(result.totals.unassigned).toBeCloseTo(
      reference.totals.unassigned,
      7,
    );
  });
});
