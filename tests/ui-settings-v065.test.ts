import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import {
  operationNumbers,
  operationGroup,
  operationPattern,
} from "../src/operation-numbers";
import {
  capacityForTrain,
  capacitySpec,
  trainCarCount,
  transportCapacity,
} from "../src/capacity-model";
import { validateProject } from "../src/model";
import { buildRoutingIndex, searchJourneys } from "../src/routing";
import { legPresentation, platformName } from "../src/route-presentation";
import { assignDemand } from "../src/assignment";
import { defaultAssignmentConfig } from "../src/assignment-model";
import { readFileSync, existsSync } from "node:fs";
import { parseOud2 } from "../src/oud2";
it.skipIf(!existsSync(new URL("./fixtures/real/琴町線.oud2", import.meta.url)))(
  "uses only explicit operation letters in the actual rail fixture and leaves source operations intact",
  () => {
    const p = parseOud2(
        readFileSync(
          new URL("./fixtures/real/琴町線.oud2", import.meta.url),
          "utf8",
        ),
      ).project,
      before = JSON.stringify(p.timetables),
      trains = p.timetables.flatMap((d) => d.trains),
      groups = new Set(trains.flatMap((t) => operationGroup(p, t).group ?? []));
    expect(groups.has("**C")).toBe(true);
    expect(groups.has("**D")).toBe(true);
    p.capacitySettings = {
      trains: {},
      types: {},
      timetables: {},
      formationSource: "operation",
      operationGroups: {
        "**C": { value: 240, kind: "transport", basis: "試験用の仮定" },
      },
    };
    const d = p.timetables.find((d) =>
        d.trains.some((t) => operationGroup(p, t).group === "**C"),
      )!,
      t = d.trains.find((t) => operationGroup(p, t).group === "**C")!;
    expect(transportCapacity(p, d.id, t.id)).toBe(240);
    expect(JSON.stringify(p.timetables)).toBe(before);
    validateProject(JSON.parse(JSON.stringify(p)));
  },
);
function fixture() {
  const p = sampleProject();
  p.timetables[0].trains = [
    {
      id: "t",
      number: "123",
      typeId: "local",
      direction: "down",
      operations: [
        { positionId: "p0", phase: "before", code: 3, raw: "3/0700$LINK/01C" },
      ],
      stops: [
        {
          stationId: "s0",
          positionId: "p0",
          status: "stop",
          departure: 25200,
          track: "0",
        },
        { stationId: "s1", positionId: "p1", status: "pass", departure: 25500 },
        {
          stationId: "s2",
          positionId: "p2",
          status: "stop",
          arrival: 25800,
          departure: 25860,
          track: "1",
        },
        {
          stationId: "s4",
          positionId: "p4",
          status: "stop",
          arrival: 26400,
          track: "0",
        },
      ],
    },
  ];
  p.oud2 = {
    fileType: "OuDiaSecond.1.17",
    serviceDayStart: 0,
    emptyColumns: 0,
    warnings: [],
    links: [],
    externalTerminals: [],
    positions: p.stations.map((s, i) => ({
      id: "p" + i,
      stationId: s.id,
      name: s.name,
      tracks: ["3番線", "7番線"],
      outerTerminalIds: [],
    })),
  };
  p.typeCapacities = { local: 200 };
  p.capacitySettings = {
    trains: {},
    types: {},
    timetables: {},
    operationGroups: {
      C: { value: 120, kind: "transport", basis: "利用者設定" },
    },
  };
  return p;
}
function leg(p: ReturnType<typeof fixture>) {
  return searchJourneys(
    buildRoutingIndex([
      { project: p, datasetId: p.datasetId!, timetableId: "weekday" },
    ]),
    {
      origin: { datasetId: p.datasetId!, stationId: "s0" },
      destination: { datasetId: p.datasetId!, stationId: "s2" },
      mode: "depart",
      time: 25000,
      sort: "arrival",
      maxTransfers: 0,
      minimumTransferSeconds: 120,
      directOnly: true,
    },
  ).journeys[0].legs[0];
}
it("extracts the operation number rather than the linkage code for 1.17", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  expect(operationNumbers(p, t)).toEqual(["01C"]);
  expect(operationGroup(p, t).group).toBe("**C");
  expect(transportCapacity(p, "weekday", "t")).toBe(120);
});
it("accepts legacy operation syntax and manual explicit operation numbers", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  p.oud2!.fileType = "OuDiaSecond.1.07";
  t.operations![0].raw = "3/0700$15D";
  expect(operationGroup(p, t).group).toBe("**D");
  t.operationNumbers = ["a12"];
  expect(operationGroup(p, t).group).toBe("A**");
});
it.each([
  ["32D", "**D"],
  ["07D", "**D"],
  ["01C", "**C"],
  ["03C", "**C"],
  ["32SH", "**SH"],
  ["16S", "**S"],
  ["43H", "**H"],
  ["39C●", "**C●"],
  ["A01", "A**"],
  ["01A", "**A"],
  ["*01", "\\***"],
  ["01*", "**\\*"],
  ["123", null],
])("groups %s as %s", (number, group) => {
  expect(operationPattern(number)).toBe(group);
});
it("switches formation sources and uses group cars and capacity independently", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  const caps = p.capacitySettings!;
  p.types.find((type) => type.id === t.typeId)!.carCount = 5;
  caps.operationGroups!["**C"] = {
    value: 400,
    kind: "transport",
    basis: "グループ",
    carCount: 8,
  };
  caps.operationGroupCars = { "**C●": 3 };
  caps.formationSource = "type";
  expect(transportCapacity(p, "weekday", t.id)).toBe(200);
  expect(trainCarCount(p, "weekday", t)).toBe(5);
  caps.formationSource = "operation";
  expect(capacityForTrain(p, "weekday", t)).toMatchObject({
    source: "operation",
    spec: { value: 400 },
  });
  expect(trainCarCount(p, "weekday", t)).toBe(8);
  t.capacity = 300;
  expect(capacityForTrain(p, "weekday", t)).toMatchObject({
    source: "train",
    spec: { value: 300 },
  });
  delete t.capacity;
  t.operationNumbers = ["39C●"];
  expect(transportCapacity(p, "weekday", t.id)).toBe(200);
  expect(trainCarCount(p, "weekday", t)).toBe(3);
  const copy = JSON.parse(JSON.stringify(p));
  validateProject(copy);
  expect(trainCarCount(copy, "weekday", copy.timetables[0].trains[0])).toBe(3);
  t.operationNumbers = [];
  expect(transportCapacity(p, "weekday", t.id)).toBe(200);
  expect(trainCarCount(p, "weekday", t)).toBe(5);
});
it("does not inherit operation groups from train numbers or unnumbered record connections", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  t.number = "01C";
  t.operations = [{ positionId: "p0", phase: "before", code: 5, raw: "5/$" }];
  expect(operationNumbers(p, t)).toEqual([]);
  expect(operationGroup(p, t).group).toBeNull();
  expect(transportCapacity(p, "weekday", "t")).toBe(200);
});
it("does not sum or guess a group for multiple units or changed operation numbers", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  t.operations![0].raw = "3/0700$/01C;03C";
  expect(operationGroup(p, t).group).toBeNull();
  t.operations![0].raw = "3/0700$/01C";
  t.operations!.push({
    positionId: "p2",
    phase: "after",
    code: 6,
    raw: "6/02D",
  });
  expect(operationGroup(p, t).group).toBeNull();
});
it("handles explicit temporary and external-origin operation numbers without joining records", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  t.operations = [
    { positionId: "p0", phase: "before", code: 4, raw: "4/0$0650/0700$X/02C" },
  ];
  expect(operationNumbers(p, t)).toEqual(["02C"]);
  t.operations = [
    { positionId: "p0", phase: "before", code: 5, raw: "5/$17D" },
  ];
  expect(operationNumbers(p, t)).toEqual(["17D"]);
});
it("respects per-train capacity overrides and preserves operation settings through JSON", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  t.capacity = 300;
  expect(transportCapacity(p, "weekday", "t")).toBe(300);
  p.capacitySettings!.trains['["weekday","t"]'] = {
    value: 400,
    kind: "transport",
    basis: "個別優先",
  };
  expect(transportCapacity(p, "weekday", "t")).toBe(400);
  const copy = JSON.parse(JSON.stringify(p));
  validateProject(copy);
  expect(capacitySpec(copy, "weekday", "t")!.basis).toBe("個別優先");
});
it("distinguishes seats from transport capacity and validates operation settings", () => {
  const p = fixture();
  p.capacitySettings!.operationGroups!.C.kind = "seats";
  expect(transportCapacity(p, "weekday", "t")).toBeNull();
  p.capacitySettings!.operationGroups!.C.value = -1;
  expect(() => validateProject(p)).toThrow("定員設定");
});
it("uses the actual operation capacity in allocation and exports its source", () => {
  const p = fixture(),
    idx = buildRoutingIndex([
      { project: p, datasetId: p.datasetId!, timetableId: "weekday" },
    ]);
  const r = assignDemand(
    idx,
    [
      {
        datasetId: p.datasetId!,
        origin: "s0",
        destination: "s2",
        purpose: "commute",
        kind: "outbound",
        source: "manual",
        start: 25000,
        end: 25100,
        passengers: 130,
      },
    ],
    { ...defaultAssignmentConfig(), start: 25000, end: 25100, maxTransfers: 0 },
  );
  expect(r.loads[0].capacity).toBe(120);
  expect(r.loads[0].capacitySource).toBe("operation");
});
it("omits passes in presentation while preserving routing data and uses the full-train destination", () => {
  const p = fixture(),
    l = leg(p),
    v = legPresentation(p, l);
  expect(l.stops.some((s) => s.status === "pass")).toBe(true);
  expect(v.stops).toHaveLength(0);
  expect(v.destination).toBe(p.stations[4].name);
  expect(v.departureTrack).toBe("3番線");
  expect(v.arrivalTrack).toBe("7番線");
});
it("shows the formation assigned to the train of each journey leg", () => {
  const p = fixture();
  const journeyLeg = leg(p);
  const caps = p.capacitySettings!;
  caps.formationSource = "operation";
  caps.operationGroupCars = { "**C": 6 };
  expect(legPresentation(p, journeyLeg).carCount).toBe(6);
  caps.trains['["weekday","t"]'] = {
    value: 400,
    kind: "transport",
    basis: "列車別",
    carCount: 8,
  };
  expect(legPresentation(p, journeyLeg).carCount).toBe(8);
});
it("uses external destination metadata without generating an external ride", () => {
  const p = fixture(),
    l = leg(p),
    t = p.timetables[0].trains[0];
  p.oud2!.externalTerminals.push({
    id: "external",
    boundaryStationId: "s4",
    name: "外部中央",
  });
  t.externalDestination = {
    terminalId: "external",
    boundaryStationId: "s4",
    positionId: "p4",
    raw: "4/...",
  };
  expect(legPresentation(p, l).destination).toBe("外部中央");
  expect(l.destination.stationId).toBe("s2");
});
it("does not fabricate platform names for missing, invalid or placeholder track indexes", () => {
  const p = fixture();
  expect(
    platformName(p, {
      stationId: "s0",
      status: "stop",
      track: "9",
      positionId: "p0",
    }),
  ).toBeNull();
  expect(
    platformName(p, {
      stationId: "s0",
      status: "stop",
      track: "1e0",
      positionId: "p0",
    }),
  ).toBeNull();
  p.oud2!.positions[0].tracks[0] = "ーーーーー";
  expect(
    platformName(p, {
      stationId: "s0",
      status: "stop",
      track: "0",
      positionId: "p0",
    }),
  ).toBeNull();
});
it("resolves arrival and departure tracks independently at duplicated branch rows", () => {
  const p = fixture(),
    t = p.timetables[0].trains[0];
  t.stops.splice(
    0,
    1,
    {
      stationId: "s0",
      positionId: "p0",
      status: "stop",
      arrival: 25100,
      track: "0",
    },
    {
      stationId: "s0",
      positionId: "branch",
      status: "stop",
      departure: 25200,
      track: "0",
    },
  );
  p.oud2!.positions.push({
    id: "branch",
    stationId: "s0",
    name: p.stations[0].name,
    tracks: ["8番線"],
    outerTerminalIds: [],
  });
  expect(legPresentation(p, leg(p)).departureTrack).toBe("8番線");
});
