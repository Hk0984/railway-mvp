import { describe, it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand, validateAssignment } from "../src/assignment";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
  type AssignmentConfig,
} from "../src/assignment-model";
import { validateProject, type Train, type Stop } from "../src/model";
import {
  capacitySpec,
  trainCarCount,
  transportCapacity,
} from "../src/capacity-model";
const stop = (
  stationId: string,
  arrival?: number,
  departure?: number,
  status: Stop["status"] = "stop",
): Stop => ({ stationId, arrival, departure, status });
const train = (
  id: string,
  departure: number,
  arrival: number,
  capacity?: number,
  origin = "s0",
  destination = "s4",
): Train => ({
  id,
  number: id,
  typeId: "local",
  direction: "down",
  capacity,
  stops: [stop(origin, undefined, departure), stop(destination, arrival)],
});
function project(trains: Train[]) {
  const p = sampleProject();
  p.datasetId = "cap";
  p.timetables = [{ id: "d", name: "d", trains }];
  return p;
}
const row = (changes: Partial<AssignmentDemand> = {}): AssignmentDemand => ({
  datasetId: "cap",
  origin: "s0",
  destination: "s4",
  purpose: "commute",
  kind: "outbound",
  source: "manual",
  passengers: 100,
  start: 0,
  end: 60,
  ...changes,
});
const config = (changes: Partial<AssignmentConfig> = {}): AssignmentConfig => ({
  ...defaultAssignmentConfig(),
  start: 0,
  end: 60,
  capacityConstrained: true,
  maxTransfers: 1,
  minimumTransferSeconds: 30,
  ...changes,
});
function run(trains: Train[], rows = [row()], c = config()) {
  const p = project(trains),
    idx = buildRoutingIndex([
      { datasetId: "cap", project: p, timetableId: "d" },
    ]),
    r = assignDemand(idx, rows, c);
  expect(validateAssignment(idx, r)).toEqual([]);
  return r;
}
describe("定員制約の時系列配分", () => {
  it("boards everyone within capacity", () => {
    const r = run([train("a", 100, 200, 120)]);
    expect(r.capacity!.totals.completed).toBe(100);
    expect(r.capacity!.totals.deniedUnique).toBe(0);
    expect(r.capacity!.loads[0].segmentLoads).toEqual([100]);
  });
  it("retains excess without a later service", () => {
    const r = run([train("a", 100, 200, 60)]);
    expect(r.capacity!.totals).toMatchObject({
      completed: 60,
      waiting: 40,
      deniedUnique: 40,
      deniedEvents: 40,
    });
    expect(r.capacity!.loads[0].peakOccupancy).toBe(1);
  });
  it("reroutes denied passengers to a later service and counts extra waiting", () => {
    const r = run([train("a", 100, 200, 60), train("b", 300, 400, 60)]);
    expect(r.capacity!.totals).toMatchObject({
      completed: 100,
      waiting: 0,
      reassigned: 40,
      additionalWaitPersonSeconds: 8000,
    });
    expect(r.capacity!.loads.map((l) => l.peakLoad)).toEqual([60, 40]);
  });
  it("keeps repeatedly denied passengers exactly once", () => {
    const r = run([
      train("a", 100, 200, 30),
      train("b", 300, 400, 30),
      train("c", 500, 600, 30),
    ]);
    expect(r.capacity!.totals).toMatchObject({
      completed: 90,
      waiting: 10,
      deniedUnique: 70,
      deniedEvents: 120,
      reassigned: 60,
    });
  });
  it("alights before boarding and reuses released capacity at an intermediate stop", () => {
    const t = train("a", 100, 400, 60);
    t.stops = [
      stop("s0", undefined, 100),
      stop("s2", 200, 220),
      stop("s4", 400),
    ];
    const r = run(
      [t],
      [
        row({ destination: "s2", passengers: 60 }),
        row({ origin: "s2", passengers: 60 }),
      ],
    );
    expect(r.capacity!.totals.completed).toBe(120);
    expect(r.capacity!.loads[0].boardings).toEqual([60, 60, 0]);
    expect(r.capacity!.loads[0].alightings).toEqual([0, 60, 60]);
    expect(r.capacity!.loads[0].segmentLoads).toEqual([60, 60]);
  });
  it("handles a denied transfer without leaving passengers on an abandoned planned train", () => {
    const r = run([
      train("a", 100, 200, 100, "s0", "s2"),
      train("b", 230, 300, 40, "s2", "s4"),
      train("c", 350, 400, 100, "s2", "s4"),
    ]);
    expect(r.capacity!.totals).toMatchObject({
      completed: 100,
      reassigned: 60,
      waiting: 0,
    });
    expect(r.capacity!.loads.map((l) => l.totalBoardings)).toEqual([
      100, 40, 60,
    ]);
    expect(
      r
        .capacity!.events.filter((e) => e.type === "board")
        .reduce((s, e) => s + e.passengers, 0),
    ).toBe(200);
  });
  it("does not use an impossible transfer", () => {
    const r = run([
      train("a", 100, 200, 100, "s0", "s2"),
      train("b", 229, 300, 100, "s2", "s4"),
    ]);
    expect(r.capacity!.totals.noPath).toBe(100);
    expect(r.capacity!.totals.completed).toBe(0);
  });
  it("never boards passing stops", () => {
    const t = train("a", 100, 300, 50);
    t.stops = [
      stop("s0", undefined, 100),
      stop("s2", 200, 200, "pass"),
      stop("s4", 300),
    ];
    const r = run([t], [row({ origin: "s2" })]);
    expect(r.capacity!.totals.noPath).toBe(100);
  });
  it("handles return demand after midnight without wrapping time", () => {
    const r = run(
      [
        train("a", 87000, 88000, 60, "s4", "s0"),
        train("b", 88500, 89000, 60, "s4", "s0"),
      ],
      [
        row({
          origin: "s4",
          destination: "s0",
          start: 86400,
          end: 86460,
          kind: "return",
        }),
      ],
      config({ start: 86400, end: 86460 }),
    );
    expect(r.capacity!.totals.completed).toBe(100);
    expect(r.capacity!.totals.reassigned).toBe(40);
  });
  it("refuses unknown transport capacity and can explicitly exclude it", () => {
    expect(() => run([train("a", 100, 200)])).toThrow("輸送定員");
    const r = run(
      [train("a", 100, 200)],
      undefined,
      config({ unknownCapacityPolicy: "exclude" }),
    );
    expect(r.capacity!.totals.noPath).toBe(100);
    expect(r.capacity!.warnings.some((w) => w.includes("明示設定"))).toBe(true);
  });
  it("distinguishes seat capacity from transport capacity and validates metadata", () => {
    const p = project([train("a", 100, 200)]);
    p.capacitySettings = {
      timetables: { d: { value: 40, kind: "seats", basis: "座席のみ" } },
      types: {},
      trains: {},
    };
    expect(transportCapacity(p, "d", "a")).toBeNull();
    p.capacitySettings.timetables.d.kind = "transport";
    expect(transportCapacity(p, "d", "a")).toBe(40);
    p.capacitySettings.trains['["d","a"]'] = {
      value: 70,
      kind: "transport",
      basis: "設定輸送定員",
      vehicle: "2両",
    };
    expect(capacitySpec(p, "d", "a")?.vehicle).toBe("2両");
    validateProject(p);
    p.capacitySettings.trains['["d","a"]'].basis = "";
    expect(() => validateProject(p)).toThrow("根拠");
  });
  it("inherits the type's car count independently of the train's capacity", () => {
    const a = train("a", 100, 200, 800);
    const p = project([a]);
    p.capacitySettings = {
      timetables: {},
      types: {
        local: { kind: "transport", value: 600, basis: "種別", carCount: 6 },
      },
      trains: {},
    };
    expect(trainCarCount(p, "d", a)).toBe(6);
    p.types[0].carCount = 8;
    expect(trainCarCount(p, "d", a)).toBe(8);
    expect(transportCapacity(p, "d", a.id)).toBe(800);
    p.capacitySettings.trains['["d","a"]'] = {
      kind: "transport",
      value: 800,
      basis: "列車別",
      carCount: 10,
    };
    expect(trainCarCount(p, "d", a)).toBe(10);
    validateProject(p);
    p.types[0].carCount = 0;
    expect(() => validateProject(p)).toThrow("種別の編成両数");
  });
  it("applies the provisional capacity only to ungrouped trains in operation mode", () => {
    const a = train("a", 100, 200);
    const b = train("b", 500, 600);
    b.operationNumbers = ["32D"];
    const p = project([a, b]);
    const caps = (p.capacitySettings = {
      formationSource: "operation",
      ungroupedOperationCapacity: 60,
      trains: {},
      types: { local: { value: 90, kind: "transport", basis: "種別" } },
      timetables: {},
    });
    expect(transportCapacity(p, "d", "a")).toBe(60);
    expect(transportCapacity(p, "d", "b")).toBe(90);
    const r = assignDemand(
      buildRoutingIndex([{ datasetId: "cap", project: p, timetableId: "d" }]),
      [row()],
      config(),
    );
    expect(r.capacity!.loads.find((l) => l.trainId === "a")).toMatchObject({
      capacity: 60,
      capacitySource: "ungrouped",
      segmentLoads: [60],
    });
    p.capacitySettings!.formationSource = "type";
    expect(transportCapacity(p, "d", "a")).toBe(90);
    p.capacitySettings!.formationSource = "operation";
    a.capacity = 100;
    expect(transportCapacity(p, "d", "a")).toBe(100);
    validateProject(JSON.parse(JSON.stringify(p)));
    caps.ungroupedOperationCapacity = 0;
    expect(() => validateProject(p)).toThrow("未分類列車の仮輸送定員");
  });
  it("does not use non-passenger trains", () => {
    const a = train("a", 100, 200, 60),
      b = train("b", 300, 400, 100);
    b.typeId = "rapid";
    const p = project([a, b]);
    p.serviceClasses!.types.rapid.state = "nonPassenger";
    const r = assignDemand(
      buildRoutingIndex([{ datasetId: "cap", project: p, timetableId: "d" }]),
      [row()],
      config(),
    );
    expect(r.capacity!.totals.completed).toBe(60);
    expect(r.capacity!.loads).toHaveLength(1);
  });
  it("preserves 0.3 results when capacity is disabled", () => {
    const p = project([train("a", 100, 200, 1)]),
      idx = buildRoutingIndex([
        { datasetId: "cap", project: p, timetableId: "d" },
      ]);
    const a = assignDemand(
        idx,
        [row()],
        config({ capacityConstrained: false }),
      ),
      c = config();
    delete c.capacityConstrained;
    const b = assignDemand(idx, [row()], c);
    expect(a.allocations).toEqual(b.allocations);
    expect(a.loads).toEqual(b.loads);
    expect(a.totals).toEqual(b.totals);
    expect(a.capacity).toBeUndefined();
  });
  it("retains in-transit, waiting and no-path as disjoint states at cutoff", () => {
    const r = run(
      [train("a", 100, 400, 60)],
      [row(), row({ origin: "s1", passengers: 20 })],
      config({ simulationEnd: 150 }),
    );
    expect(r.capacity!.totals).toMatchObject({
      selected: 120,
      completed: 0,
      inTransit: 60,
      waiting: 40,
      noPath: 20,
    });
    expect(
      r.capacity!.loads[0].totalBoardings -
        r.capacity!.loads[0].totalAlightings,
    ).toBe(60);
  });
  it("keeps integer totals under logit choice and partial boardings", () => {
    const r = run(
      [
        train("a", 100, 200, 2),
        train("b", 100, 200, 2),
        train("c", 300, 400, 3),
      ],
      [row({ passengers: 7 })],
      config({ integer: true, method: "logit" }),
    );
    expect(r.capacity!.totals.completed).toBe(7);
    expect(
      r.capacity!.packets.every((p) => Number.isInteger(p.passengers)),
    ).toBe(true);
  });
  it("respects the original wait and travel deadline on rerouting", () => {
    const r = run([train("a", 100, 200, 30), train("b", 5000, 5100, 100)]);
    expect(r.capacity!.totals.completed).toBe(30);
    expect(r.capacity!.totals.waiting).toBe(70);
  });
  it("supports a zero-duration ride and keeps late segments outside the horizon unobserved", () => {
    const zero = run([train("zero", 100, 100, 60)]);
    expect(zero.capacity!.totals.completed).toBe(60);
    const tr = train("long", 100, 400, 100);
    tr.stops = [
      stop("s0", undefined, 100),
      stop("s2", 200, 220),
      stop("s4", 400),
    ];
    const r = run([tr], undefined, config({ simulationEnd: 150 }));
    expect(r.capacity!.loads[0].segmentObserved).toEqual([true, false]);
    expect(r.capacity!.loads[0].segmentLoads).toEqual([100, 0]);
    expect(r.capacity!.loads[0].occupancies).toEqual([1, null]);
    expect(r.capacity!.totals.inTransit).toBe(100);
  });
  it("detects damaged terminal states without contaminating cached profiles", () => {
    const p = project([train("a", 100, 200, 100)]),
      idx = buildRoutingIndex([
        { datasetId: "cap", project: p, timetableId: "d" },
      ]);
    const r = assignDemand(idx, [row()], config());
    r.capacity!.packets[0].state = "inTransit";
    expect(validateAssignment(idx, r)).toContain("旅客の終端状態不正");
    const a = assignDemand(
      idx,
      [row()],
      config({ capacityConstrained: false }),
    );
    Object.values(a.journeys)[0].legs[0].departure = 1;
    a.loads[0].stops[0].departure = 1;
    const b = assignDemand(
      idx,
      [row()],
      config({ capacityConstrained: false }),
    );
    expect(Object.values(b.journeys)[0].legs[0].departure).toBe(100);
    expect(b.loads[0].stops[0].departure).toBe(100);
  });
});
