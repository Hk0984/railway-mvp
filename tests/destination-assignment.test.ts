import { expect, it } from "vitest";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
import { assignDiagramCapacity } from "../src/diagram-capacity";
import { assignDestinationArrivals } from "../src/destination-assignment";
import {
  demandMass,
  demandRate,
  hourlyDemandCurve,
} from "../src/hourly-demand-curve";
import {
  arrivalHourIndex,
  arrivalHours,
  defaultLineDemand,
  defaultLineTransferSeconds,
  estimateLineDemand,
  initialArrivalShares,
  serviceDay,
} from "../src/line-demand";
import { buildRoutingIndex } from "../src/routing";
import { sampleProject } from "../src/sample";
import type { Direction, Train } from "../src/model";

const at = (hours: number, minutes = 0) => hours * 3600 + minutes * 60;

function continuationExample(
  throughArrival: number,
  includeEarlierLocal = false,
) {
  const project = sampleProject();
  const dia = project.timetables[0];
  const [first, second] = dia.trains;
  dia.trains = [
    {
      ...first,
      id: "through",
      stops: [
        { stationId: "s0", status: "stop", departure: at(8) },
        {
          stationId: "s2",
          status: "stop",
          arrival: at(8, 10),
          departure: at(8, 11),
        },
        { stationId: "s4", status: "stop", arrival: throughArrival },
      ],
    },
    {
      ...second,
      id: "local",
      stops: [
        ...(includeEarlierLocal
          ? [{ stationId: "s0", status: "stop" as const, departure: at(7, 55) }]
          : []),
        {
          stationId: "s2",
          status: "stop",
          arrival: at(8, 12),
          departure: at(8, 13),
        },
        { stationId: "s4", status: "stop", arrival: at(8, 30) },
      ],
    },
  ];
  const row: AssignmentDemand = {
    datasetId: project.datasetId!,
    start: at(8),
    end: at(9),
    arrivalDirection: "down",
    origin: "s0",
    destination: "s4",
    passengers: 60,
    purpose: "commute",
    source: "manual",
    kind: "outbound",
  };
  const index = buildRoutingIndex([
    { datasetId: row.datasetId, project, timetableId: dia.id },
  ]);
  return {
    project,
    index,
    row,
    config: { ...defaultAssignmentConfig(), ...serviceDay(project) },
  };
}

it.each([22, 32])(
  "keeps the first train at an 08:%i through arrival, including with a boarding limit",
  (minute) => {
    const { index, config, row } = continuationExample(at(8, minute));
    for (const result of [
      assignDestinationArrivals(index, [row], config),
      assignDiagramCapacity(index, [row], config, 100),
    ]) {
      expect(result.totals).toMatchObject({
        assigned: 60,
        unassigned: 0,
        boardingEvents: 60,
      });
      expect(result.loads.map((load) => load.totalBoardings)).toEqual([60, 0]);
      expect(result.diagnostics.hourlyArrivals?.down[8]).toBe(60);
    }
  },
);

it("keeps a direct local candidate after rejecting a needless transfer to it", () => {
  const { index, config, row } = continuationExample(at(8, 22), true);
  const result = assignDestinationArrivals(index, [row], config);
  expect(result.loads[0].totalBoardings).toBeCloseTo(29.25);
  expect(result.loads[1].totalBoardings).toBeCloseTo(30.75);
  expect(result.totals).toMatchObject({
    assigned: 60,
    unassigned: 0,
    boardingEvents: 60,
  });
});

it("finds an earlier feeder that needs the transfer after rejecting a needless transfer to the same local", () => {
  const { project, config, row } = continuationExample(at(8, 22));
  const dia = project.timetables[0];
  dia.trains.push({
    ...dia.trains[0],
    id: "feeder",
    stops: [
      { stationId: "s0", status: "stop", departure: at(7, 56) },
      { stationId: "s2", status: "stop", arrival: at(8, 10) },
    ],
  });
  const index = buildRoutingIndex([
    { datasetId: row.datasetId, project, timetableId: dia.id },
  ]);
  const result = assignDestinationArrivals(index, [row], config);
  expect(result.loads.map((load) => load.totalBoardings)).toEqual([
    29.75, 30.25, 30.25,
  ]);
  expect(result.totals).toMatchObject({ assigned: 60, unassigned: 0 });
});

it("permits a three-minute saving or a transfer needed to reach the requested window", () => {
  const { index, config, row } = continuationExample(at(8, 33));
  const saving = assignDestinationArrivals(
    index,
    [{ ...row, end: at(8, 32) }],
    config,
  );
  expect(saving.loads.map((load) => load.totalBoardings)).toEqual([60, 60]);
  const bothAvailable = assignDestinationArrivals(index, [row], config);
  expect(bothAvailable.loads.map((load) => load.totalBoardings)).toEqual([
    60, 60,
  ]);
  const laterWindow = assignDestinationArrivals(
    index,
    [{ ...row, start: at(8, 31) }],
    config,
  );
  expect(laterWindow.loads.map((load) => load.totalBoardings)).toEqual([60, 0]);
  const earlier = continuationExample(at(8, 22));
  const desired = assignDestinationArrivals(
    earlier.index,
    [{ ...earlier.row, start: at(8, 28), end: at(8, 31) }],
    earlier.config,
  );
  expect(desired.totals).toMatchObject({
    assigned: 60,
    unassigned: 0,
    boardingEvents: 120,
  });
});

