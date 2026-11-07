import { sampleProject } from "./sample";
import type { Project } from "./model";
import type { TransferLink } from "./routing-model";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "./assignment-model";
export function networkSample() {
  const project = (id: string, name: string): Project => {
    const p = sampleProject();
    p.datasetId = id;
    p.name = name;
    p.stations = p.stations.slice(0, 3).map((s, i) => ({
      ...s,
      id: "s" + i,
      name: i === 1 ? "乗換中央" : `${name}${i + 1}`,
    }));
    p.costs = {};
    p.timetables = [{ id: "weekday", name: "架空平日", trains: [] }];
    return p;
  };
  const rail = project("fiction-rail", "架空鉄道"),
    bus = project("fiction-bus", "架空バス");
  rail.timetables[0].trains = [
    {
      id: "same-id",
      number: "101",
      typeId: "local",
      direction: "down",
      capacity: 80,
      stops: [
        { stationId: "s0", status: "stop", departure: 25800 },
        { stationId: "s1", status: "stop", arrival: 26400 },
        { stationId: "s2", status: "stop", arrival: 27000 },
      ],
    },
  ];
  bus.timetables[0].trains = [
    {
      id: "same-id",
      number: "101",
      typeId: "local",
      direction: "down",
      capacity: 25,
      stops: [
        { stationId: "s1", status: "stop", departure: 26760 },
        { stationId: "s2", status: "stop", arrival: 27600 },
      ],
    },
    {
      id: "later",
      number: "102",
      typeId: "local",
      direction: "down",
      capacity: 50,
      stops: [
        { stationId: "s1", status: "stop", departure: 27600 },
        { stationId: "s2", status: "stop", arrival: 28200 },
      ],
    },
  ];
  const links: TransferLink[] = [
    {
      id: "fiction-walk",
      from: { datasetId: rail.datasetId!, stationId: "s1" },
      to: { datasetId: bus.datasetId!, stationId: "s1" },
      walkingSeconds: 180,
      additionalTransferSeconds: 60,
      direction: "forward",
      enabled: true,
      basis: "架空ネットワークの明示設定。琴町線・堀電バスの実接続ではない",
    },
  ];
  const config = {
    ...defaultAssignmentConfig(),
    start: 25200,
    end: 26100,
    simulationEnd: 28800,
    capacityConstrained: true,
    integer: true,
    minimumTransferSeconds: 60,
    arrivalModel: {
      mode: "minute" as const,
      distribution: "uniform" as const,
      stepSeconds: 60,
    },
    serviceMapping: {
      group: "架空平日",
      basis: "サンプル作成者が明示した対応。実カレンダーを推測しない",
      members: [rail, bus].map((p) => ({
        datasetId: p.datasetId!,
        timetableId: "weekday",
        group: "架空平日",
      })),
    },
  };
  const demands: AssignmentDemand[] = [
    {
      datasetId: rail.datasetId!,
      origin: "s0",
      destinationDatasetId: bus.datasetId!,
      destination: "s2",
      purpose: "commute",
      kind: "outbound",
      source: "manual",
      start: 25200,
      end: 26100,
      passengers: 60,
    },
  ];
  return { projects: [rail, bus], links, config, demands };
}
