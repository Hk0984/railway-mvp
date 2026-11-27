import { describe, it, expect } from "vitest";
import {
  buildRoutingIndex,
  searchJourneys,
  journeyProfile,
  validateJourney,
} from "../src/routing";
import { analyzeService } from "../src/service";
import { lineStationPath } from "../src/line-topology";
import { sampleProject } from "../src/sample";
import type { Project, Train, Stop } from "../src/model";
import type {
  RouteQuery,
  DatasetSelection,
  TransferLink,
} from "../src/routing-model";

const ref = (id: string, datasetId = "a") => ({ datasetId, stationId: id });
const q = (overrides: Partial<RouteQuery> = {}): RouteQuery => ({
  origin: ref("s0"),
  destination: ref("s4"),
  time: 7 * 3600,
  mode: "depart",
  maxTransfers: 2,
  minimumTransferSeconds: 120,
  directOnly: false,
  sort: "arrival",
  limit: 20,
  ...overrides,
});
function fixture() {
  const p = sampleProject();
  p.timetables = [{ id: "one", name: "one", trains: [] }];
  return p;
}
function train(id: string, stops: Stop[]): Train {
  return { id, number: id, typeId: "local", direction: "down", stops };
}
const s = (
  stationId: string,
  arrival?: number,
  departure?: number,
  status: Stop["status"] = "stop",
): Stop => ({ stationId, arrival, departure, status });
const selection = (p: Project, datasetId = "a"): DatasetSelection => ({
  datasetId,
  project: p,
  timetableId: p.timetables[0].id,
});
describe("時刻表経路検索", () => {
  it.each(["depart", "arrive"] as const)(
    "keeps forward connections when a faster overshoot would dominate in %s mode",
    (mode) => {
      const p = fixture();
      p.timetables[0].trains = [
        train("feeder", [s("s0", undefined, 60), s("s1", 180)]),
        train("local", [s("s1", undefined, 240), s("s3", 720)]),
        train("overshoot", [
          s("s0", undefined, 120),
          s("s3", undefined, undefined, "pass"),
          s("s4", 300),
        ]),
        train("return", [s("s4", undefined, 360), s("s3", 480)]),
      ];
      const idx = buildRoutingIndex([selection(p)]);
      const query = q({
        destination: ref("s3"),
        time: mode === "depart" ? 0 : 900,
        mode,
        minimumTransferSeconds: 60,
      });
      const old = searchJourneys(idx, query);
      expect(old.journeys[0].legs.map((l) => l.trainId)).toEqual([
        "overshoot",
        "return",
      ]);
      const forward = {
        ...query,
        stationPath: lineStationPath(p, "s0", "s3")!.map((id) => ref(id)),
      };
      const found = searchJourneys(idx, forward);
      expect(found.journeys.map((j) => j.legs.map((l) => l.trainId))).toEqual([
        ["feeder", "local"],
      ]);
      expect(validateJourney(idx, forward, found.journeys[0])).toEqual([]);
      expect(validateJourney(idx, forward, old.journeys[0])).not.toEqual([]);
    },
  );

  it("excludes a direct train that doubles back, even after an unrestricted cache lookup", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("direct", [s("s0", undefined, 60), s("s3", 720)]),
      train("backtrack", [
        s("s0", undefined, 120),
        s("s3", 240, 240, "pass"),
        s("s4", 300, 360),
        s("s3", 480),
      ]),
    ];
    const idx = buildRoutingIndex([selection(p)]);
    const query = q({ destination: ref("s3"), time: 0, directOnly: true });
    expect(searchJourneys(idx, query).journeys[0].legs[0].trainId).toBe(
      "backtrack",
    );
    const forward = {
      ...query,
      stationPath: lineStationPath(p, "s0", "s3")!.map((id) => ref(id)),
    };
    expect(
      searchJourneys(idx, forward).journeys.map((j) => j.legs[0].trainId),
    ).toEqual(["direct"]);
  });

  it("allows a transfer across branches even when train direction changes", () => {
    const p = fixture();
    p.oud2 = {
      fileType: "OuDiaSecond.1.17",
      serviceDayStart: 0,
      positions: [],
      externalTerminals: [],
      emptyColumns: 0,
      warnings: [],
      links: [
        ["s0", "s1"],
        ["s1", "s2"],
        ["s1", "s3"],
        ["s3", "s4"],
      ].map(([from, to]) => ({ from, to })),
    };
    p.timetables[0].trains = [
      {
        ...train("inbound", [s("s2", undefined, 60), s("s1", 180)]),
        direction: "up",
      },
      train("outbound", [
        s("s1", undefined, 240),
        s("s3", 300, 300, "pass"),
        s("s4", 360),
      ]),
    ];
    const path = lineStationPath(p, "s2", "s4");
    expect(path).toEqual(["s2", "s1", "s3", "s4"]);
    const idx = buildRoutingIndex([selection(p)]);
    const query = q({
      origin: ref("s2"),
      time: 0,
      minimumTransferSeconds: 60,
      stationPath: path!.map((id) => ref(id)),
    });
    const [journey] = searchJourneys(idx, query).journeys;
    expect(journey.legs.map((l) => l.trainId)).toEqual(["inbound", "outbound"]);
    expect(validateJourney(idx, query, journey)).toEqual([]);
  });

  it("returns multiple direct routes with independently valid structured legs", () => {
    const p = sampleProject(),
      idx = buildRoutingIndex([selection(p)]),
      query = q({ directOnly: true });
    const r = searchJourneys(idx, query);
    expect(r.journeys.length).toBeGreaterThan(1);
    for (const j of r.journeys) {
      expect(j.legs).toHaveLength(1);
      expect(validateJourney(idx, query, j)).toEqual([]);
      expect(j.legs[0].timetableId).toBe("weekday");
    }
  });
  it("finds transfer-only path and enforces minimum change time exactly", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("first", [s("s0", undefined, 100), s("s2", 200)]),
      train("miss", [s("s2", undefined, 259), s("s4", 300)]),
      train("valid", [s("s2", undefined, 260), s("s4", 400)]),
    ];
    const idx = buildRoutingIndex([selection(p)]),
      query = q({ time: 0, minimumTransferSeconds: 60 });
    const r = searchJourneys(idx, query);
    expect(r.journeys[0].legs.map((l) => l.trainId)).toEqual([
      "first",
      "valid",
    ]);
    expect(r.journeys[0].transferWaitSeconds).toBe(60);
    expect(validateJourney(idx, query, r.journeys[0])).toEqual([]);
    expect(
      searchJourneys(idx, { ...query, directOnly: true }).journeys,
    ).toHaveLength(0);
  });
  it("cannot board or alight at passing, operational, or prohibited stops", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("x", [
        s("s0", undefined, 100),
        s("s1", 150, 150, "pass"),
        { ...s("s2", 200, 210), pickupAllowed: false, dropoffAllowed: false },
        s("s4", 300),
      ]),
    ];
    const idx = buildRoutingIndex([selection(p)]);
    expect(
      searchJourneys(idx, q({ origin: ref("s1"), time: 0 })).journeys,
    ).toHaveLength(0);
    expect(
      searchJourneys(idx, q({ destination: ref("s1"), time: 0 })).journeys,
    ).toHaveLength(0);
    expect(
      searchJourneys(idx, q({ origin: ref("s2"), time: 0 })).journeys,
    ).toHaveLength(0);
    expect(
      searchJourneys(idx, q({ destination: ref("s2"), time: 0 })).journeys,
    ).toHaveLength(0);
  });
  it("handles short workings, reverse journeys and absent arrivals without filling them", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("short", [s("s1", undefined, 100), s("s2", 200)]),
      train("up", [s("s4", undefined, 100), s("s0", 200)]),
      train("missing", [s("s0", undefined, 110), s("s4", undefined, 210)]),
    ];
    const idx = buildRoutingIndex([selection(p)]);
    expect(searchJourneys(idx, q({ time: 0 })).journeys).toHaveLength(0);
    expect(
      searchJourneys(
        idx,
        q({ origin: ref("s4"), destination: ref("s0"), time: 0 }),
      ).journeys[0].arrival,
    ).toBe(200);
    expect(
      searchJourneys(
        idx,
        q({ origin: ref("s1"), destination: ref("s2"), time: 0 }),
      ).journeys[0].legs[0].trainId,
    ).toBe("short");
  });
  it("supports explicit overnight and arrival-by latest departure", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("early", [s("s0", undefined, 86000), s("s4", 87000)]),
      train("late", [s("s0", undefined, 86500), s("s4", 87500)]),
    ];
    const idx = buildRoutingIndex([selection(p)]),
      query = q({ mode: "arrive", time: 87600 });
    const result = searchJourneys(idx, query);
    expect(result.journeys[0].departure).toBe(86500);
    expect(validateJourney(idx, query, result.journeys[0])).toEqual([]);
    expect(
      searchJourneys(idx, { ...query, time: 86900 }).journeys,
    ).toHaveLength(0);
  });
  it("never mixes timetable IDs or joins train records as a zero-change continuation", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("a", [s("s0", undefined, 100), s("s2", 200)]),
    ];
    p.timetables.push({
      id: "two",
      name: "two",
      trains: [train("b", [s("s2", undefined, 200), s("s4", 300)])],
    });
    const idx = buildRoutingIndex([selection(p)]);
    expect(searchJourneys(idx, q({ time: 0 })).journeys).toHaveLength(0);
    p.timetables[0].trains.push(p.timetables[1].trains[0]);
    const combined = buildRoutingIndex([selection(p)]);
    expect(
      searchJourneys(combined, q({ time: 0, minimumTransferSeconds: 1 }))
        .journeys,
    ).toHaveLength(0);
    expect(
      searchJourneys(combined, q({ time: 0, minimumTransferSeconds: 0 }))
        .journeys[0].transferCount,
    ).toBe(1);
  });
  it("requires explicit scoped walking links between datasets, including direction and duration", () => {
    const a = fixture(),
      b = fixture();
    a.timetables[0].trains = [
      train("a", [s("s0", undefined, 100), s("s2", 200)]),
    ];
    b.timetables[0].trains = [
      train("b", [s("s2", undefined, 330), s("s4", 400)]),
    ];
    const sels = [selection(a), selection(b, "b")],
      query = q({
        destination: ref("s4", "b"),
        time: 0,
        minimumTransferSeconds: 30,
      });
    expect(
      searchJourneys(buildRoutingIndex(sels), query).journeys,
    ).toHaveLength(0);
    const link: TransferLink = {
      id: "walk",
      from: ref("s2"),
      to: ref("s2", "b"),
      walkingSeconds: 100,
      direction: "forward",
      basis: "テストで明示した徒歩連絡",
    };
    const idx = buildRoutingIndex(sels, [link]),
      r = searchJourneys(idx, query);
    expect(r.journeys[0].walkingSeconds).toBe(100);
    expect(r.journeys[0].transferWaitSeconds).toBe(30);
    expect(validateJourney(idx, query, r.journeys[0])).toEqual([]);
    expect(
      searchJourneys(
        buildRoutingIndex(sels, [{ ...link, walkingSeconds: 101 }]),
        query,
      ).journeys,
    ).toHaveLength(0);
  });
  it("sorts riding time separately from earliest arrival", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("long", [s("s0", undefined, 100), s("s4", 400)]),
      train("short", [s("s0", undefined, 500), s("s4", 600)]),
    ];
    const idx = buildRoutingIndex([selection(p)]);
    expect(
      searchJourneys(idx, q({ time: 0 })).journeys[0].legs[0].trainId,
    ).toBe("long");
    expect(
      searchJourneys(idx, q({ time: 0, sort: "riding" })).journeys[0].legs[0]
        .trainId,
    ).toBe("short");
  });
  it("evaluates effective service against successors outside the reporting window", () => {
    const p = fixture();
    p.timetables[0].trains = [
      train("slow", [s("s0", undefined, 100), s("s4", 1000)]),
      train("express", [s("s0", undefined, 200), s("s4", 500)]),
    ];
    const idx = buildRoutingIndex([selection(p)]);
    const result = analyzeService(idx, q({ time: 0 }), 0, 150);
    expect(result.directCount).toBe(1);
    expect(result.directEffectiveCount).toBe(0);
    expect(result.journeyCount).toBe(0);
    expect(result.journeyWait.minutes).toBeCloseTo(125 / 60);
  });
  it("gives explicit reasons for same-station, no-route and invalid references", () => {
    const idx = buildRoutingIndex([selection(fixture())]);
    expect(searchJourneys(idx, q()).reason).toContain("ありません");
    expect(searchJourneys(idx, q({ destination: ref("s0") })).reason).toContain(
      "同じ駅",
    );
    expect(() =>
      searchJourneys(idx, q({ destination: ref("absent") })),
    ).toThrow();
  });
});