it("uses the exact minimum connection time when both routes reach the requested hour", () => {
  const { project, config, row } = continuationExample(at(8, 45));
  const dia = project.timetables[0];
  const transferStop = dia.trains[1].stops[0];
  transferStop.arrival = at(8, 10);
  transferStop.departure = at(8, 11);
  const index = buildRoutingIndex([
    { datasetId: row.datasetId, project, timetableId: dia.id },
  ]);
  for (const seconds of [
    defaultLineTransferSeconds,
    defaultLineTransferSeconds + 1,
  ]) {
    const result = assignDestinationArrivals(index, [row], {
      ...config,
      minimumTransferSeconds: seconds,
    });
    expect(result.loads.map((load) => load.totalBoardings)).toEqual([
      60,
      seconds === 60 ? 60 : 0,
    ]);
  }
});

it("honors directional arrival hours, an exact hour boundary, and a transfer across midnight", () => {
  const project = sampleProject();
  const dia = project.timetables[0];
  const train = (
    id: string,
    direction: Direction,
    from: string,
    departure: number,
    to: string,
    arrival: number,
  ): Train => ({
    id,
    number: id,
    direction,
    typeId: "local",
    capacity: 100,
    stops: [
      { stationId: from, status: "stop", departure },
      { stationId: to, status: "stop", arrival },
    ],
  });
  dia.trains = [
    train("down-on-hour", "down", "s0", at(10, 40), "s4", at(11)),
    train("down-next-hour", "down", "s0", at(11, 40), "s4", at(12)),
    train("up-first", "up", "s4", at(23, 15), "s2", at(23, 45)),
    train("up-second", "up", "s2", at(23, 50), "s0", at(24, 10)),
  ];
  const d = (project.lineDemand = defaultLineDemand());
  d.counts = {
    s0: { board: 120, alight: 80, weight: 1 },
    s4: { board: 80, alight: 120, weight: 1 },
  };
  const shares = {
    up: Array<number>(24).fill(0),
    down: Array<number>(24).fill(0),
  };
  shares.up[0] = 100;
  shares.down[11] = 75;
  shares.down[13] = 25;
  d.destinationArrival = { enabled: true, shares };

  const plan = estimateLineDemand(project, dia.id);
  expect(plan.byArrival?.up[0]).toBe(80);
  expect(plan.byArrival?.down[11]).toBe(90);
  expect(plan.byArrival?.down[13]).toBe(30);
  expect(arrivalHours(project).find((h) => h.index === 0)?.label).toBe(
    "24:00–25:00",
  );

  const index = buildRoutingIndex([
    { datasetId: project.datasetId!, project, timetableId: dia.id },
  ]);
  const result = assignDestinationArrivals(index, plan.rows, {
    ...defaultAssignmentConfig(),
    ...serviceDay(project),
  });
  expect(result.totals).toMatchObject({
    assigned: 170,
    unassigned: 30,
    boardingEvents: 250,
  });
  expect(result.loads.map((load) => load.segmentLoads[0])).toEqual([
    90, 0, 80, 80,
  ]);
  const [direct, , incoming, outgoing] = result.loads;
  expect(result.transfers?.[direct.key]).toBeUndefined();
  expect(result.transfers?.[incoming.key]).toEqual({
    1: { fromConnection: 0, toConnection: 80 },
  });
  expect(result.transfers?.[outgoing.key]).toEqual({
    0: { fromConnection: 80, toConnection: 0 },
  });
  expect(result.diagnostics.hourlyArrivals?.up[0]).toBe(80);
  expect(result.diagnostics.hourlyArrivals?.down[11]).toBe(90);
  expect(result.diagnostics.hourlyArrivals?.down[12]).toBe(0);
  expect(result.diagnostics.hourlyArrivals?.down[13]).toBe(0);
  expect(arrivalHourIndex(at(24, 10))).toBe(0);
});

