import { describe, it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import {
  generateTemporalDemand,
  defaultTemporalConfig,
  allocateVolume,
  resplitTemporal,
  resizeTimeSlots,
} from "../src/temporal-demand";
import { validateProject } from "../src/model";
import { buildRoutingIndex } from "../src/routing";
import { analyzeService } from "../src/service";
import { compareODService } from "../src/od-service";
import type { RouteQuery } from "../src/routing-model";
describe("目的別・時間帯別需要", () => {
  it("preserves every daily OD across fractional hourly bins and all four purposes", () => {
    const p = sampleProject(),
      c = defaultTemporalConfig();
    p.temporal = generateTemporalDemand(p, c);
    expect(new Set(p.temporal.daily.map((r) => r.purpose)).size).toBe(4);
    for (const d of p.temporal.daily) {
      const total = p.temporal.slots
        .filter(
          (s) =>
            s.origin === d.origin &&
            s.destination === d.destination &&
            s.kind === d.kind &&
            s.purpose === d.purpose &&
            s.source === d.source,
        )
        .reduce((a, b) => a + b.passengers, 0);
      expect(total).toBeCloseTo(d.passengers, 8);
    }
    expect(() => validateProject(p)).not.toThrow();
  });
  it("uses largest remainders and conserves integer daily demand exactly", () => {
    expect(allocateVolume(5, [1, 1, 1], true)).toEqual([2, 2, 1]);
    const p = sampleProject(),
      c = defaultTemporalConfig();
    c.rounding = "integer";
    p.temporal = generateTemporalDemand(p, c);
    expect(p.temporal.slots.every((r) => Number.isInteger(r.passengers))).toBe(
      true,
    );
    expect(p.temporal.slots.reduce((s, r) => s + r.passengers, 0)).toBe(
      p.temporal.daily.reduce((s, r) => s + r.passengers, 0),
    );
    expect(() => validateProject(p)).not.toThrow();
  });
  it("retains return OD direction, stay distribution and next-day demand without wrapping", () => {
    const p = sampleProject(),
      c = defaultTemporalConfig();
    for (const r of c.purposes) {
      r.timeWeights = Array(24).fill(0);
      r.timeWeights[18] = 1;
      r.stayDistribution = [{ minutes: 600, weight: 1 }];
    }
    const result = generateTemporalDemand(p, c);
    expect(
      result.slots.some(
        (r) => r.kind === "return" && r.start >= c.serviceDayStart + 86400,
      ),
    ).toBe(true);
    const o = result.daily.find(
      (r) => r.kind === "outbound" && r.passengers > 0,
    )!;
    expect(
      result.daily.find(
        (r) =>
          r.kind === "return" &&
          r.origin === o.destination &&
          r.destination === o.origin &&
          r.purpose === o.purpose,
      )!.passengers,
    ).toBeCloseTo(o.passengers);
  });
  it("is independent of timetable edits after generation and round trips JSON", () => {
    const p = sampleProject();
    p.temporal = generateTemporalDemand(p, defaultTemporalConfig());
    const original = JSON.stringify(p.temporal);
    p.timetables[0].trains = [];
    expect(JSON.stringify(p.temporal)).toBe(original);
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });
  it("supports 15-minute slots and conserves distributions during resizing", () => {
    const c = defaultTemporalConfig(),
      next = resizeTimeSlots(c, 15);
    expect(next.purposes[0].timeWeights).toHaveLength(96);
    expect(next.purposes[0].timeWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(
      c.purposes[0].timeWeights.reduce((a, b) => a + b, 0),
    );
    expect(resizeTimeSlots(next, 60)).toEqual(c);
    const p = sampleProject();
    const result = generateTemporalDemand(p, next);
    expect(result.slots.every((r) => r.end - r.start === 900)).toBe(true);
  });
  it("preserves manual and observed outbound sources while labeling generated returns estimated", () => {
    const p = sampleProject(),
      state = generateTemporalDemand(p, defaultTemporalConfig());
    state.dailyOutbound[0].source = "observed";
    state.dailyOutbound[1].source = "manual";
    p.temporal = resplitTemporal(state);
    expect(
      p.temporal.slots.some(
        (s) => s.kind === "outbound" && s.source === "observed",
      ),
    ).toBe(true);
    expect(
      p.temporal.slots
        .filter((s) => s.kind === "return")
        .every((s) => s.source === "estimated"),
    ).toBe(true);
    expect(() => validateProject(p)).not.toThrow();
  });
  it("honors manual per-OD hourly distribution and preserves total", () => {
    const p = sampleProject(),
      state = generateTemporalDemand(p, defaultTemporalConfig());
    const row = state.dailyOutbound[0];
    row.passengers = 10;
    row.source = "manual";
    state.manualSplits = [
      {
        origin: row.origin,
        destination: row.destination,
        purpose: row.purpose,
        counts: [10, ...Array(23).fill(0)],
      },
    ];
    p.temporal = resplitTemporal(state);
    expect(
      p.temporal.slots.find(
        (s) =>
          s.kind === "outbound" &&
          s.origin === row.origin &&
          s.destination === row.destination &&
          s.purpose === row.purpose,
      )!.passengers,
    ).toBe(10);
    expect(() => validateProject(p)).not.toThrow();
  });
  it("reports missing-cost allocation and refuses invalid weights or corrupted totals", () => {
    const p = sampleProject();
    const result = generateTemporalDemand(p, defaultTemporalConfig(), {});
    expect(result.unallocated).toBeGreaterThan(0);
    expect(result.slots).toHaveLength(0);
    const c = defaultTemporalConfig();
    c.purposes[0].timeWeights.fill(0);
    expect(() => generateTemporalDemand(p, c)).toThrow();
    p.temporal = generateTemporalDemand(p, defaultTemporalConfig());
    p.temporal.slots[0].passengers += 1;
    expect(() => validateProject(p)).toThrow("総量");
  });
  it("links fixed OD demand to service and changes service without changing demand", () => {
    const p = sampleProject();
    p.temporal = generateTemporalDemand(p, defaultTemporalConfig());
    const origin = { datasetId: p.datasetId!, stationId: "s0" },
      destination = { datasetId: p.datasetId!, stationId: "s4" };
    const q: RouteQuery = {
      origin,
      destination,
      mode: "depart",
      time: 25200,
      maxTransfers: 1,
      minimumTransferSeconds: 120,
      directOnly: false,
      sort: "arrival",
    };
    const idx = buildRoutingIndex([
      { datasetId: p.datasetId!, project: p, timetableId: "weekday" },
    ]);
    const service = analyzeService(idx, q, 25200, 28800);
    const demand = compareODService(
      p,
      origin,
      destination,
      25200,
      28800,
      service.allJourneys,
    )!;
    expect(demand.daily).toBeGreaterThan(0);
    expect(demand.hourly).toBeGreaterThan(0);
    expect(demand.unserved).toBe(0);
    const before = JSON.stringify(p.temporal);
    const empty = buildRoutingIndex([
      {
        datasetId: p.datasetId!,
        project: { ...p, timetables: [{ ...p.timetables[0], trains: [] }] },
        timetableId: "weekday",
      },
    ]);
    const noService = analyzeService(empty, q, 25200, 28800);
    expect(
      compareODService(
        p,
        origin,
        destination,
        25200,
        28800,
        noService.allJourneys,
      )!.unserved,
    ).toBeCloseTo(demand.hourly);
    expect(JSON.stringify(p.temporal)).toBe(before);
  });
});
