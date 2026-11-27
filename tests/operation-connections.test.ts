import { expect, it } from "vitest";
import { transportCapacity, trainCarCount } from "../src/capacity-model";
import type { Train } from "../src/model";
import { operationGroup, operationNumbers } from "../src/operation-numbers";
import { settingsBody } from "../src/renewal-settings";
import { sampleProject } from "../src/sample";

function train(
  id: string,
  from: number,
  departure: number,
  arrival: number,
  tracks: [string, string],
): Train {
  const to = 1 - from;
  return {
    id,
    number: id,
    typeId: "local",
    direction: from === 0 ? "down" : "up",
    stops: [
      {
        stationId: `s${from}`,
        positionId: `p${from}`,
        status: "stop",
        departure,
        track: tracks[0],
      },
      {
        stationId: `s${to}`,
        positionId: `p${to}`,
        status: "stop",
        arrival,
        track: tracks[1],
      },
    ],
    operations: [
      { positionId: `p${from}`, phase: "before", code: 5, raw: "5/$" },
      { positionId: `p${to}`, phase: "after", code: 5, raw: "5/$0" },
    ],
  };
}

function fixture() {
  const p = sampleProject();
  p.oud2 = {
    fileType: "OuDiaSecond.1.17",
    serviceDayStart: 14400,
    positions: [],
    externalTerminals: [],
    links: [],
    emptyColumns: 0,
    warnings: [],
  };
  const a = train("a", 0, 85800, 87000, ["0", "1"]);
  a.operations![0] = {
    positionId: "p0",
    phase: "before",
    code: 3,
    raw: "3/2350$/07D",
  };
  a.operations!.splice(1, 0, {
    positionId: "p1",
    phase: "after",
    code: 0,
    raw: "0/2$011/012$0",
  });
  const b = train("b", 1, 87600, 88500, ["3", "1"]);
  b.operations!.splice(1, 0, {
    positionId: "p1",
    phase: "before",
    code: 0,
    raw: "0/2$015/016$0",
  });
  const c = train("c", 0, 88800, 89700, ["1", "4"]);
  p.timetables = [{ id: "test", name: "試験", trains: [c, a, b] }];
  return { p, a, b, c };
}

it("follows successive station-track connections across midnight and uses the inherited formation", () => {
  const { p, a, b, c } = fixture();
  p.capacitySettings = {
    formationSource: "operation",
    trains: {},
    types: {},
    timetables: {},
    operationGroups: {
      "**D": { value: 600, carCount: 4, kind: "transport", basis: "試験" },
    },
  };
  expect(operationGroup(p, b)).toMatchObject({
    numbers: ["07D"],
    group: "**D",
    inheritedFrom: a,
  });
  expect(operationGroup(p, c)).toMatchObject({
    numbers: ["07D"],
    group: "**D",
    inheritedFrom: b,
  });
  expect(operationNumbers(p, c)).toEqual([]);
  expect(transportCapacity(p, "test", c.id)).toBe(600);
  expect(trainCarCount(p, "test", c)).toBe(4);
  b.operationNumbers = ["39C●"];
  expect(operationGroup(p, b).inheritedFrom).toBeUndefined();
  expect(operationGroup(p, c).group).toBe("**C●");
  b.operationNumbers = ["39C●", "08D"];
  expect(operationGroup(p, c).group).toBeNull();
});

it("blocks the link where a different train uses the connection track in between", () => {
  const { p, b } = fixture();
  const crossing = train("other", 1, 87240, 88200, ["2", "0"]);
  crossing.operations = [];
  p.timetables[0].trains.push(crossing);
  expect(operationGroup(p, b).group).toBeNull();
});

