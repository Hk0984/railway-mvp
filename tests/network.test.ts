import { it, expect } from "vitest";
import { networkSample } from "../src/network-sample";
import {
  buildRoutingIndex,
  searchJourneys,
  validateJourney,
} from "../src/routing";
import { assignDemand, queryFor, validateAssignment } from "../src/assignment";
import { stopEventId } from "../src/integration-model";
const setup = () => {
  const s = networkSample();
  return {
    ...s,
    selections: s.projects.map((project) => ({
      datasetId: project.datasetId!,
      project,
      timetableId: "weekday",
    })),
  };
};
it("keeps walking, denied transfers and shared vehicle balances across midnight", () => {
  const s = setup(),
    shift = 60000;
  for (const p of s.projects)
    for (const tt of p.timetables)
      for (const t of tt.trains)
        for (const stop of t.stops) {
          if (stop.arrival !== undefined) stop.arrival += shift;
          if (stop.departure !== undefined) stop.departure += shift;
        }
  for (const row of s.demands) {
    row.start += shift;
    row.end += shift;
  }
  s.config.start += shift;
  s.config.end += shift;
  s.config.simulationEnd += shift;
  const r = assignDemand(
    buildRoutingIndex(s.selections, s.links),
    s.demands,
    s.config,
  );
  expect(r.capacity!.totals).toMatchObject({
    selected: 60,
    completed: 40,
    noPath: 20,
  });
  expect(
    r.capacity!.events.some(
      (e) => e.time > 86400 && e.datasetId === "fiction-bus",
    ),
  ).toBe(true);
  expect(r.capacity!.loads.every((l) => l.peakLoad <= l.capacity!)).toBe(true);
  expect(
    validateAssignment(buildRoutingIndex(s.selections, s.links), r),
  ).toEqual([]);
});
it("uses one vehicle stock for different OD records and purposes", () => {
  const s = setup();
  s.demands.push({ ...s.demands[0], purpose: "school" });
  const r = assignDemand(
    buildRoutingIndex(s.selections, s.links),
    s.demands,
    s.config,
  );
  expect(r.capacity!.totals).toMatchObject({
    selected: 120,
    completed: 75,
    waiting: 5,
    noPath: 40,
  });
  expect(r.capacity!.loads.every((l) => l.peakLoad <= l.capacity!)).toBe(true);
});
it("processes zero-minute transfers and walk completion before same-time departures", () => {
  const s = setup();
  s.config.minimumTransferSeconds = 0;
  s.links[0].walkingSeconds = 0;
  s.links[0].additionalTransferSeconds = 0;
  s.projects[1].timetables[0].trains[0].stops[0].departure = 26400;
  const r = assignDemand(
    buildRoutingIndex(s.selections, s.links),
    s.demands,
    s.config,
  );
  expect(r.capacity!.totals.completed).toBe(40);
  expect(
    r
      .capacity!.events.filter(
        (e) =>
          e.type === "board" &&
          e.datasetId === "fiction-bus" &&
          e.time === 26400,
      )
      .reduce((s, e) => s + e.passengers, 0),
  ).toBe(25);
});
it("reroutes a denied passenger over a second explicit walk instead of keeping the old bus", () => {
  const s = setup();
  s.links.push({
    id: "alternate-platform",
    from: { datasetId: "fiction-bus", stationId: "s1" },
    to: { datasetId: "fiction-bus", stationId: "s0" },
    walkingSeconds: 30,
    direction: "forward",
    basis: "架空の別乗り場",
  });
  s.projects[1].timetables[0].trains.push({
    id: "alternate",
    number: "alt",
    typeId: "local",
    direction: "down",
    capacity: 50,
    stops: [
      { stationId: "s0", status: "stop", departure: 26820 },
      { stationId: "s2", status: "stop", arrival: 27700 },
    ],
  });
  const r = assignDemand(
    buildRoutingIndex(s.selections, s.links),
    s.demands,
    s.config,
  );
  expect(
    r.capacity!.loads.find((l) => l.trainId === "alternate")!.peakLoad,
  ).toBe(15);
  expect(r.capacity!.loads.find((l) => l.trainId === "later")!.peakLoad).toBe(
    0,
  );
  expect(r.capacity!.totals.additionalWaitPersonSeconds).toBe(450);
});
it("rejects a completed state assigned to a wrong dataset", () => {
  const s = setup(),
    idx = buildRoutingIndex(s.selections, s.links),
    r = assignDemand(idx, s.demands, s.config);
  r.capacity!.packets.find((p) => p.state === "completed")!.datasetId =
    "fiction-rail";
  expect(validateAssignment(idx, r)).toContain("終端状態不正");
});
it("keeps identical train/station IDs separate and uses only explicit pedestrian links", () => {
  const s = setup(),
    idx = buildRoutingIndex(s.selections, s.links);
  expect(idx.trips.size).toBe(3);
  expect(stopEventId("a", "d", "t", 1, "departure")).not.toBe(
    stopEventId("b", "d", "t", 1, "departure"),
  );
  const q = queryFor(s.demands[0], s.config, 25200);
  expect(
    searchJourneys(buildRoutingIndex(s.selections), q).journeys,
  ).toHaveLength(0);
  const route = searchJourneys(idx, q).journeys[0];
  expect(route.legs.map((l) => l.datasetId)).toEqual([
    "fiction-rail",
    "fiction-bus",
  ]);
  expect(route.walkingSeconds).toBe(180);
  expect(
    route.transfers[0].departure - route.transfers[0].arrival,
  ).toBeGreaterThanOrEqual(300);
  expect(validateJourney(idx, q, route)).toEqual([]);
});
it("shares capacity across routes, preserves denied transfers and walks without duplicating OD", () => {
  const s = setup(),
    idx = buildRoutingIndex(s.selections, s.links),
    r = assignDemand(idx, s.demands, s.config);
  expect(validateAssignment(idx, r)).toEqual([]);
  expect(r.capacity!.version).toBe(2);
  const t = r.capacity!.totals;
  expect(t.selected).toBe(60);
  expect(t.completed).toBe(40);
  expect(t.waiting + t.noPath).toBe(20);
  expect(t.deniedUnique).toBe(15);
  expect(t.reassigned).toBe(15);
  expect(
    r
      .capacity!.loads.filter((l) => l.datasetId === "fiction-bus")
      .map((l) => l.peakLoad),
  ).toEqual([25, 15]);
  expect(
    r
      .capacity!.events.filter((e) => e.type === "board")
      .reduce((s, e) => s + e.passengers, 0),
  ).toBe(80);
});
it("retains pedestrian packets at a cutoff and never calls them completed", () => {
  const s = setup(),
    r = assignDemand(buildRoutingIndex(s.selections, s.links), s.demands, {
      ...s.config,
      simulationEnd: 26500,
    });
  expect(r.capacity!.totals.walking).toBe(40);
  expect(r.capacity!.totals.completed).toBe(0);
  expect(r.capacity!.totals.noPath).toBe(20);
  expect(r.capacity!.totals.inTransit).toBe(0);
});
it("does not use forward links backwards, disabled links or unapproved restrictions", () => {
  const s = setup();
  for (const link of [
    { ...s.links[0], enabled: false },
    { ...s.links[0], restrictions: ["staff-only"] },
  ]) {
    const idx = buildRoutingIndex(s.selections, [link]);
    expect(
      searchJourneys(idx, queryFor(s.demands[0], s.config, 25200)).journeys,
    ).toHaveLength(0);
  }
  const idx = buildRoutingIndex(
    s.selections,
    [{ ...s.links[0], restrictions: ["permit"] }],
    { permittedRestrictions: ["permit"] },
  );
  expect(
    searchJourneys(idx, queryFor(s.demands[0], s.config, 25200)).journeys
      .length,
  ).toBeGreaterThan(0);
  const fromBus = idx.walks.get('["fiction-bus","s1"]')!;
  expect(fromBus.some((w) => w.to.datasetId === "fiction-rail")).toBe(false);
});
it("rejects missing, inconsistent or stale day mappings rather than inferring calendars", () => {
  const s = setup(),
    idx = buildRoutingIndex(s.selections, s.links);
  expect(() =>
    assignDemand(idx, s.demands, { ...s.config, serviceMapping: undefined }),
  ).toThrow("利用日");
  const map = structuredClone(s.config.serviceMapping);
  map.members[1].group = "休日";
  expect(() =>
    assignDemand(idx, s.demands, { ...s.config, serviceMapping: map }),
  ).toThrow("利用日");
  map.members[1].group = map.group;
  map.members[1].timetableId = "other";
  expect(() =>
    assignDemand(idx, s.demands, { ...s.config, serviceMapping: map }),
  ).toThrow("対応");
});
it("accepts cross-dataset OD whose station IDs are the same without treating it as a diagonal", () => {
  const s = setup();
  s.demands[0].destination = "s0";
  const r = assignDemand(
    buildRoutingIndex(s.selections, s.links),
    s.demands,
    s.config,
  );
  expect(r.capacity!.totals.noPath).toBe(60);
});
