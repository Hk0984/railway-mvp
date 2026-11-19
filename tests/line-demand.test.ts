import { describe, expect, it } from "vitest";
import { assignDemand, queryFor } from "../src/assignment";
import { defaultAssignmentConfig } from "../src/assignment-model";
import {
  defaultLineDemand,
  estimateLineDemand,
  serviceDay,
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
    expect(total(plan.rows)).toBeCloseTo(36000);
    expect(plan.byTime[0]).toBeCloseTo((36000 - 35) * 0.4 + 35);
    p.lineDemand.outside[0].inbound = 10000;
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
