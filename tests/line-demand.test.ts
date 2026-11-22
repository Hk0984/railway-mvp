import { describe, expect, it } from "vitest";
import { assignDemand, queryFor } from "../src/assignment";
import { defaultAssignmentConfig } from "../src/assignment-model";
import {
  arrivalHourIndex,
  defaultLineDemand,
  estimateLineDemand,
  lineDemandForDay,
  serviceDay,
  setLineDemandForDay,
  type OutsideArea,
} from "../src/line-demand";
import { validateProject } from "../src/model";
import { buildRoutingIndex, searchJourneys } from "../src/routing";
import { sampleProject } from "../src/sample";

const total = (rows: { passengers: number }[]) =>
  rows.reduce((sum, row) => sum + row.passengers, 0);

function area(overrides: Partial<OutsideArea> = {}): OutsideArea {
  return {
    id: "outside",
    name: "都心方面",
    stationId: "s0",
    inbound: 35,
    outbound: 15,
    included: false,
    mode: "transfer",
    trains: {},
    ...overrides,
  };
}

describe("single-line demand", () => {
  it("keeps independent counts and time distributions when using the same timetable on different days", () => {
    const p = sampleProject();
    const counts = (board: number, alight: number) => ({
      s0: { board, alight: 0, weight: 1 },
      s4: { board: 0, alight, weight: 1 },
    });
    p.lineDemand = {
      ...defaultLineDemand(),
      counts: counts(120, 120),
      shares: { local: [100, 0, 0, 0] },
      boardingLimitPercent: 150,
    };
    expect(lineDemandForDay(p, "friday")).toEqual(p.lineDemand);
    expect(lineDemandForDay(p, "holiday")).toEqual(p.lineDemand);
    expect(estimateLineDemand(p, "weekday", "friday").byTime).toEqual([
      120, 0, 0, 0,
    ]);

    setLineDemandForDay(
      p,
      {
        ...lineDemandForDay(p, "friday"),
        counts: counts(180, 180),
        shares: { local: [0, 0, 0, 100] },
      },
      "friday",
    );
    const hourly = Array<number>(24).fill(0);
    hourly[13] = 100;
    setLineDemandForDay(
      p,
      {
        ...lineDemandForDay(p, "holiday"),
        counts: counts(80, 80),
        boardingLimitPercent: 170,
        destinationArrival: {
          enabled: true,
          shares: { up: hourly, down: hourly },
        },
      },
      "holiday",
    );

    p.demandSelection = { day: "holiday", timetableId: "weekday" };
    const reopened = JSON.parse(JSON.stringify(p));
    validateProject(reopened);
    expect(estimateLineDemand(reopened, "weekday").dailyBoard).toBe(80);
    expect(estimateLineDemand(reopened, "weekday").byArrival?.down[13]).toBe(
      80,
    );
    expect(estimateLineDemand(reopened, "weekday", "friday").byTime).toEqual([
      0, 0, 0, 180,
    ]);
    expect(estimateLineDemand(reopened, "weekday", "weekday").byTime).toEqual([
      120, 0, 0, 0,
    ]);
    expect(lineDemandForDay(reopened, "friday").boardingLimitPercent).toBe(170);
    expect(lineDemandForDay(reopened, "weekday").boardingLimitPercent).toBe(
      170,
    );
  });

  it("validates saved demand for an inactive day", () => {
    const p = sampleProject();
    p.lineDemandByDay = {
      friday: { ...defaultLineDemand(), shares: { local: [1, 2, 3, 4] } },
    };
    expect(() => validateProject(p)).toThrow("時間帯の割合は各設定で合計100%");
    p.lineDemandByDay.friday = defaultLineDemand();
    p.demandSelection = { day: "friday", timetableId: "unknown" };
    expect(() => validateProject(p)).toThrow("需要の日区分・対象ダイヤ");
  });

  it("uses station attributes and purpose shares to distribute the same daily boardings by destination and hour", () => {
    const p = sampleProject();
    const d = (p.lineDemand = defaultLineDemand());
    d.counts = {
      s0: { board: 1000, alight: 100, weight: 1 },
      s2: { board: 400, alight: 100, weight: 1 },
      s4: { board: 0, alight: 100, weight: 1 },
    };
    d.stationProfileTiming = true;
    d.stationProfiles = {
      s0: {
        primary: "high-density-residential",
        shares: { commute: 60, school: 30, private: 10 },
      },
      s2: {
        primary: "employment",
        secondary: "nightlife",
        shares: { commute: 100, school: 0, private: 0 },
      },
      s4: { primary: "education" },
    };
    const plan = estimateLineDemand(p, "weekday");
    const fromHome = plan.rows.filter((row) => row.origin === "s0");
    expect(total(fromHome)).toBeCloseTo(1000);
    expect(
      total(fromHome.filter((row) => row.purpose === "commute")),
    ).toBeCloseTo(600);
    expect(
      total(fromHome.filter((row) => row.purpose === "school")),
    ).toBeCloseTo(300);
    expect(
      total(fromHome.filter((row) => row.purpose === "private")),
    ).toBeCloseTo(100);
    expect(total(plan.rows)).toBeCloseTo(1400);
    const morning = (purpose: string, destination: string) =>
      total(
        fromHome.filter(
          (row) =>
            row.purpose === purpose &&
            row.destination === destination &&
            arrivalHourIndex(row.start) === 8,
        ),
      );
    expect(morning("commute", "s2")).toBeGreaterThan(morning("commute", "s4"));
    expect(morning("school", "s4")).toBeGreaterThan(morning("school", "s2"));

    const toHome = plan.rows.filter(
      (row) => row.origin === "s2" && row.destination === "s0",
    );
    expect(
      total(toHome.filter((row) => arrivalHourIndex(row.start) === 18)),
    ).toBeGreaterThan(
      total(toHome.filter((row) => arrivalHourIndex(row.start) === 8)),
    );
    const nightDemand = (rows: typeof plan.rows) =>
      total(
        rows.filter(
          (row) =>
            row.origin === "s0" &&
            row.destination === "s2" &&
            row.purpose === "private" &&
            arrivalHourIndex(row.start) === 21,
        ),
      );
    delete d.stationProfiles.s2.secondary;
    expect(nightDemand(plan.rows)).toBeGreaterThan(
      nightDemand(estimateLineDemand(p, "weekday").rows),
    );
    expect(plan.smoothedArrivalShares).toEqual(plan.byArrival);
  });

  it("preserves manually entered hourly percentages and origin purpose shares, including reserved external flow", () => {
    const p = sampleProject();
    const d = (p.lineDemand = defaultLineDemand(true));
    d.stationProfiles = {
      s2: {
        primary: "education",
        shares: { commute: 20, school: 70, private: 10 },
      },
    };
    d.outside = [area({ included: false, inbound: 0, outbound: 500 })];
    const up = Array<number>(24).fill(0),
      down = Array<number>(24).fill(0);
    up[4] = 25;
    up[18] = 75;
    down[8] = 60;
    down[14] = 40;
    d.destinationArrival = {
      enabled: true,
      smooth: true,
      shares: { up, down },
    };
    const plan = estimateLineDemand(p, "weekday");
    expect(plan.external.outbound).toBeCloseTo(500);
    expect(total(plan.rows)).toBeCloseTo(plan.dailyBoard);
    for (const dir of ["up", "down"] as const) {
      const values = plan.byArrival![dir];
      const amount = values.reduce((a, b) => a + b, 0);
      expect(amount).toBeGreaterThan(0);
      values.forEach((value, i) =>
        expect((value / amount) * 100).toBeCloseTo(
          d.destinationArrival!.shares[dir][i],
        ),
      );
    }
    const atSchool = plan.rows.filter((row) => row.origin === "s2");
    expect(total(atSchool)).toBeCloseTo(d.counts.s2.board);
    expect(
      total(atSchool.filter((row) => row.purpose === "school")),
    ).toBeCloseTo(d.counts.s2.board * 0.7);
    expect(plan.smoothedArrivalShares).toEqual({ up, down });
    d.stationProfiles.s2.shares!.private = 20;
    expect(() => validateProject(p)).toThrow(
      "通勤・通学・非定期の割合を合計100%",
    );
  });

  it("splits the four periods without dropping the after-midnight part", () => {
    const p = sampleProject();
    p.lineDemand = defaultLineDemand();
    p.lineDemand.counts = {
      s0: { board: 300, alight: 0, weight: 1 },
      s4: { board: 0, alight: 900, weight: 1 },
    };
    p.lineDemand.shares.local = [0, 0, 0, 100];
    const plan = estimateLineDemand(p, "weekday");
    expect(plan.byTime).toEqual([0, 0, 0, 300]);
    expect(
      plan.rows.map((row) => [
        row.start / 3600,
        row.end / 3600,
        row.passengers,
      ]),
    ).toEqual([
      [4, 6, 60],
      [20, 28, 240],
    ]);
    expect(total(plan.rows)).toBeCloseTo(300);
  });

  it("keeps an external area counted once and honors a directional time override", () => {
    const p = sampleProject();
    p.lineDemand = defaultLineDemand(true);
    p.lineDemand.outside = [area({ included: true })];
    p.lineDemand.shares.inbound = [100, 0, 0, 0];
    const plan = estimateLineDemand(p, "weekday");
    expect(plan.external.inbound).toBeCloseTo(35);
    expect(plan.external.outbound).toBeCloseTo(15);
    expect(plan.destinations.get("都心方面")).toBeCloseTo(15);
    expect(total(plan.rows)).toBeCloseTo(90000);
    expect(plan.byTime[0]).toBeCloseTo((90000 - 35) * 0.4 + 35);
    p.lineDemand.outside[0].inbound = p.lineDemand.counts.s0.board + 1;
    expect(() => estimateLineDemand(p, "weekday")).toThrow("内数");
  });

  it("leaves an external flow unassigned when its designated train does not exist", () => {
    const p = sampleProject();
    p.lineDemand = defaultLineDemand(true);
    p.lineDemand.outside = [area({ mode: "through" })];
    const plan = estimateLineDemand(p, "weekday");
    expect(plan.external).toEqual({ inbound: 0, outbound: 0 });
    expect(plan.rejected).toBeCloseTo(50);
    expect(plan.warnings).toHaveLength(2);
  });

  it("loads only the designated through trains, including an explicit passing time at the boundary", () => {
    const p = sampleProject();
    const dia = p.timetables[0];
    dia.trains.find((t) => t.id === "down-3")!.stops[0].status = "pass";
    const end = dia.trains.find((t) => t.id === "up-0")!.stops.at(-1)!;
    end.status = "pass";
    end.departure = end.arrival;
    delete end.arrival;
    p.lineDemand = defaultLineDemand();
    p.lineDemand.counts = { s4: { board: 15, alight: 35, weight: 1 } };
    p.lineDemand.shares.local = [100, 0, 0, 0];
    p.lineDemand.outside = [
      area({
        mode: "through",
        trains: {
          weekday: { inbound: ["down-3"], outbound: ["up-0"] },
        },
      }),
    ];
    validateProject(p);
    const input = estimateLineDemand(p, "weekday").rows;
    const index = buildRoutingIndex(
      [{ datasetId: p.datasetId!, project: p, timetableId: dia.id }],
      [],
      { includeBoundaryBoards: true },
    );
    const config = {
      ...defaultAssignmentConfig(),
      ...serviceDay(p),
      maxTransfers: 0,
    };
    const result = assignDemand(index, input, config);
    expect(result.totals.assigned).toBeGreaterThan(0);
    expect(result.totals.assigned + result.totals.unassigned).toBeCloseTo(50);
    expect(
      result.loads
        .filter((l) => l.peakLoad > 0)
        .map((l) => l.trainId)
        .sort(),
    ).toEqual(["down-3", "up-0"]);
    for (const row of input) {
      const q = queryFor(row, config, 21600);
      const expected =
        row.boundaryOriginTrains ?? row.boundaryDestinationTrains;
      expect(
        searchJourneys(index, q).journeys.map((j) => j.legs[0].trainId),
      ).toEqual(expected);
      const unrestricted = searchJourneys(index, {
        ...q,
        boundaryOriginTrains: undefined,
        boundaryDestinationTrains: undefined,
      });
      expect(unrestricted.journeys.length).toBeGreaterThan(0);
      expect(unrestricted.journeys.map((j) => j.legs[0].trainId)).not.toContain(
        expected![0],
      );
    }
  });
});
