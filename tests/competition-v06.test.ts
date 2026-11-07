import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand, validateAssignment } from "../src/assignment";
import { statesAt } from "../src/assignment-diagnostics";
import { networkSample } from "../src/network-sample";
it("rejects a contradictory legacy representative / fine-integration setting", () => {
  const s = setup();
  Object.assign(s.c.arrivalModel, {
    mode: "representative",
    timing: "uniform",
  });
  expect(() => s.run()).toThrow("時刻分布モデル");
});
it("preserves fractional proportional shares under record and demand permutations", () => {
  const s = setup();
  s.c.integer = false;
  s.rows[0].passengers = 8.3;
  s.rows[1].passengers = 8.7;
  s.p.timetables[0].trains[0].capacity = 11;
  const a = byPurpose(s.run());
  s.rows.reverse();
  const b = byPurpose(s.run());
  expect(b.commute).toBeCloseTo(a.commute, 10);
  expect(b.school).toBeCloseTo(a.school, 10);
  expect(a.commute + a.school).toBeCloseTo(11, 10);
});
it("converges toward the analytic mean wait for a front-loaded continuous arrival assumption", () => {
  const s = setup();
  s.c.capacityConstrained = false;
  s.c.integer = false;
  s.rows.splice(1);
  s.rows[0].passengers = 60;
  s.p.timetables[0].trains[0].stops[0].departure = 30;
  Object.assign(s.c.arrivalModel, {
    distribution: "front",
    timing: "weighted",
    integrationSeconds: 1,
  });
  const r = s.run(),
    cs = new Map(r.cohorts.map((c) => [c.id, c])),
    wait =
      r.allocations.reduce(
        (sum, a) =>
          sum +
          (r.journeys[a.journeyId].departure - cs.get(a.cohortId)!.arrival) *
            a.passengers,
        0,
      ) / r.totals.assigned;
  expect(r.totals.assigned).toBeCloseTo(45, 8);
  expect(Math.abs(wait - 50 / 3)).toBeLessThan(0.01);
});
it("shares one capacity when a timetable has two departure positions at the same timestamp", () => {
  const s = setup();
  s.rows[1].origin = "s2";
  s.p.timetables[0].trains[0].stops = [
    { stationId: "s0", status: "stop", departure: 60 },
    { stationId: "s2", status: "stop", arrival: 60, departure: 60 },
    { stationId: "s4", status: "stop", arrival: 120 },
  ];
  const r = s.run();
  expect(r.capacity!.totals.completed).toBe(10);
  expect(r.capacity!.loads[0].peakLoad).toBe(10);
});
it("requires an explicit zero transfer setting for an arrival-time connection", () => {
  const s = setup();
  s.c.maxTransfers = 1;
  s.p.timetables[0].trains = [
    {
      ...s.p.timetables[0].trains[0],
      stops: [
        { stationId: "s0", status: "stop", departure: 40 },
        { stationId: "s2", status: "stop", arrival: 60 },
      ],
    },
    {
      ...s.p.timetables[0].trains[0],
      id: "b",
      stops: [
        { stationId: "s2", status: "stop", departure: 60 },
        { stationId: "s4", status: "stop", arrival: 120 },
      ],
    },
  ];
  expect(s.run().capacity!.totals.completed).toBe(0);
  s.c.minimumTransferSeconds = 0;
  expect(s.run().capacity!.totals.completed).toBe(10);
});
it("does not retroactively board a simultaneous departure after a zero-duration ride", () => {
  const s = setup();
  s.c.maxTransfers = 1;
  s.c.minimumTransferSeconds = 0;
  s.p.timetables[0].trains = [
    {
      ...s.p.timetables[0].trains[0],
      stops: [
        { stationId: "s0", status: "stop", departure: 60 },
        { stationId: "s2", status: "stop", arrival: 60 },
      ],
    },
    {
      ...s.p.timetables[0].trains[0],
      id: "b",
      stops: [
        { stationId: "s2", status: "stop", departure: 60 },
        { stationId: "s4", status: "stop", arrival: 120 },
      ],
    },
  ];
  const r = s.run();
  expect(r.capacity!.totals.completed).toBe(0);
  expect(r.audit!.events.some((e) => e.kind === "connection-closed")).toBe(
    true,
  );
});
it("preserves detailed state totals after multiple walking transfers and a midnight shift", () => {
  const s = networkSample(),
    third = structuredClone(s.projects[1]);
  third.datasetId = "third";
  third.timetables[0].trains = [
    {
      id: "last",
      number: "3",
      typeId: "local",
      direction: "down",
      capacity: 60,
      stops: [
        { stationId: "s0", status: "stop", departure: 28600 },
        { stationId: "s2", status: "stop", arrival: 28900 },
      ],
    },
  ];
  s.projects.push(third);
  s.links.push({
    id: "second-walk",
    from: { datasetId: "fiction-bus", stationId: "s2" },
    to: { datasetId: "third", stationId: "s0" },
    walkingSeconds: 120,
    direction: "forward",
    basis: "fiction only",
  });
  s.demands[0].destinationDatasetId = "third";
  s.config.serviceMapping.members.push({
    datasetId: "third",
    timetableId: "weekday",
    group: s.config.serviceMapping.group,
  });
  s.config.maxTransfers = 2;
  s.config.simulationEnd = 30000;
  Object.assign(s.config, {
    competition: "simultaneous",
    diagnosticMode: "full",
  });
  const shift = 60000;
  for (const p of s.projects)
    for (const t of p.timetables[0].trains)
      for (const stop of t.stops) {
        if (stop.arrival !== undefined) stop.arrival += shift;
        if (stop.departure !== undefined) stop.departure += shift;
      }
  s.config.start += shift;
  s.config.end += shift;
  s.config.simulationEnd += shift;
  for (const row of s.demands) {
    row.start += shift;
    row.end += shift;
  }
  const r = assignDemand(
    buildRoutingIndex(
      s.projects.map((project) => ({
        project,
        datasetId: project.datasetId!,
        timetableId: "weekday",
      })),
      s.links,
    ),
    s.demands,
    s.config,
  );
  expect(r.capacity!.totals.completed).toBe(40);
  expect(
    r.audit!.points.every(
      (p) => Object.values(p.states).reduce((s, v) => s + v, 0) === 60,
    ),
  ).toBe(true);
  expect(
    r
      .capacity!.packets.filter((p) => p.state === "completed")
      .every((p) => p.history.length === 3),
  ).toBe(true);
});
it("does not concentrate low-density integer arrivals at the beginning of a fine grid", () => {
  const s = networkSample();
  Object.assign(s.config, {
    competition: "simultaneous",
    diagnosticMode: "full",
  });
  Object.assign(s.config.arrivalModel, {
    timing: "uniform",
    integrationSeconds: 1,
  });
  const r = assignDemand(
    buildRoutingIndex(
      s.projects.map((project) => ({
        project,
        datasetId: project.datasetId!,
        timetableId: "weekday",
      })),
      s.links,
    ),
    s.demands,
    s.config,
  );
  expect(r.capacity!.totals.completed).toBe(40);
  expect(r.cohorts[0].arrival).toBeGreaterThan(25200);
  expect(r.cohorts.at(-1)!.arrival).toBeGreaterThan(26000);
});
function setup() {
  const p = sampleProject();
  p.timetables[0].trains = [
    {
      id: "a",
      number: "1",
      typeId: "local",
      direction: "down",
      capacity: 10,
      stops: [
        { stationId: "s0", status: "stop", departure: 60 },
        { stationId: "s4", status: "stop", arrival: 120 },
      ],
    },
  ];
  const c = {
    ...defaultAssignmentConfig(),
    start: 0,
    end: 60,
    simulationEnd: 300,
    maxTransfers: 0,
    integer: true,
    capacityConstrained: true,
    competition: "simultaneous" as const,
    diagnosticMode: "full" as const,
    arrivalModel: {
      mode: "minute" as const,
      distribution: "uniform" as const,
      stepSeconds: 60,
    },
  };
  const rows: AssignmentDemand[] = ["commute", "school"].map((purpose) => ({
    datasetId: p.datasetId!,
    origin: "s0",
    destination: "s4",
    purpose: purpose as "commute" | "school",
    kind: "outbound",
    start: 0,
    end: 60,
    passengers: 8,
    source: "manual",
  }));
  const run = () =>
    assignDemand(
      buildRoutingIndex([
        { project: p, datasetId: p.datasetId!, timetableId: "weekday" },
      ]),
      rows,
      c,
    );
  return { p, c, rows, run };
}
const byPurpose = (r: ReturnType<typeof assignDemand>) =>
  Object.fromEntries(
    r.input.map((d, i) => [
      d.purpose,
      r
        .capacity!.packets.filter(
          (p) =>
            r.cohorts.find((c) => c.id === p.cohortId)!.demandIndex === i &&
            p.state === "completed",
        )
        .reduce((s, p) => s + p.passengers, 0),
    ]),
  );
