import { sampleProject } from "../src/sample";
import type { Project } from "../src/model";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
export function benchmarkData(
  stations: number,
  trains: number,
  count: number,
  pattern: "repeated" | "sparse",
) {
  const p = sampleProject();
  p.datasetId = "sparse-benchmark";
  p.stations = Array.from({ length: stations }, (_, i) => ({
    ...p.stations[i % 5],
    id: "s" + i,
    name: "検証駅" + i,
  }));
  p.timetables = [
    {
      id: "weekday",
      name: "架空平日",
      trains: Array.from({ length: trains }, (_, i) => {
        const direction = i % 2 ? ("up" as const) : ("down" as const),
          order = Array.from({ length: stations }, (_, j) =>
            direction === "down" ? j : stations - 1 - j,
          ),
          start = 23400 + Math.floor(i / 2) * 180;
        return {
          id: "t" + i,
          number: "" + i,
          typeId: "local",
          direction,
          capacity: 100,
          stops: order.map((id, j) => ({
            stationId: "s" + id,
            status: "stop" as const,
            arrival: j ? start + j * 30 : undefined,
            departure:
              j < stations - 1 ? start + j * 30 + (j ? 5 : 0) : undefined,
          })),
        };
      }),
    },
  ];
  p.costs = {};
  const demands: AssignmentDemand[] = Array.from({ length: count }, (_, i) => {
    const code =
        pattern === "repeated"
          ? i % Math.min(8, stations * (stations - 1))
          : (i * 37) % (stations * (stations - 1)),
      origin = Math.floor(code / (stations - 1));
    let destination = code % (stations - 1);
    if (destination >= origin) destination++;
    return {
      datasetId: p.datasetId!,
      origin: "s" + origin,
      destination: "s" + destination,
      purpose: i % 2 ? "commute" : "school",
      kind: "outbound",
      source: "manual",
      start: 23400,
      end: 24300,
      passengers: i % 7 ? 10 : 0,
    };
  });
  return {
    project: p,
    demands,
    config: {
      ...defaultAssignmentConfig(),
      start: 23400,
      end: 24300,
      maxTransfers: 0,
      maxWaitSeconds: 7200,
    },
    window: "06:30–06:45; max initial wait 120min",
  };
}
