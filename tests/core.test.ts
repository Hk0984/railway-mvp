import { describe, it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { validateProject } from "../src/model";
import {
  headways,
  directTrains,
  expectedWait,
  stationDepartures,
  clock,
} from "../src/analysis";
import { generateDemand, timetableCosts } from "../src/demand";
import {
  csv,
  parseCsv,
  stationCsv,
  importStationCsv,
  demandCsv,
  importDemandCsv,
} from "../src/io";
import { parseOud2 } from "../src/oud2";

const fixture = (times = "1;235000,1;241000/") =>
  `FileType=OuDiaSecond.1.07\nRosen.\nRosenmei=試験線\nEki.\nEkimei=甲\n.\nEki.\nEkimei=乙\n.\nRessyasyubetsu.\nSyubetsumei=普通\n.\nDia.\nDiaName=平日\nKudari.\nRessya.\nHoukou=Kudari\nSyubetsu=0\nRessyabangou=101\nEkiJikoku=${times}\n.\n.\n.\n.\n`;
describe("sample and timetable", () => {
  it("valid sample has 5 stations, 72 trains, 36 each direction", () => {
    const p = sampleProject();
    expect(() => validateProject(p)).not.toThrow();
    expect(p.stations).toHaveLength(5);
    expect(p.timetables[0].trains).toHaveLength(72);
    expect(stationDepartures(p.timetables[0], "s0", "down", "")).toHaveLength(
      36,
    );
    expect(stationDepartures(p.timetables[0], "s0", "up", "")).toHaveLength(0);
  });
  it("headways handle unequal gaps and insufficient data", () => {
    expect(headways([1800, 0, 600])).toEqual({
      mean: 15,
      median: 15,
      max: 20,
      sd: 5,
    });
    expect(headways([1])).toBeNull();
  });
  it("sample travel times distinguish rapid and local", () => {
    const p = sampleProject(),
      r = directTrains(p.timetables[0], "s0", "s4");
    expect(r).toHaveLength(36);
    expect(Math.min(...r.map((x) => (x.arrival - x.departure) / 60))).toBe(20);
    expect(Math.max(...r.map((x) => (x.arrival - x.departure) / 60))).toBe(28);
    expect(directTrains(p.timetables[0], "s0", "s0")).toEqual([]);
    expect(directTrains(p.timetables[0], "s0", "s1")).toHaveLength(24);
  });
  it("removes overtaken trains, retains equal options", () => {
    const p = sampleProject();
    const t = structuredClone(p.timetables[0].trains[0]);
    t.stops = [
      { stationId: "s0", status: "stop", departure: 600 },
      { stationId: "s4", status: "stop", arrival: 2400 },
    ];
    const fast = structuredClone(t);
    fast.id = "fast";
    fast.stops[0].departure = 900;
    fast.stops[1].arrival = 1800;
    const rows = directTrains(
      { id: "x", name: "x", trains: [t, fast] },
      "s0",
      "s4",
    );
    expect(rows.map((r) => r.effective)).toEqual([false, true]);
    expect(expectedWait(rows, 0, 900)).toEqual({ minutes: 7.5, coverage: 1 });
  });
  it("integrates random arrival wait and reports unserved tail", () => {
    const t = sampleProject().timetables[0].trains[0];
    const rows = [
      { train: t, departure: 600, arrival: 1200, effective: true },
      { train: t, departure: 1200, arrival: 1800, effective: true },
    ];
    expect(expectedWait(rows, 0, 1200)).toEqual({ minutes: 5, coverage: 1 });
    expect(expectedWait(rows, 0, 1800)).toEqual({
      minutes: 5,
      coverage: 2 / 3,
    });
    expect(expectedWait([], 0, 600)).toEqual({ minutes: null, coverage: 0 });
    expect(() => expectedWait(rows, 1, 1)).toThrow();
  });
});
describe("gravity model", () => {
  it("conserves 9900 passengers and all origin totals", () => {
    const p = sampleProject(),
      r = generateDemand(p, p.costs);
    expect(r.generated).toBe(9900);
    expect(r.allocated).toBeCloseTo(9900, 8);
    expect(r.demands).toHaveLength(20);
    for (const s of p.stations)
      expect(
        r.demands
          .filter((d) => d.origin === s.id)
          .reduce((a, d) => a + d.passengers, 0),
      ).toBeCloseTo(s.population * s.railShare * 0.15);
    expect(
      r.demands.every(
        (d) => d.origin !== d.destination && d.source === "estimated",
      ),
    ).toBe(true);
  });
  it("reports inaccessible or zero-attraction origins without NaN", () => {
    const p = sampleProject(),
      r = generateDemand(p, {});
    expect(r.allocated).toBe(0);
    expect(r.unallocated).toBe(9900);
    expect(r.warnings).toHaveLength(5);
    p.parameters.employmentWeight = 0;
    expect(generateDemand(p, p.costs).allocated).toBe(0);
  });
  it("uses stable normalization for extreme beta", () => {
    const p = sampleProject();
    p.parameters.beta = 100000;
    const r = generateDemand(p, p.costs);
    expect(r.allocated).toBeCloseTo(r.generated);
    expect(r.demands.every((d) => Number.isFinite(d.passengers))).toBe(true);
  });
  it("derives directional direct costs without inserting missing links", () => {
    const p = sampleProject();
    const c = timetableCosts(p, "weekday");
    expect(c.s0.s4).toBe(20);
    expect(c.s4.s0).toBe(20);
    expect(c.s0.s0).toBeUndefined();
  });
});
describe("validation and IO", () => {
  it("rejects foreign IDs, duplicate IDs, NaN and reverse times", () => {
    for (const mutate of [
      (p: ReturnType<typeof sampleProject>) => (p.stations[0].population = NaN),
      (p: ReturnType<typeof sampleProject>) => (p.stations[1].id = "s0"),
      (p: ReturnType<typeof sampleProject>) => (p.costs.s0.unknown = 2),
      (p: ReturnType<typeof sampleProject>) =>
        (p.timetables[0].trains[0].stops[2].arrival = 0),
    ]) {
      const p = sampleProject();
      mutate(p);
      expect(() => validateProject(p)).toThrow();
    }
  });
  it("round trips JSON, station CSV and mixed-source demand CSV", () => {
    const p = sampleProject();
    p.stations[0].name = '駅,"甲"\n北口';
    expect(importStationCsv(p, stationCsv(p)).stations).toEqual(p.stations);
    p.demands = generateDemand(p, p.costs).demands;
    p.demands[0].source = "observed";
    p.demands[1].source = "manual";
    expect(importDemandCsv(p, demandCsv(p)).demands).toEqual(p.demands);
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });
  it("rejects malformed CSV and handles escaped quotes/newlines", () => {
    expect(() => parseCsv('"closed"extra')).toThrow();
    expect(parseCsv(csv([["a,b", 'c"d', "e\nf"]]))).toEqual([
      ["a,b", 'c"d', "e\nf"],
    ]);
    expect(() => parseCsv('"open')).toThrow();
    const p = sampleProject();
    expect(() => importStationCsv(p, "bad\n1")).toThrow();
  });
});
describe("OuDiaSecond subset", () => {
  it("accepts documented minute/second forms and a final delimiter", () => {
    for (const pair of ["1;800,1;0820/", "1;80000,1;082000/"]) {
      const p = parseOud2(fixture(pair + ",")).project;
      const rows = directTrains(p.timetables[0], "oud-s0", "oud-s1");
      expect(rows[0].departure).toBe(28800);
      expect(rows[0].arrival).toBe(30000);
    }
    expect(() => parseOud2(fixture("1;080000,1;082000/,,"))).toThrow();
  });
  it("parses explicit overnight, missing departure and track", () => {
    const { project: p } = parseOud2(fixture("1;235000$0,1;241000/$1"));
    expect(directTrains(p.timetables[0], "oud-s0", "oud-s1")[0].arrival).toBe(
      87000,
    );
    expect(clock(87000)).toBe("24:10");
    expect(p.timetables[0].trains[0].stops[1].departure).toBeUndefined();
  });
  it("supports multiple timetables and reverse direction station order", () => {
    const text = fixture().replace(
      "\n.\n.\n.\n.\n",
      "\n.\n.\n.\nDia.\nDiaName=休日\nNobori.\nRessya.\nSyubetsu=0\nEkiJikoku=1;080000,1;082000/\n.\n.\n.\n.\n",
    );
    const p = parseOud2(text).project;
    expect(p.timetables).toHaveLength(2);
    const rows = directTrains(p.timetables[1], "oud-s1", "oud-s0");
    expect(rows).toHaveLength(1);
    expect(rows[0].departure).toBe(28800);
  });
  it("does not invent arrival for a single time", () => {
    const p = parseOud2(fixture("1;080000,1;082000")).project;
    expect(directTrains(p.timetables[0], "oud-s0", "oud-s1")).toHaveLength(0);
  });
  it("rejects unsupported versions, branching, corruption and ambiguous midnight", () => {
    for (const text of [
      fixture().replace("1.07", "1.18"),
      fixture().replace("Ekimei=甲", "Ekimei=甲\nBrunchCoreEkiIndex=1"),
      fixture("1;235000,1;001000/"),
      fixture("1;126000,1;130000/"),
      fixture().slice(0, -2),
      fixture().replace("Ressyabangou=101", "Ressyabangou=101\nCancelled=1"),
    ])
      expect(() => parseOud2(text)).toThrow();
  });
  it("warns explicitly on unused fields", () => {
    expect(
      parseOud2(
        fixture().replace("Ekimei=甲", "Ekimei=甲\nUnknownSetting=1"),
      ).warnings.some((w) => w.includes("UnknownSetting")),
    ).toBe(true);
  });
});