function changeAtStation(kind: 1 | 2, track: string) {
  const { p } = fixture();
  const arriving = train("801C", 0, 23910, 25620, ["3", track]);
  arriving.operationNumbers = ["01C"];
  arriving.operations![1].raw = "5/$" + kind;
  const departing = train("803C", 1, 25680, 26880, [track, "0"]);
  departing.direction = "down";
  departing.typeId = kind === 1 ? "rapid" : arriving.typeId;
  departing.stops[1].stationId = "s2";
  departing.stops[1].positionId = "p2";
  departing.operations![1].positionId = "p2";

  const shunting = train("shunt", 1, 25710, 26300, ["4", "0"]);
  shunting.stops[0].arrival = 25620;
  shunting.operations = [
    { positionId: "p1", phase: "after", code: 0, raw: "0/2$708/710$0" },
  ];
  p.timetables[0].trains = [arriving, departing, shunting];
  return { p, arriving, departing };
}

it.each([1, 2] as const)(
  "inherits the same number for junction type %i across a different track's shunt",
  (kind) => {
    const { p, arriving, departing } = changeAtStation(kind, "1");
    expect(operationGroup(p, departing)).toMatchObject({
      numbers: ["01C"],
      group: "**C",
      inheritedFrom: arriving,
    });
  },
);

it.each(["2", "4"])(
  "keeps an ambiguous shunt from joining trains on its track %s",
  (track) => {
    const { p, departing } = changeAtStation(1, track);
    expect(operationGroup(p, departing).group).toBeNull();
  },
);

it("skips simultaneous competing connections and connections across timetables", () => {
  const { p, b, c } = fixture();
  p.timetables[0].trains.push(train("other", 0, 88800, 89800, ["1", "4"]));
  expect(operationGroup(p, c).group).toBeNull();
  const separate = structuredClone(p);
  separate.timetables[0].trains = separate.timetables[0].trains.filter(
    ({ id }) => id !== b.id,
  );
  separate.timetables.push({ id: "other-day", name: "別の日", trains: [b] });
  expect(operationGroup(separate, b).group).toBeNull();
});

it("requires a matching next-train operation and a known track on a running train", () => {
  const missing = fixture();
  missing.a.operations!.pop();
  expect(operationGroup(missing.p, missing.b).group).toBeNull();
  const unknown = fixture();
  delete unknown.b.stops[1].track;
  expect(operationGroup(unknown.p, unknown.c).group).toBeNull();
  const cancelled = fixture();
  cancelled.a.cancelled = true;
  expect(operationGroup(cancelled.p, cancelled.b).group).toBeNull();
});

it("lists the recorded endpoint times only for active trains with no operation group", () => {
  const { p } = fixture();
  const [dia] = p.timetables;
  expect(settingsBody(p, dia)).not.toContain("data-ungrouped-operation-trains");
  const unresolved = train("unresolved", 0, 90510, 91200, ["0", "1"]);
  unresolved.operationNumbers = ["xK"];
  const cancelled = train("cancelled", 0, 90510, 91200, ["0", "1"]);
  cancelled.cancelled = true;
  dia.trains.push(unresolved, cancelled);
  const missingArrival = train(
    "external-with-missing-arrival",
    0,
    93000,
    93600,
    ["0", "1"],
  );
  missingArrival.stops[1].departure = missingArrival.stops[1].arrival;
  delete missingArrival.stops[1].arrival;
  p.oud2!.externalTerminals.push({
    id: "external",
    boundaryStationId: "s0",
    name: "路線外駅",
  });
  missingArrival.externalOrigin = {
    terminalId: "external",
    boundaryStationId: "s0",
    positionId: "p0",
    raw: "",
    externalTime: 92580,
  };
  p.timetables.push({ id: "holiday", name: "休日", trains: [missingArrival] });

  const list = settingsBody(p, dia)
    .split("data-ungrouped-operation-trains")[1]
    ?.split("</details>")[0];
  expect(list).toContain("運用番号でグループ化できない列車（2本）");
  expect(list).toContain(p.stations[0].name + " 25:08:30");
  expect(list).toContain(p.stations[1].name + " 25:20");
  expect(list).toContain("休日");
  expect(list).toContain("路線外駅 25:43");
  expect(list).toContain(p.stations[1].name + " 着時刻未記載");
  expect(list).not.toContain("cancelled");
});
