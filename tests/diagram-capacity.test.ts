import { describe, expect, it } from "vitest";
import { assignDemand } from "../src/assignment";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
import { assignDiagramCapacity } from "../src/diagram-capacity";
import { stationBoardingChart } from "../src/diagram-train-chart";
import { assignmentTransfers } from "../src/diagram-transfers";
import { serviceDay } from "../src/line-demand";
import type { Train } from "../src/model";
import { buildRoutingIndex } from "../src/routing";
import { sampleProject } from "../src/sample";

const at = (hour: number, minute = 0) => hour * 3600 + minute * 60;
function setup() {
  const project = sampleProject();
  const dia = project.timetables[0];
  const datasetId = project.datasetId!;
  const config = {
    ...defaultAssignmentConfig(),
    ...serviceDay(project),
    maxTransfers: 0,
  };
  const train = (id: string, stops: Train["stops"]): Train => ({
    ...dia.trains[0],
    id,
    number: id,
    capacity: 100,
    stops,
  });
  const demand = (
    origin: string,
    destination: string,
    start: number,
    end: number,
    passengers: number,
  ): AssignmentDemand => ({
    datasetId,
    origin,
    destination,
    start,
    end,
    passengers,
    purpose: "private",
    source: "manual",
    kind: "outbound",
  });
  const index = () =>
    buildRoutingIndex([{ project, datasetId, timetableId: dia.id }], [], {
      includeBoundaryBoards: true,
    });
  return { dia, config, train, demand, index };
}

