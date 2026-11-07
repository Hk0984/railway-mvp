import { it, expect } from "vitest";
import { networkSample } from "../src/network-sample";
import { assignDemand } from "../src/assignment";
import { buildRoutingIndex } from "../src/routing";
import { compareBenefits } from "../src/flow-analysis";
import { comparisonConditions, demandMapping } from "../src/result-conditions";
import { comparisonFacts } from "../src/comparison-facts";
import { runAssignmentScenario } from "../src/assignment-scenarios";
it("combines demand, selection and capacity assumptions without modifying saved inputs", () => {
  const s = networkSample(),
    before = JSON.stringify(s),
    state = {
      version: 1 as const,
      config: s.config,
      demands: s.demands,
      permittedRestrictions: [],
    };
  const r = runAssignmentScenario(state, s.projects, s.links, {
    name: "複合試験",
    demandFactor: 1.2,
    waitingFactor: 1.2,
    capacityFactor: 0.8,
    config: { competition: "simultaneous" },
  });
  expect(r.totals.selected).toBe(72);
  expect(r.input[0].source).toBe("estimated");
  expect(JSON.stringify(s)).toBe(before);
  expect(r.capacity!.loads.every((l) => l.peakLoad <= l.capacity!)).toBe(true);
  expect(r.scenario).toBeDefined();
});
function setup() {
  const s = networkSample();
  Object.assign(s.config, {
    competition: "simultaneous",
    diagnosticMode: "full",
  });
  const run = () =>
    assignDemand(
      buildRoutingIndex(
        s.projects.map((project) => ({
          project,
          datasetId: project.datasetId!,
          timetableId: "weekday",
        })),
        s.links,
      ),
      s.demands,
      s.config,
    );
  return { ...s, run };
}
it("compares equal demand independently of row order and object property order", () => {
  const s = setup();
  s.demands.push({ ...s.demands[0], purpose: "school", passengers: 10 });
  const a = s.run();
  s.demands.reverse();
  const b = s.run(),
    r = compareBenefits(a, b);
  expect(r.comparable).toBe(true);
  expect(r.travelChangePersonSeconds).toBe(0);
  expect(comparisonConditions(a, b).sameDemand).toBe(true);
  expect(demandMapping(a.input, b.input)).toEqual([1, 0]);
});
it("records changed assumptions and completion rates without hiding untransported people", () => {
  const s = setup(),
    a = s.run();
  for (const p of s.projects)
    for (const t of p.timetables[0].trains) t.capacity = 1;
  const b = s.run(),
    c = comparisonConditions(a, b),
    benefit = compareBenefits(a, b);
  expect(c.sameDemand).toBe(true);
  expect(c.completionAfter!).toBeLessThan(c.completionBefore!);
  expect(benefit.excluded).toBeGreaterThan(0);
  expect(benefit.odRows.reduce((s, r) => s + r.excluded, 0)).toBeCloseTo(
    benefit.excluded,
  );
  const facts = comparisonFacts(a, b);
  expect(facts.od.some((r) => r.untransportedChange > 0)).toBe(true);
  expect(facts.stations.some((r) => r.difference !== 0)).toBe(true);
});
it("detects selection, transfer, cutoff and time-window differences", () => {
  const s = setup(),
    a = s.run(),
    b = structuredClone(a);
  b.config.method = "logit";
  b.config.minimumTransferSeconds += 30;
  b.config.end += 60;
  b.config.boardingCutoffSeconds = 10;
  const d = comparisonConditions(a, b)
    .conditions.filter((v) => !v.equal)
    .map((v) => v.field);
  expect(d).toContain("列車選択");
  expect(d).toContain("乗換・締切");
  expect(d).toContain("集計窓・上限");
});
it("rejects unequal demand and leaves an all-zero completion rate undefined", () => {
  const s = setup(),
    a = s.run();
  s.demands[0].passengers = 0;
  const b = s.run();
  expect(compareBenefits(a, b).comparable).toBe(false);
  expect(comparisonConditions(b, b).completionBefore).toBeNull();
});
