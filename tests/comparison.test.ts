import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { buildScenario, projectForScenario } from "../src/scenarios";
import { compareTimetables } from "../src/comparison";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
it("compares saved capacity scenarios without mutating common capacity or frozen demand", () => {
  const p = sampleProject();
  const a = buildScenario(p, "A", "automatic", ""),
    b = structuredClone(a);
  a.capacityOverride = { value: 50, kind: "transport", basis: "scenario A" };
  b.capacityOverride = { value: 100, kind: "transport", basis: "scenario B" };
  const before = projectForScenario(p, a),
    after = projectForScenario(p, b);
  const input: AssignmentDemand[] = [
    {
      datasetId: p.datasetId!,
      origin: "s0",
      destination: "s4",
      start: 25200,
      end: 25260,
      purpose: "commute",
      kind: "outbound",
      source: "manual",
      passengers: 120,
    },
  ];
  const result = compareTimetables(
    before,
    input,
    "weekday",
    "weekday",
    {
      ...defaultAssignmentConfig(),
      capacityConstrained: true,
      maxTransfers: 0,
      start: 25200,
      end: 25260,
    },
    "s0",
    "s4",
    input,
    after,
  );
  expect(
    result.before
      .capacity!.loads.filter((l) => l.peakLoad > 0)
      .every((l) => l.capacity === 50),
  ).toBe(true);
  expect(
    result.after
      .capacity!.loads.filter((l) => l.peakLoad > 0)
      .every((l) => l.capacity === 100),
  ).toBe(true);
  expect(p.timetables[0].trains[0].capacity).toBe(600);
  expect(p.capacitySettings).toBeUndefined();
});
it("compares timetables with identical frozen OD and shows capacity/service differences", () => {
  const p = sampleProject();
  const make = (id: string, departure: number) => ({
    id,
    number: id,
    typeId: "local",
    direction: "down" as const,
    capacity: 50,
    stops: [
      { stationId: "s0", status: "stop" as const, departure },
      { stationId: "s4", status: "stop" as const, arrival: departure + 600 },
    ],
  });
  p.timetables = [
    { id: "before", name: "before", trains: [make("a", 27000)] },
    {
      id: "after",
      name: "after",
      trains: [make("a", 27000), make("b", 27300)],
    },
  ];
  const input: AssignmentDemand[] = [
      {
        datasetId: p.datasetId!,
        origin: "s0",
        destination: "s4",
        start: 25200,
        end: 25260,
        purpose: "commute",
        kind: "outbound",
        source: "manual",
        passengers: 80,
      },
    ],
    snapshot = JSON.stringify(input);
  const c = {
    ...defaultAssignmentConfig(),
    start: 25200,
    end: 25260,
    capacityConstrained: true,
  };
  const result = compareTimetables(p, input, "before", "after", c, "s0", "s4");
  expect(result.fixedDemand).toBe(true);
  expect(result.before.capacity!.totals.completed).toBe(50);
  expect(result.after.capacity!.totals.completed).toBe(80);
  expect(result.rows.find((r) => r.label === "全運行本数")!.difference).toBe(1);
  expect(JSON.stringify(input)).toBe(snapshot);
  expect(result.before.input).toEqual(result.after.input);
});
it("distinguishes changed-demand scenarios from fixed-demand revisions and rejects foreign IDs", () => {
  const p = sampleProject();
  const input: AssignmentDemand[] = [
    {
      datasetId: p.datasetId!,
      origin: "s0",
      destination: "s4",
      start: 25200,
      end: 28800,
      purpose: "commute",
      kind: "outbound",
      source: "manual",
      passengers: 80,
    },
  ];
  const c = { ...defaultAssignmentConfig(), maxTransfers: 0 };
  const r = compareTimetables(
    p,
    input,
    "weekday",
    "weekday",
    c,
    "s0",
    "s4",
    input.map((d) => ({ ...d, passengers: 160 })),
  );
  expect(r.fixedDemand).toBe(false);
  expect(r.after.totals.selected).toBe(r.before.totals.selected * 2);
  expect(() =>
    compareTimetables(p, input, "weekday", "unknown", c, "s0", "s4"),
  ).toThrow("一致");
  expect(() =>
    compareTimetables(
      p,
      input.map((d) => ({ ...d, datasetId: "other" })),
      "weekday",
      "weekday",
      c,
      "s0",
      "s4",
    ),
  ).toThrow("一致");
});
