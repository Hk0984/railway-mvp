import { expect, it } from "vitest";
import { defaultAssignmentConfig } from "../src/assignment-model";
import { assignDestinationArrivals } from "../src/destination-assignment";
import {
  arrivalHourIndex,
  arrivalHours,
  defaultLineDemand,
  estimateLineDemand,
  initialArrivalShares,
  serviceDay,
} from "../src/line-demand";
import { buildRoutingIndex } from "../src/routing";
import { sampleProject } from "../src/sample";
import type { Direction, Train } from "../src/model";

const at = (hours: number, minutes = 0) => hours * 3600 + minutes * 60;

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
  const result = assignDestinationArrivals(
    index,
    [
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
    ],
    { ...defaultAssignmentConfig(), ...serviceDay(project) },
  );
  expect(result.loads.map(({ segmentLoads }) => segmentLoads[0])).toEqual([
    50, 70,
  ]);
  expect(result.totals.unassigned).toBe(0);
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