describe("乗車上限", () => {
  it("limits boarding at 150% of vehicle capacity, frees space after alighting and rolls excess onto the next train", () => {
    const { dia, config, train, demand, index } = setup();
    dia.trains = [
      train("先発", [
        { stationId: "s0", status: "stop", departure: at(8, 10) },
        {
          stationId: "s2",
          status: "stop",
          arrival: at(8, 20),
          departure: at(8, 22),
        },
        { stationId: "s4", status: "stop", arrival: at(8, 35) },
      ]),
      train("後続", [
        { stationId: "s0", status: "stop", departure: at(8, 40) },
        { stationId: "s4", status: "stop", arrival: at(9, 5) },
      ]),
      train("後発速達", [
        { stationId: "s0", status: "stop", departure: at(8, 45) },
        { stationId: "s4", status: "stop", arrival: at(9) },
      ]),
    ];
    const result = assignDiagramCapacity(
      index(),
      [
        demand("s0", "s2", at(8), at(8, 5), 80),
        demand("s0", "s4", at(8), at(8, 5), 120),
        demand("s2", "s4", at(8, 12), at(8, 16), 60),
      ],
      config,
      150,
    );
    expect(result.loads.map((l) => l.segmentLoads)).toEqual([
      [150, 130],
      [50],
      [0],
    ]);
    expect(result.loads.map((l) => l.peakOccupancy)).toEqual([1.5, 0.5, 0]);
    expect(result.totals).toMatchObject({ assigned: 260, unassigned: 0 });
    expect(result.diagnostics.boardingLimit).toMatchObject({
      percent: 150,
      denied: 50,
      waiting: 0,
    });
  });

  it("reports arrivals in the hour actually used after waiting and preserves residual demand", () => {
    const { dia, config, train, demand, index } = setup();
    dia.trains = [11, 12].map((hour) =>
      train(String(hour), [
        { stationId: "s0", status: "stop", departure: at(hour) },
        { stationId: "s4", status: "stop", arrival: at(hour, 30) },
      ]),
    );
    const rows = [
      {
        ...demand("s0", "s4", at(11), at(12), 200),
        arrivalDirection: "down" as const,
      },
    ];
    const shares = Array<number>(24).fill(0);
    shares[11] = 100;
    const result = assignDiagramCapacity(index(), rows, config, 80, undefined, {
      up: shares,
      down: shares,
    });
    expect(result.loads.map((l) => l.segmentLoads[0])).toEqual([80, 80]);
    expect(result.diagnostics.hourlyArrivals?.down[11]).toBe(80);
    expect(result.diagnostics.hourlyArrivals?.down[12]).toBe(80);
    expect(result.diagnostics.boardingLimit).toMatchObject({
      denied: 120,
      waiting: 40,
    });
    expect(result.totals).toMatchObject({ assigned: 160, unassigned: 40 });
  });

  it("counts transfers on the trains passengers boarded after waiting", () => {
    const { dia, config, train, demand, index } = setup();
    dia.trains = [
      {
        ...train("接続元", [
          { stationId: "s0", status: "stop", departure: at(8, 10) },
          { stationId: "s2", status: "stop", arrival: at(8, 20) },
        ]),
        capacity: 200,
      },
      ...[25, 35].map((minute) => ({
        ...train(String(minute), [
          { stationId: "s2", status: "stop", departure: at(8, minute) },
          { stationId: "s4", status: "stop", arrival: at(8, minute + 12) },
        ]),
        capacity: minute === 25 ? 60 : 50,
      })),
    ];
    const rows = [
      demand("s0", "s4", at(8), at(8, 5), 155),
      demand("s2", "s4", at(8), at(8, 5), 10),
    ];
    const options = { ...config, maxTransfers: 1 };
    const routing = index();
    const unlimited = assignDemand(routing, rows, options);
    const [incoming, first, later] = unlimited.loads;
    expect(assignmentTransfers(unlimited)).toEqual({
      [incoming.key]: { 1: { fromConnection: 0, toConnection: 155 } },
      [first.key]: { 0: { fromConnection: 155, toConnection: 0 } },
    });

    const limited = assignDiagramCapacity(routing, rows, options, 100);
    expect(limited.diagnostics.boardingLimit?.waiting).toBe(55);
    expect(limited.loads.map((l) => l.totalBoardings)).toEqual([155, 60, 50]);
    expect(limited.transfers).toEqual({
      [incoming.key]: { 1: { fromConnection: 0, toConnection: 100 } },
      [first.key]: { 0: { fromConnection: 50, toConnection: 0 } },
      [later.key]: { 0: { fromConnection: 50, toConnection: 0 } },
    });
    const boarded = stationBoardingChart(
      limited.loads[1],
      (id) => id,
      limited.transfers?.[first.key],
    );
    expect(boarded).toContain("s2 乗車・その他 10人（計 60人）");
    expect(boarded).toContain("s2 乗車・接続列車から 50人（計 60人）");
    const alighted = stationBoardingChart(
      limited.loads[0],
      (id) => id,
      limited.transfers?.[incoming.key],
    );
    expect(alighted).toContain("s2 降車・その他 55人（計 155人）");
    expect(alighted).toContain("s2 降車・接続列車へ 100人（計 155人）");
  });

  it("uses the recorded boundary time on an explicitly selected through service", () => {
    const { dia, config, train, demand, index } = setup();
    dia.trains = [
      train("直通1", [
        { stationId: "s0", status: "pass", arrival: at(8, 10) },
        { stationId: "s4", status: "pass", departure: at(8, 20) },
      ]),
      train("直通2", [
        { stationId: "s0", status: "pass", arrival: at(8, 30) },
        { stationId: "s4", status: "pass", departure: at(8, 40) },
      ]),
    ];
    const names = dia.trains.map((t) => t.id);
    const result = assignDiagramCapacity(
      index(),
      [
        {
          ...demand("s0", "s4", at(8), at(8, 5), 150),
          boundaryOriginTrains: names,
          boundaryDestinationTrains: names,
        },
      ],
      config,
      100,
    );
    expect(result.loads.map((l) => l.segmentLoads[0])).toEqual([100, 50]);
    expect(result.totals.assigned).toBe(150);
  });

  it("requires registered transport capacity for a constrained calculation", () => {
    const { dia, config, train, demand, index } = setup();
    dia.trains = [
      {
        ...train("列車1", [
          { stationId: "s0", status: "stop", departure: at(11) },
          { stationId: "s4", status: "stop", arrival: at(11, 30) },
        ]),
        capacity: undefined,
      },
    ];
    expect(() =>
      assignDiagramCapacity(
        index(),
        [demand("s0", "s4", at(10), at(11), 10)],
        config,
        100,
      ),
    ).toThrow("輸送定員が未登録の営業列車が1本");
  });
});
