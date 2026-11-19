import { expect, it } from "vitest";
import { diagramRoutes } from "../src/diagram-routes";
import { diagramTrains } from "../src/diagram-model";
import { sampleProject } from "../src/sample";

it("lays out each physical branch with its junction and keeps recorded cross-branch services representable", () => {
  const p = sampleProject();
  p.oud2 = {
    fileType: "OuDiaSecond.1.07",
    serviceDayStart: 0,
    positions: [],
    externalTerminals: [],
    emptyColumns: 0,
    warnings: [],
    links: [
      { from: "s0", to: "s1" },
      { from: "s1", to: "s2" },
      { from: "s2", to: "s3" },
      { from: "s1", to: "s4" },
    ],
  };
  const dia = p.timetables[0];
  const [toBranch, betweenBranches] = dia.trains;
  toBranch.stops = [
    { stationId: "s0", status: "stop", departure: 100 },
    { stationId: "s1", status: "stop", arrival: 200, departure: 210 },
    { stationId: "s2", status: "none" },
    { stationId: "s3", status: "none" },
    { stationId: "s4", status: "stop", arrival: 300 },
  ];
  betweenBranches.stops = [
    { stationId: "s3", status: "stop", departure: 100 },
    { stationId: "s2", status: "pass", departure: 125 },
    { stationId: "s1", status: "stop", arrival: 200, departure: 210 },
    { stationId: "s4", status: "stop", arrival: 300 },
  ];
  dia.trains = [toBranch, betweenBranches];
  const services = diagramTrains(p, dia.id);
  expect(diagramRoutes(p, services)).toEqual([
    ["s0", "s1", "s4"],
    ["s0", "s1", "s2", "s3"],
    ["s3", "s2", "s1", "s4"],
  ]);
  expect(services[0].segments.at(-1)).toMatchObject({
    kind: "run",
    from: { stationId: "s1" },
    to: { stationId: "s4" },
  });
});
