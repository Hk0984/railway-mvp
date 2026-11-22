import { describe, expect, it } from "vitest";
import { assignDemand } from "../src/assignment";
import { defaultAssignmentConfig } from "../src/assignment-model";
import { trainInterior } from "../src/diagram-interior";
import {
  crowdingBand,
  crowdingLimits,
  diagramTrains,
} from "../src/diagram-model";
import { buildRoutingIndex } from "../src/routing";
import { sampleProject } from "../src/sample";
import { parseOud2 } from "../src/oud2";
import { readFileSync } from "node:fs";

describe("列車ダイヤ図", () => {
  it("draws one dot per estimated passenger in the displayed quarter car", () => {
    expect(trainInterior(null, 800, 8)).toBe("");
    expect(trainInterior(80, null, 8)).toBe("");
    expect(trainInterior(80, 800)).toContain("編成両数を登録");
    expect(trainInterior(0, 800, 8)).toContain("推定0人、着席0人、立席0人");
    expect(trainInterior(229.7, 800, 8)).toContain("推定7人、着席7人、立席0人");
    expect(trainInterior(229.7, 800, 4)).toContain(
      "推定14人、着席14人、立席0人",
    );
    const crowded = trainInterior(1840, 800, 8);
    expect(crowded).toContain("推定58人、着席10人、立席48人");
    expect(crowded.match(/<circle/g)).toHaveLength(58);
    expect(crowded).toContain("1両あたり平均 230人");
    const veryCrowded = trainInterior(3280, 800, 8);
    expect(veryCrowded).toContain("推定103人、着席10人、立席93人");
    expect(veryCrowded.match(/<circle/g)).toHaveLength(103);
  });

  it("places standing passengers near the doors first and spreads toward the aisle center", () => {
    const standingPositions = (passengers: number) => {
      const svg = trainInterior(passengers, 800, 8);
      const standing = svg.match(
        /class="diagram-interior-standing">(.*?)<\/g>/,
      )![1];
      return Array.from(
        standing.matchAll(/cx="([\d.]+)" cy="([\d.]+)"/g),
        ([, x, y]) => ({
          x: Number(x),
          y: Number(y),
        }),
      );
    };
    const byDoor = ({ x }: { x: number }) =>
      Math.min(Math.abs(x - 81), Math.abs(x - 359)) <= 48;
    const light = standingPositions(448);
    expect(light).toHaveLength(4);
    expect(
      light.every((point) => byDoor(point) && Math.abs(point.y - 102) > 35),
    ).toBe(true);
    expect(light.filter(({ x }) => x < 220)).toHaveLength(2);

    const crowded = standingPositions(3520);
    expect(crowded).toHaveLength(100);
    expect(crowded.some(({ x }) => x > 180 && x < 260)).toBe(true);
    expect(crowded.filter(byDoor).length).toBeGreaterThan(crowded.length / 2);
  });

  it("includes threshold endpoints and never assigns a band to missing values", () => {
    expect(
      [
        0,
        39.99,
        40,
        100,
        100.01,
        130,
        130.01,
        160,
        160.01,
        200,
        200.01,
        null,
        NaN,
        -1,
      ].map((v) => crowdingBand(v, crowdingLimits)),
    ).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, -1, -1, -1]);
    expect(crowdingBand(100, [90, 130, 160, 200])).toBe(2);
  });

  it("uses assignment loads after departures, including passes, and leaves dwell and excluded segments uncolored", () => {
    const p = sampleProject();
    const train = p.timetables[0].trains[0];
    train.capacity = 100;
    train.stops = [
      { stationId: "s0", status: "none" },
      { stationId: "s1", status: "stop", departure: 100 },
      {
        stationId: "s2",
        status: "stop",
        arrival: 200,
        departure: 220,
        track: "2",
      },
      { stationId: "s3", status: "pass", departure: 270 },
      { stationId: "s4", status: "stop", arrival: 400 },
    ];
    p.timetables[0].trains = [train];
    const diaId = p.timetables[0].id;
    const datasetId = p.datasetId!;
    const index = buildRoutingIndex([
      { datasetId, project: p, timetableId: diaId },
    ]);
    const result = assignDemand(
      index,
      [
        {
          datasetId,
          origin: "s1",
          destination: "s4",
          passengers: 65,
          purpose: "commute",
          kind: "outbound",
          source: "manual",
          start: 0,
          end: 60,
        },
        {
          datasetId,
          origin: "s2",
          destination: "s4",
          passengers: 50,
          purpose: "commute",
          kind: "outbound",
          source: "manual",
          start: 0,
          end: 60,
        },
      ],
      { ...defaultAssignmentConfig(), start: 0, end: 60 },
    );
    const lines = diagramTrains(p, diaId, result)[0].segments;
    expect(
      lines.map((s) => [
        s.from.stationId,
        s.to.stationId,
        s.kind,
        s.start,
        s.end,
      ]),
    ).toEqual([
      ["s1", "s2", "run", 100, 200],
      ["s2", "s2", "dwell", 200, 220],
      ["s2", "s3", "run", 220, 270],
      ["s3", "s4", "run", 270, 400],
    ]);
    expect(lines.map((s) => s.passengers)).toEqual([65, null, 115, 115]);
    expect(lines.map((s) => crowdingBand(s.percent, crowdingLimits))).toEqual([
      1, -1, 2, 2,
    ]);
    expect(
      diagramTrains(p, diaId)[0].segments.every((s) => s.percent === null),
    ).toBe(true);
    result.loads[0].segmentObserved = [true, false, false];
    expect(
      diagramTrains(p, diaId, result)[0]
        .segments.slice(1)
        .every((s) => s.passengers === null),
    ).toBe(true);
    result.loads[0].segmentObserved[1] = true;
    result.loads[0].occupancies[1] = null;
    const missingCapacity = diagramTrains(p, diaId, result)[0].segments[2];
    expect([missingCapacity.passengers, missingCapacity.percent]).toEqual([
      115,
      null,
    ]);

    delete train.stops[3].departure;
    expect(diagramTrains(p, diaId, result)[0].segments.at(-1)).toMatchObject({
      kind: "run",
      percent: null,
    });
  });

  it("carries measured loads across untimed passes without treating a missing stop time as a pass", () => {
    const p = sampleProject();
    const dia = p.timetables[0];
    const train = dia.trains[0];
    train.capacity = 160;
    train.stops = [
      { stationId: "s0", status: "stop", departure: 120 },
      { stationId: "s1", status: "pass" },
      { stationId: "s2", status: "pass" },
      { stationId: "s3", status: "pass", departure: 290 },
      { stationId: "s4", status: "stop", arrival: 420 },
    ];
    dia.trains = [train];
    const datasetId = p.datasetId!;
    const index = buildRoutingIndex([
      { datasetId, project: p, timetableId: dia.id },
    ]);
    const config = { ...defaultAssignmentConfig(), start: 0, end: 90 };
    const rows = [
      {
        datasetId,
        origin: "s0",
        destination: "s4",
        passengers: 120,
        purpose: "commute",
        kind: "outbound",
        source: "manual",
        start: 0,
        end: 90,
      },
      {
        datasetId,
        origin: "s3",
        destination: "s4",
        passengers: 10,
        purpose: "commute",
        kind: "outbound",
        source: "manual",
        start: 0,
        end: 90,
      },
    ] as const;
    for (const capacityConstrained of [false, true]) {
      const result = assignDemand(index, [...rows], {
        ...config,
        capacityConstrained,
      });
      expect(result.totals.assigned).toBe(120);
      expect(result.totals.unassigned).toBe(10);
      const [stretch, afterTimedPass] = diagramTrains(p, dia.id, result)[0]
        .segments;
      expect(stretch).toMatchObject({
        from: { stationId: "s0" },
        to: { stationId: "s3" },
        start: 120,
        end: 290,
        kind: "run",
        passengers: 120,
        percent: 75,
      });
      expect(
        stretch.untimedPasses?.map((s) => [
          s.stationId,
          s.arrival,
          s.departure,
        ]),
      ).toEqual([
        ["s1", undefined, undefined],
        ["s2", undefined, undefined],
      ]);
      expect(afterTimedPass).toMatchObject({
        from: { stationId: "s3" },
        to: { stationId: "s4" },
        start: 290,
        end: 420,
        kind: "run",
        passengers: 120,
        percent: 75,
      });
      expect(afterTimedPass.untimedPasses).toBeUndefined();
    }

    train.stops[2].status = "stop";
    const revised = buildRoutingIndex([
      { datasetId, project: p, timetableId: dia.id },
    ]);
    const result = assignDemand(revised, [...rows], config);
    expect(diagramTrains(p, dia.id, result)[0].segments[0]).toMatchObject({
      kind: "gap",
      passengers: null,
      percent: null,
    });
  });

  it("preserves imported reverse direction and explicit after-midnight times", () => {
    const { project } = parseOud2(
      readFileSync("public/samples/basic-1.07.oud2", "utf8"),
    );
    const [service] = diagramTrains(project, "oud-dia1");
    expect(service.train.number).toBe("201");
    expect(service.segments[0]).toMatchObject({
      start: 23 * 3600 + 50 * 60,
      end: 24 * 3600 + 10 * 60,
      percent: null,
      from: { stationId: "oud-s1" },
      to: { stationId: "oud-s0" },
    });
    project.datasetId = "oud-diagram-test";
    project.serviceClasses = {
      types: {
        [service.train.typeId]: { state: "passenger", basis: "検証用設定" },
      },
      trains: {},
    };
    service.train.capacity = 100;
    const datasetId = project.datasetId;
    const timetableId = "oud-dia1";
    const start = 23 * 3600 + 30 * 60;
    const end = start + 900;
    const index = buildRoutingIndex([{ datasetId, project, timetableId }]);
    const result = assignDemand(
      index,
      [
        {
          datasetId,
          origin: "oud-s1",
          destination: "oud-s0",
          passengers: 158,
          purpose: "commute",
          kind: "outbound",
          start,
          end,
          source: "manual",
        },
      ],
      { ...defaultAssignmentConfig(), start, end },
    );
    const segment = diagramTrains(project, timetableId, result)[0].segments[0];
    expect(segment.passengers).toBe(158);
    expect(crowdingBand(segment.percent, crowdingLimits)).toBe(3);
  });

  it("merges explicit branch aliases without merging a later visit during a reversal", () => {
    const p = sampleProject();
    const t = p.timetables[0].trains[0];
    t.stops = [
      { stationId: "s1", positionId: "branch", status: "stop", arrival: 100 },
      { stationId: "s1", positionId: "core", status: "stop", departure: 120 },
      { stationId: "s2", status: "stop", arrival: 180, departure: 200 },
      { stationId: "s1", positionId: "return", status: "stop", arrival: 300 },
    ];
    p.timetables[0].trains = [t, { ...t, id: "cancelled", cancelled: true }];
    const services = diagramTrains(p, p.timetables[0].id);
    expect(services).toHaveLength(1);
    expect(services[0].visits.map((s) => s.stationId)).toEqual([
      "s1",
      "s2",
      "s1",
    ]);
    expect(services[0].segments.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["dwell", 100, 120],
      ["run", 120, 180],
      ["dwell", 180, 200],
      ["run", 200, 300],
    ]);
  });
});
