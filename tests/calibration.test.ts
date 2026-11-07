import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import {
  generateTemporalDemand,
  defaultTemporalConfig,
} from "../src/temporal-demand";
import { validateProject } from "../src/model";
import { validateTemporalState, type DailyOD } from "../src/temporal-model";
import {
  calibrateDemand,
  importObservations,
  observationTemplate,
  validateObservations,
  type Observation,
} from "../src/calibration";
import { analytics, buildScenario } from "../src/scenarios";
const obs = (id: string, changes: Partial<Observation> = {}): Observation => ({
  id,
  kind: "od",
  stationId: "",
  origin: "s0",
  destination: "s4",
  timetableId: "",
  trainId: "",
  segmentIndex: null,
  period: "weekday-outbound",
  value: 100,
  source: "試験用の観測値",
  role: "fit",
  ...changes,
});
const seed: DailyOD[] = [
  {
    origin: "s0",
    destination: "s4",
    purpose: "commute",
    kind: "outbound",
    source: "estimated",
    passengers: 50,
  },
  {
    origin: "s1",
    destination: "s3",
    purpose: "commute",
    kind: "outbound",
    source: "estimated",
    passengers: 50,
  },
];
it("imports strict CSV with IDs, source, period and validation role", () => {
  const p = sampleProject();
  const template = observationTemplate();
  expect(importObservations(p, template)[0]).toMatchObject({
    origin: "s0",
    destination: "s4",
    role: "fit",
    value: 100,
  });
  expect(() =>
    importObservations(p, template.replace("s4", "unknown")),
  ).toThrow("駅ID");
  expect(() => importObservations(p, template.replace('"100"', '""'))).toThrow(
    "人数",
  );
  expect(() => validateObservations(p, [obs("a"), obs("b")])).toThrow("重複");
  expect(() => validateObservations(p, [obs("a", { source: "" })])).toThrow(
    "出典",
  );
});
it("fits marginal trip ends using IPF while keeping validation values out of fitting", () => {
  const p = sampleProject();
  const rows = [
    obs("o", { kind: "boarding", stationId: "s0", value: 80 }),
    obs("d", { kind: "alighting", stationId: "s4", value: 80 }),
    obs("validation", { value: 999, role: "validation" }),
  ];
  const r = calibrateDemand(p, seed, rows, "weekday-outbound", true);
  expect(r.converged).toBe(true);
  expect(r.daily[0].passengers).toBe(80);
  expect(r.daily[0].source).toBe("estimated");
  expect(r.after.rows.find((x) => x.id === "validation")!.estimated).toBe(80);
  expect(r.before.rows.find((x) => x.id === "o")!.error).toBe(-30);
  expect(r.after.rows.find((x) => x.id === "o")!.error).toBe(0);
  expect(seed[0].passengers).toBe(50);
});
it("does not treat station counts as observed OD without explicit confirmation", () => {
  const p = sampleProject();
  const r = calibrateDemand(
    p,
    seed,
    [obs("o", { kind: "boarding", stationId: "s0", value: 999 })],
    "weekday-outbound",
  );
  expect(r.daily).toEqual(seed);
  expect(r.excluded[0].reason).toContain("未承認");
  expect(r.after.count).toBe(0);
});
it("preserves structural zeros and reports non-convergence rather than inventing paths", () => {
  const p = sampleProject();
  const r = calibrateDemand(
    p,
    seed,
    [obs("o", { kind: "boarding", stationId: "s2", value: 99 })],
    "weekday-outbound",
    true,
  );
  expect(r.converged).toBe(false);
  expect(r.daily.some((d) => d.origin === "s2")).toBe(false);
  expect(r.excluded.some((x) => x.reason.includes("構造的ゼロ"))).toBe(true);
});
it("keeps periods separate, rejects invalid train segments, and supports no observations", () => {
  const p = sampleProject();
  const r = calibrateDemand(
    p,
    seed,
    [obs("x", { period: "other" })],
    "weekday-outbound",
    true,
  );
  expect(r.daily).toEqual(seed);
  expect(r.excluded).toHaveLength(1);
  expect(calibrateDemand(p, seed, [], "none").after.mae).toBeNull();
  expect(() =>
    validateObservations(p, [
      obs("load", {
        kind: "load",
        timetableId: "weekday",
        trainId: "down-0",
        segmentIndex: 99,
      }),
    ]),
  ).toThrow("区間");
});
it("selects gravity coefficients on fit OD and never uses validation OD for optimization", () => {
  const p = sampleProject(),
    c = defaultTemporalConfig();
  c.beta = 0.05;
  p.temporal = generateTemporalDemand(p, c, p.costs);
  const target = generateTemporalDemand(
    p,
    { ...c, beta: 0.2 },
    p.costs,
  ).dailyOutbound;
  const rows = target
    .filter((d) => d.purpose === "commute" && d.origin === "s0")
    .map((d, i) =>
      obs("o" + i, {
        origin: d.origin,
        destination: d.destination,
        value: target
          .filter(
            (x) => x.origin === d.origin && x.destination === d.destination,
          )
          .reduce((s, x) => s + x.passengers, 0),
      }),
    );
  const r = calibrateDemand(
    p,
    p.temporal.dailyOutbound,
    rows,
    "weekday-outbound",
    false,
    true,
  );
  expect(r.after.rmse!).toBeLessThan(r.before.rmse!);
  const after = calibrateDemand(
    p,
    p.temporal.dailyOutbound,
    [...rows, obs("v", { origin: "s1", value: 1e9, role: "validation" })],
    "weekday-outbound",
    false,
    true,
  );
  expect(after.selectedCoefficients).toEqual(r.selectedCoefficients);
  expect((r.selectedCoefficients as typeof c).beta).toBe(0.2);
});
it("saves automatic, observed and hybrid demand without changing original city settings", () => {
  const p = sampleProject();
  const original = structuredClone(p.stations);
  analytics(p).observations = [obs("o")];
  for (const mode of ["automatic", "observed", "hybrid"] as const) {
    const s = buildScenario(p, mode, mode, "weekday-outbound");
    validateTemporalState(s.temporal, new Set(p.stations.map((s) => s.id)));
    if (mode !== "automatic") {
      expect(
        s.temporal.dailyOutbound.find(
          (r) => r.origin === "s0" && r.destination === "s4",
        )?.source,
      ).toBe("observed");
      expect(s.temporal.slots.some((r) => r.source === "observed")).toBe(true);
    }
    analytics(p).scenarios.push(s);
  }
  validateProject(p);
  expect(p.stations).toEqual(original);
  const bigger = buildScenario(p, "人口2倍", "automatic", "", {
    population: 2,
    employment: 1,
    students: 1,
    railShare: 1,
    concentration: 1,
  });
  expect(bigger.temporal.generated).toBeCloseTo(
    analytics(p).scenarios[0].temporal.generated * 2,
  );
});
it("rejects malformed analytics without modifying the source object", () => {
  const p = sampleProject();
  analytics(p).scenarios.push(buildScenario(p, "base", "automatic", ""));
  const text = JSON.stringify(p);
  const bad = JSON.parse(text);
  bad.analytics.scenarios[0].temporal.slots[0].passengers = -1;
  expect(() => validateProject(bad)).toThrow();
  expect(JSON.stringify(p)).toBe(text);
});
