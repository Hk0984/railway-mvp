import { describe, it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import type { Train, Stop, Project } from "../src/model";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand, validateAssignment } from "../src/assignment";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
  type AssignmentConfig,
} from "../src/assignment-model";
import {
  serviceClass,
  isPassengerTrain,
  trainClassKey,
} from "../src/classification";
const s = (
  stationId: string,
  arrival?: number,
  departure?: number,
  status: Stop["status"] = "stop",
): Stop => ({ stationId, arrival, departure, status });
const t = (id: string, stops: Stop[], typeId = "local"): Train => ({
  id,
  number: id,
  typeId,
  direction: "down",
  stops,
});
function fixture(trains: Train[]) {
  const p = sampleProject();
  p.datasetId = "test";
  p.timetables = [{ id: "test", name: "test", trains }];
  return p;
}
const index = (p: Project) =>
  buildRoutingIndex([{ datasetId: "test", project: p, timetableId: "test" }]);
const config = (
  overrides: Partial<AssignmentConfig> = {},
): AssignmentConfig => ({
  ...defaultAssignmentConfig(),
  start: 0,
  end: 60,
  minimumTransferSeconds: 120,
  ...overrides,
});
const row = (overrides: Partial<AssignmentDemand> = {}): AssignmentDemand => ({
  datasetId: "test",
  origin: "s0",
  destination: "s4",
  purpose: "commute",
  kind: "outbound",
  start: 0,
  end: 60,
  passengers: 60,
  source: "estimated",
  ...overrides,
});
describe("旅客配分と区間収支", () => {
  it("counts only the boarded-to-alighted interval and keeps train balances", () => {
    const p = fixture([
        t("one", [
          s("s0", undefined, 100),
          s("s1", 200, 220),
          s("s2", 250, 250, "pass"),
          s("s3", 300, 340),
          s("s4", 400),
        ]),
      ]),
      idx = index(p);
    const r = assignDemand(
      idx,
      [row({ origin: "s1", destination: "s3", passengers: 100 })],
      config(),
    );
    expect(r.totals.assigned).toBe(100);
    expect(r.loads[0].segmentLoads).toEqual([0, 100, 100, 0]);
    expect(r.loads[0].boardings).toEqual([0, 100, 0, 0, 0]);
    expect(r.loads[0].alightings).toEqual([0, 0, 0, 100, 0]);
    expect(r.loads[0].peakSegments).toEqual([1, 2]);
    expect(validateAssignment(idx, r)).toEqual([]);
  });
  it("counts transfer alightings and boardings without doubling OD volume", () => {
    const p = fixture([
      t("first", [s("s0", undefined, 100), s("s2", 200)]),
      t("second", [s("s2", undefined, 320), s("s4", 420)]),
    ]);
    const r = assignDemand(index(p), [row({ passengers: 50 })], config());
    expect(r.totals.assigned).toBe(50);
    expect(r.totals.boardingEvents).toBe(100);
    expect(r.loads.map((l) => l.totalBoardings)).toEqual([50, 50]);
    expect(
      r.loads.every(
        (l) => l.totalAlightings === 50 && l.segmentLoads[0] === 50,
      ),
    ).toBe(true);
  });
  it("does not allocate a missed transfer or board at a passing stop", () => {
    const p = fixture([
      t("first", [
        s("s0", undefined, 100),
        s("s1", 150, 150, "pass"),
        s("s2", 200),
      ]),
      t("second", [s("s2", undefined, 319), s("s4", 420)]),
    ]);
    for (const input of [row(), row({ origin: "s1" })]) {
      const r = assignDemand(index(p), [input], config());
      expect(r.totals.assigned).toBe(0);
      expect(r.totals.unassigned).toBe(60);
      expect(r.unallocated.every((r) => r.reason)).toBe(true);
    }
  });
  it("splits a slot at a departure exactly and preserves missed passengers", () => {
    const p = fixture([t("one", [s("s0", undefined, 30), s("s4", 200)])]),
      r = assignDemand(index(p), [row()], config());
    expect(r.totals.assigned).toBe(30);
    expect(r.totals.unassigned).toBe(30);
    expect(r.cohorts.map((c) => [c.start, c.end, c.passengers])).toEqual([
      [0, 30, 30],
      [30, 60, 30],
    ]);
  });
  it("keeps early slower departures when later fast trains exceed the wait limit", () => {
    const p = fixture([
      t("slow", [s("s0", undefined, 100), s("s4", 600)]),
      t("fast", [s("s0", undefined, 500), s("s4", 550)]),
    ]);
    const r = assignDemand(index(p), [row()], config({ maxWaitSeconds: 120 }));
    expect(r.totals.assigned).toBe(60);
    expect(r.loads.find((l) => l.trainId === "slow")!.peakLoad).toBe(60);
    expect(r.loads.find((l) => l.trainId === "fast")!.peakLoad).toBe(0);
  });
  it("compares deterministic and probabilistic choice and preserves odd integer totals", () => {
    const p = fixture([
        t("a", [s("s0", undefined, 100), s("s4", 200)]),
        t("b", [s("s0", undefined, 100), s("s4", 200)]),
      ]),
      c = config({ integer: true });
    c.coefficients.commute.scale = 0;
    const idx = index(p);
    const one = assignDemand(idx, [row({ passengers: 5 })], c),
      many = assignDemand(idx, [row({ passengers: 5 })], {
        ...c,
        method: "logit",
      });
    expect(one.loads.map((l) => l.peakLoad).sort()).toEqual([0, 5]);
    expect(many.loads.map((l) => l.peakLoad).sort()).toEqual([2, 3]);
    expect(many.totals.assigned + many.totals.unassigned).toBe(5);
    expect(many.allocations.every((a) => Number.isInteger(a.passengers))).toBe(
      true,
    );
  });
  it("applies purpose-specific waiting and riding coefficients to route shares", () => {
    const p = fixture([
        t("a", [s("s0", undefined, 100), s("s4", 500)]),
        t("b", [s("s0", undefined, 200), s("s4", 450)]),
      ]),
      c = config({ method: "logit" });
    c.coefficients.commute.waiting = 20;
    c.coefficients.commute.riding = 0.1;
    c.coefficients.school.waiting = 0.1;
    c.coefficients.school.riding = 20;
    const r = assignDemand(index(p), [row(), row({ purpose: "school" })], c);
    const cohorts = new Map(r.cohorts.map((c) => [c.id, c]));
    const onA = (purpose: string) =>
      r.allocations
        .filter(
          (a) =>
            r.input[cohorts.get(a.cohortId)!.demandIndex].purpose === purpose &&
            r.journeys[a.journeyId].legs[0].trainId === "a",
        )
        .reduce((s, a) => s + a.passengers, 0);
    expect(onA("commute")).toBeGreaterThan(onA("school"));
  });
  it("excludes non-passenger and review types and honors per-train overrides", () => {
    const p = fixture([
      t("a", [s("s0", undefined, 100), s("s4", 200)]),
      t("b", [s("s0", undefined, 100), s("s4", 250)], "rapid"),
    ]);
    p.serviceClasses = {
      types: { local: { state: "nonPassenger", basis: "試験で非営業と設定" } },
      trains: {},
    };
    expect(isPassengerTrain(p, "test", p.timetables[0].trains[1])).toBe(false);
    let r = assignDemand(index(p), [row()], config());
    expect(r.totals.unassigned).toBe(60);
    p.serviceClasses.trains[trainClassKey("test", "a")] = {
      state: "passenger",
      basis: "この便だけ営業として明示",
    };
    r = assignDemand(index(p), [row()], config());
    expect(r.totals.assigned).toBe(60);
    expect(r.loads).toHaveLength(1);
  });
  it("shows occupancy only with explicit capacities and allows values above 100%", () => {
    const p = fixture([t("a", [s("s0", undefined, 100), s("s4", 200)])]);
    let r = assignDemand(index(p), [row()], config());
    expect(r.loads[0].peakOccupancy).toBeNull();
    p.typeCapacities = { local: 30 };
    r = assignDemand(index(p), [row()], config());
    expect(r.loads[0].peakOccupancy).toBe(2);
    expect(r.totals.unassigned).toBe(0);
    p.timetables[0].trains[0].capacity = 100;
    r = assignDemand(index(p), [row()], config());
    expect(r.loads[0].peakOccupancy).toBe(0.6);
    expect(r.loads[0].capacitySource).toBe("train");
  });
  it("preserves return and overnight demand without wrapping the service day", () => {
    const p = fixture([
        t("night", [s("s4", undefined, 87000), s("s0", 88000)]),
      ]),
      r = assignDemand(
        index(p),
        [
          row({
            origin: "s4",
            destination: "s0",
            start: 86400,
            end: 86700,
            kind: "return",
            source: "manual",
            passengers: 11,
          }),
        ],
        config({ start: 86400, end: 87000, integer: true }),
      );
    expect(r.totals.assigned).toBe(11);
    expect(r.loads[0].segmentLoads).toEqual([11]);
  });
  it("accounts for outside-window demand and refuses fractional input in integer mode", () => {
    const p = fixture([t("a", [s("s0", undefined, 100), s("s4", 200)])]),
      idx = index(p);
    const r = assignDemand(idx, [row({ start: 0, end: 120 })], config());
    expect(r.totals.outsideWindow).toBe(30);
    expect(r.totals.selected).toBe(30);
    expect(() =>
      assignDemand(idx, [row({ passengers: 1.5 })], config({ integer: true })),
    ).toThrow("整数");
  });
  it("rejects analysis-only indexes and detects corrupted loads and path timing", () => {
    const p = fixture([t("a", [s("s0", undefined, 100), s("s4", 200)])]),
      idx = index(p),
      r = assignDemand(idx, [row()], config());
    expect(() =>
      assignDemand(
        buildRoutingIndex([
          {
            datasetId: "test",
            project: p,
            timetableId: "test",
            passengerOnly: false,
          },
        ]),
        [row()],
        config(),
      ),
    ).toThrow("分析用");
    r.loads[0].segmentLoads[0]++;
    expect(validateAssignment(idx, r)).toContain("列車乗降・車内収支不一致");
    const missing = assignDemand(idx, [row()], config());
    missing.loads[0].boardings = [];
    expect(validateAssignment(idx, missing)).toContain(
      "列車集計・定員・区間数不一致",
    );
    const invalid = assignDemand(idx, [row()], config());
    Object.values(invalid.journeys)[0].legs[0].departure = 1;
    expect(validateAssignment(idx, invalid)).toContain(
      "成立しない旅程への配分",
    );
  });
});
