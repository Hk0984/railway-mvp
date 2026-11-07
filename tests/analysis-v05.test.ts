import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { networkSample } from "../src/network-sample";
import {
  integrationIndex,
  importNetworkDemand,
  networkDemandCsv,
  validateIntegration,
} from "../src/network-model";
import { assignDemand } from "../src/assignment";
import {
  passengerFlows,
  flowSummary,
  trainContributions,
  compareBenefits,
} from "../src/flow-analysis";
import { defaultAssignmentConfig } from "../src/assignment-model";
import {
  evaluateObservations,
  evaluateTrainObservations,
  importObservations,
  observationTemplate,
  calibrateDemand,
  type Observation,
} from "../src/calibration";
import { sensitivityAnalysis } from "../src/sensitivity";
import { parseCsv } from "../src/io";
import { allocationsCsv, unallocatedCsv } from "../src/assignment-io";
it("keeps scoped network OD CSV and analysis exports unambiguous", () => {
  const s = networkSample(),
    state = {
      version: 1 as const,
      config: s.config,
      permittedRestrictions: [],
      demands: s.demands,
    };
  expect(
    importNetworkDemand(networkDemandCsv(s.demands), state, s.projects),
  ).toEqual(s.demands.map((d) => ({ ...d, accessSeconds: 0 })));
  const r = assignDemand(
    integrationIndex(state, s.projects, s.links),
    s.demands,
    s.config,
  );
  const paths = parseCsv(allocationsCsv(r));
  expect(paths[0]).toContain("datasetId");
  expect(
    paths
      .slice(1)
      .some((row) => row[paths[0].indexOf("datasetId")] === "fiction-bus"),
  ).toBe(true);
  expect(parseCsv(unallocatedCsv(r))[0]).toContain("destinationDatasetId");
});
it("derives OD times, peak-section causes and comparison coverage from computed flows", () => {
  const s = networkSample(),
    state = {
      version: 1 as const,
      config: s.config,
      permittedRestrictions: [],
      demands: s.demands,
    },
    idx = integrationIndex(state, s.projects, s.links),
    a = assignDemand(idx, s.demands, s.config);
  const summary = flowSummary(passengerFlows(a));
  expect(summary).toMatchObject({
    demand: 60,
    completed: 40,
    untransported: 20,
    excludedTimePassengers: 20,
    transferPassengers: 40,
  });
  const rows = trainContributions(
    a,
    JSON.stringify(["fiction-bus", "weekday", "same-id"]),
  );
  expect(rows[0].passengers).toBe(25);
  expect(rows[0].transferBoardings).toBe(25);
  const b = assignDemand(idx, s.demands, {
    ...s.config,
    capacityConstrained: false,
  });
  const benefit = compareBenefits(a, b);
  expect(benefit.comparable).toBe(true);
  expect(benefit.common).toBe(40);
  expect(benefit.excluded).toBe(20);
  expect(benefit.improved + benefit.worsened + benefit.unchanged).toBe(40);
  expect(benefit.odRows[0].excluded).toBe(20);
});
const observation = (changes: Partial<Observation> = {}): Observation => ({
  id: "obs",
  kind: "od",
  stationId: "",
  origin: "s0",
  destination: "s4",
  timetableId: "",
  trainId: "",
  segmentIndex: null,
  period: "period",
  value: 0,
  source: "synthetic",
  role: "validation",
  ...changes,
});
it("computes mean error without dividing by zero and rejects mixed observation conditions", () => {
  const p = sampleProject(),
    daily = [
      {
        origin: "s0",
        destination: "s4",
        purpose: "commute" as const,
        kind: "outbound" as const,
        source: "estimated" as const,
        passengers: 5,
      },
    ];
  const metric = evaluateObservations(daily, [observation()]);
  expect(metric.meanError).toBe(5);
  expect(metric.mae).toBe(5);
  expect(metric.rmse).toBe(5);
  expect(metric.rows[0].relativeError).toBeNull();
  expect(() =>
    calibrateDemand(
      p,
      daily,
      [observation({ startSeconds: 0, endSeconds: 900 })],
      "period",
    ),
  ).toThrow("部分時間帯");
  expect(() =>
    calibrateDemand(
      p,
      daily,
      [
        observation({ id: "a", role: "fit", dayGroup: "weekday" }),
        observation({ id: "b", role: "validation", dayGroup: "holiday" }),
      ],
      "period",
      false,
      true,
    ),
  ).toThrow("観測条件");
  const imported = importObservations(p, observationTemplate(true));
  expect(imported[0].startSeconds).toBeUndefined();
});
it("does not match colliding train IDs across datasets without explicit scope", () => {
  const s = networkSample(),
    state = {
      version: 1 as const,
      config: s.config,
      permittedRestrictions: [],
      demands: s.demands,
    },
    r = assignDemand(
      integrationIndex(state, s.projects, s.links),
      s.demands,
      s.config,
    );
  const o = observation({
    kind: "load",
    timetableId: "weekday",
    trainId: "same-id",
    segmentIndex: 0,
    value: 25,
  });
  expect(evaluateTrainObservations(r, [o], "period").count).toBe(0);
  expect(
    evaluateTrainObservations(r, [{ ...o, datasetId: "fiction-bus" }], "period")
      .mae,
  ).toBe(0);
  expect(
    evaluateTrainObservations(
      r,
      [{ ...o, datasetId: "fiction-bus", startSeconds: 0, endSeconds: 900 }],
      "period",
    ).count,
  ).toBe(0);
});
it("offers parameter sensitivity without measured data or changing saved city and demand settings", () => {
  const p = sampleProject(),
    before = JSON.stringify(p);
  const rows = sensitivityAnalysis(p, "weekday", {
    ...defaultAssignmentConfig(),
    maxTransfers: 0,
  });
  expect(rows).toHaveLength(9);
  expect(rows.every((r) => !r.error)).toBe(true);
  expect(
    rows.find((r) => r.label.includes("通勤発生"))!.demand!,
  ).toBeGreaterThan(rows[0].demand!);
  expect(JSON.stringify(p)).toBe(before);
});
