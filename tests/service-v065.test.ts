import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { buildRoutingIndex } from "../src/routing";
import { analyzeService } from "../src/service";
export function overtakingFixture() {
  const p = sampleProject();
  p.datasetId = "effective-example";
  const train = (
    id: string,
    from: string,
    to: string,
    departure: number,
    arrival: number,
  ) => ({
    id,
    number: id,
    typeId: "local",
    direction: "down" as const,
    stops: [
      { stationId: from, status: "stop" as const, departure },
      { stationId: to, status: "stop" as const, arrival },
    ],
  });
  p.timetables[0].trains = [
    train("先発直通", "s0", "s4", 25200, 28800),
    train("後発速達", "s0", "s1", 25800, 26400),
    train("接続1", "s1", "s2", 26520, 27000),
    train("接続2", "s2", "s4", 27120, 28800),
  ];
  return p;
}
function run(
  maxTransfers: number,
  end = 29000,
  alter?: (p: ReturnType<typeof overtakingFixture>) => void,
) {
  const p = overtakingFixture();
  alter?.(p);
  return analyzeService(
    buildRoutingIndex([
      { project: p, datasetId: p.datasetId!, timetableId: "weekday" },
    ]),
    {
      origin: { datasetId: p.datasetId!, stationId: "s0" },
      destination: { datasetId: p.datasetId!, stationId: "s4" },
      mode: "depart",
      time: 25000,
      sort: "arrival",
      maxTransfers,
      minimumTransferSeconds: 120,
      directOnly: maxTransfers === 0,
    },
    25000,
    end,
  );
}
it("counts only the later departure even when it requires two transfers and the early train is direct", () => {
  const r = run(2);
  expect(r.journeyDepartures).toEqual([25800]);
  expect(r.journeys[0].transferCount).toBe(2);
  expect(r.replacedDirect[0]).toMatchObject({
    trainId: "先発直通",
    replacement: { departure: 25800, arrival: 28800 },
  });
});
it("retains the earlier direct train when two changes are not permitted", () => {
  expect(run(0).journeyDepartures).toEqual([25200]);
  expect(run(1).journeyDepartures).toEqual([25200]);
});
it("lets a later two-transfer opportunity outside the window invalidate an inside departure", () => {
  const r = run(2, 25500);
  expect(r.journeyCount).toBe(0);
  expect(r.replacedDirect[0].replacement.departure).toBe(25800);
});
it("retains both departures if the later train arrives even one second later", () => {
  const r = run(2, 29000, (p) => {
    p.timetables[0].trains[3].stops[1].arrival = 28801;
  });
  expect(r.journeyDepartures).toEqual([25200, 25800]);
  expect(r.replacedDirect).toHaveLength(0);
});
it("does not use an impossible connection or a non-passenger later service", () => {
  expect(
    run(2, 29000, (p) => {
      p.timetables[0].trains[2].stops[0].departure = 26519;
    }).journeyDepartures,
  ).toEqual([25200]);
  expect(
    run(2, 29000, (p) => {
      p.serviceClasses!.types.local.state = "nonPassenger";
    }).journeyCount,
  ).toBe(0);
});
it("counts simultaneous equivalent departures once, without counting route permutations", () => {
  const r = run(2, 29000, (p) => {
    p.timetables[0].trains.push({
      ...structuredClone(p.timetables[0].trains[1]),
      id: "同時発車別便",
    });
  });
  expect(r.journeyCount).toBe(1);
  expect(r.journeyDepartures).toEqual([25800]);
});