it("assigns the whole hour to timed arrivals and divides multiple arrivals at their midpoint", () => {
  const project = sampleProject();
  const dia = project.timetables[0];
  const first = dia.trains[0];
  dia.trains = [10, 40].map((minute, i) => ({
    ...first,
    id: "train" + i,
    stops: [
      { stationId: "s0", status: "stop", departure: at(10, 40) + minute * 60 },
      { stationId: "s4", status: "stop", arrival: at(11, minute) },
    ],
  }));
  const index = buildRoutingIndex([
    { datasetId: project.datasetId!, project, timetableId: dia.id },
  ]);
  const rows = [
    {
      datasetId: project.datasetId!,
      start: at(11),
      end: at(12),
      arrivalDirection: "down",
      origin: "s0",
      destination: "s4",
      passengers: 120,
      purpose: "private",
      source: "manual",
      kind: "outbound",
    },
  ] as const;
  const config = { ...defaultAssignmentConfig(), ...serviceDay(project) };
  const result = assignDestinationArrivals(index, [...rows], config);
  expect(result.loads.map(({ segmentLoads }) => segmentLoads[0])).toEqual([
    50, 70,
  ]);
  expect(result.totals.unassigned).toBe(0);
  const shares = Array<number>(24).fill(0);
  shares[11] = 100;
  const smoothed = assignDestinationArrivals(
    index,
    [...rows],
    config,
    undefined,
    { up: shares, down: shares },
  );
  expect(smoothed.loads[0].segmentLoads[0]).toBeCloseTo(43.3333333333);
  expect(smoothed.loads[1].segmentLoads[0]).toBeCloseTo(76.6666666667);
  expect(smoothed.diagnostics.hourlyArrivals?.down[11]).toBeCloseTo(120);
  expect(smoothed.totals.unassigned).toBe(0);
});

it("validates each direction independently and provides hourly defaults totaling 100%", () => {
  const project = sampleProject();
  const d = (project.lineDemand = defaultLineDemand());
  const initial = initialArrivalShares(d.shares.local);
  expect(initial.reduce((sum, portion) => sum + portion, 0)).toBeCloseTo(100);
  const down = [...initial];
  down[11] += 1;
  d.destinationArrival = { enabled: true, shares: { up: initial, down } };
  expect(() => estimateLineDemand(project, "weekday")).toThrow(
    "下りの目的地到着割合を合計100%",
  );
});

it("smooths across hour boundaries without changing each hour's area or adding demand to a zero hour", () => {
  const shares = [10, 30, 0, 20];
  const curves = hourlyDemandCurve(shares, true);
  for (const [i, curve] of curves.entries()) {
    expect(demandRate(curve, 1)).toBe(
      demandRate(curves[(i + 1) % curves.length], 0),
    );
    const parts = Array.from({ length: 4 }, (_, j) =>
      demandMass(curve, at(i, j * 15), at(i, (j + 1) * 15)),
    );
    expect(parts.every((v) => v >= 0)).toBe(true);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(shares[i], 10);
  }
  expect(demandRate(curves[2], 0.5)).toBe(0);
});

it("joins hours with a single rise or fall, including equal-hour values and midnight", () => {
  for (const shares of [
    [4, 12, 20, 30, 13, 7],
    [5, 25, 25, 5],
    [0.5, 30, 0, 0.01, 50, 0.4],
  ]) {
    const curves = hourlyDemandCurve(shares, true);
    for (const [i, curve] of curves.entries()) {
      const next = curves[(i + 1) % curves.length];
      const rates = [
        ...[0.9, 0.95, 0.99, 1].map((t) => demandRate(curve, t)),
        ...[0, 0.01, 0.05, 0.1].map((t) => demandRate(next, t)),
      ];
      const direction = Math.sign(rates.at(-1)! - rates[0]);
      expect(rates.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
      expect(rates[3]).toBeCloseTo(rates[4], 12);
      for (const [j, rate] of rates.slice(1).entries()) {
        if (direction === 0) expect(rate).toBeCloseTo(rates[0], 10);
        else
          expect((rate - rates[j]) * direction).toBeGreaterThanOrEqual(-1e-10);
      }

      // Simpson's rule integrates each cubic segment of the plotted rate exactly.
      const boundaries = [
        0,
        curve.opening?.width ?? 0,
        1 - (curve.closing?.width ?? 0),
        1,
      ];
      const area = boundaries.slice(1).reduce((sum, end, j) => {
        const start = boundaries[j];
        return (
          sum +
          ((end - start) *
            (demandRate(curve, start) +
              4 * demandRate(curve, (start + end) / 2) +
              demandRate(curve, end))) /
            6
        );
      }, 0);
      expect(area).toBeCloseTo(shares[i], 10);
    }
  }
});

it("uses the smoothed curve for an arrival hour split by the service day boundary", () => {
  const project = sampleProject();
  project.oud2 = {
    fileType: "OuDiaSecond.1.07",
    serviceDayStart: at(4, 15),
    positions: [],
    links: [],
    externalTerminals: [],
    emptyColumns: 0,
    warnings: [],
  };
  const demand = (project.lineDemand = defaultLineDemand(true));
  const shares = Array<number>(24).fill(0);
  shares[4] = 100;
  demand.destinationArrival = {
    enabled: true,
    smooth: true,
    shares: { up: shares, down: shares },
  };
  const plan = estimateLineDemand(project, "weekday");
  const tail = plan.rows
    .filter((row) => row.start === at(28))
    .reduce((sum, row) => sum + row.passengers, 0);
  const total = plan.rows.reduce((sum, row) => sum + row.passengers, 0);
  expect(tail / total).toBeCloseTo(0.1118977864583);
  expect(total).toBeCloseTo(90000);
});