it("proportionally allocates tied FIFO passengers and ignores OD input order", () => {
  const s = setup(),
    a = s.run();
  expect(byPurpose(a)).toEqual({ commute: 5, school: 5 });
  s.rows.reverse();
  expect(byPurpose(s.run())).toEqual(byPurpose(a));
  expect(a.capacity!.totals).toMatchObject({ completed: 10, waiting: 6 });
});
it("uses simultaneous alternatives without exceeding shared capacity or depending on record order", () => {
  const s = setup();
  s.p.timetables[0].trains[0].capacity = 5;
  s.p.timetables[0].trains.push({
    ...structuredClone(s.p.timetables[0].trains[0]),
    id: "b",
    number: "2",
  });
  const a = s.run();
  expect(a.capacity!.totals.completed).toBe(10);
  expect(a.capacity!.loads.map((l) => l.peakLoad)).toEqual([5, 5]);
  s.p.timetables[0].trains.reverse();
  s.rows.reverse();
  expect(byPurpose(s.run())).toEqual(byPurpose(a));
  for (const [i, t] of s.p.timetables[0].trains.entries()) t.id = "renamed" + i;
  expect(byPurpose(s.run())).toEqual(byPurpose(a));
});
it("prioritizes earlier station readiness over a later group", () => {
  const s = setup();
  s.rows[0].end = 20;
  s.rows[1].start = 20;
  s.rows[1].end = 40;
  expect(byPurpose(s.run())).toEqual({ commute: 8, school: 2 });
});
it("preserves integer totals for indivisible proportional ties reproducibly", () => {
  const s = setup();
  s.p.timetables[0].trains[0].capacity = 9;
  const a = byPurpose(s.run());
  expect(Object.values(a).reduce((x, y) => x + y, 0)).toBe(9);
  s.rows.reverse();
  expect(byPurpose(s.run())).toEqual(a);
});
it("audits demand before occurrence, during travel, and after arrival with split ancestry", () => {
  const s = setup(),
    r = s.run();
  expect(statesAt(r, 0).states.notStarted).toBe(16);
  expect(statesAt(r, 60).states).toMatchObject({ inTransit: 10, waiting: 6 });
  expect(statesAt(r, 120).states.completed).toBe(10);
  expect(
    r
      .audit!.events.filter((e) => e.kind === "alight")
      .every((e) => e.stationId === "s4"),
  ).toBe(true);
  expect(r.audit!.points.every((p) => Math.abs(p.error) < 1e-8)).toBe(true);
  expect(r.capacity!.packets.some((p) => p.parentId !== undefined)).toBe(true);
  expect(r.audit!.events.some((e) => e.kind === "denied")).toBe(true);
  expect(r.audit!.events.some((e) => e.kind === "initial-route")).toBe(true);
});
it("keeps walking passengers and all intermediate audit totals across multiple datasets", () => {
  const s = networkSample();
  s.config.competition = "simultaneous";
  s.config.diagnosticMode = "full";
  const idx = buildRoutingIndex(
      s.projects.map((project) => ({
        project,
        datasetId: project.datasetId!,
        timetableId: "weekday",
      })),
      s.links,
    ),
    r = assignDemand(idx, s.demands, s.config);
  expect(statesAt(r, 26460).states.walking).toBe(40);
  expect(r.capacity!.totals.completed).toBe(40);
  expect(validateAssignment(idx, r)).toEqual([]);
  expect(r.audit!.events.some((e) => e.kind === "reroute")).toBe(true);
});
it("enforces boarding cutoff and distinguishes start vs midpoint at an exact minute boundary", () => {
  const s = setup();
  s.rows.splice(1);
  s.rows[0].passengers = 6;
  s.p.timetables[0].trains[0].stops[0].departure = 0;
  const mid = s.run();
  expect(mid.capacity!.totals.completed).toBe(0);
  s.c.arrivalModel = {
    ...s.c.arrivalModel,
    timing: "start",
  } as typeof s.c.arrivalModel;
  const start = s.run();
  expect(start.capacity!.totals.completed).toBe(6);
  Object.assign(s.c, { boardingCutoffSeconds: 1 });
  expect(s.run().capacity!.totals.completed).toBe(0);
});
it("integrates continuous-uniform passenger arrivals at one second precision while retaining timetable times", () => {
  const s = setup();
  s.c.capacityConstrained = false;
  s.rows.splice(1);
  s.rows[0].passengers = 60;
  s.p.timetables[0].trains[0].stops[0].departure = 30;
  Object.assign(s.c.arrivalModel, { timing: "uniform", integrationSeconds: 1 });
  const r = s.run();
  expect(r.cohorts).toHaveLength(60);
  expect(r.totals.assigned).toBe(30);
  expect(Object.values(r.journeys)[0].departure).toBe(30);
  expect(
    r.cohorts.every((c) => c.arrival >= c.start && c.arrival < c.end),
  ).toBe(true);
});
it("releases seats before simultaneous boarding at an intermediate station", () => {
  const s = setup();
  s.c.maxTransfers = 1;
  s.p.timetables[0].trains[0].stops = [
    { stationId: "s0", status: "stop", departure: 60 },
    { stationId: "s2", status: "stop", arrival: 100, departure: 100 },
    { stationId: "s4", status: "stop", arrival: 160 },
  ];
  s.rows[0].destination = "s2";
  s.rows[1].origin = "s2";
  expect(s.run().capacity!.totals.completed).toBe(16);
});
it("summary mode retains audited checkpoints without pretending to have full traces", () => {
  const s = setup();
  Object.assign(s.c, { diagnosticMode: "summary" });
  const r = s.run();
  expect(r.audit!.events).toHaveLength(0);
  expect(r.audit!.counts.board).toBeGreaterThan(0);
  expect(r.audit!.checks).toBeGreaterThan(0);
  expect(r.audit!.points.at(-1)!.states.completed).toBe(10);
});
