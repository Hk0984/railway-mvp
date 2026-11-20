import { assignDemand } from "./assignment";
import type {
  AssignmentConfig,
  AssignmentDemand,
  DiagramAssignment,
} from "./assignment-model";
import { simulateCapacity, type CapacityPlan } from "./capacity-assignment";
import { transportCapacity } from "./capacity-model";
import { assignDestinationArrivals } from "./destination-assignment";
import { summarizeDiagramTransfers } from "./diagram-transfers";
import { lineAssignmentProfile } from "./line-assignment-profile";
import {
  arrivalHourCount,
  arrivalHourIndex,
  validBoardingLimit,
} from "./line-demand";
import type { Direction } from "./model";
import type { RoutingIndex } from "./routing";
import type { Journey, RouteQuery } from "./routing-model";

type Progress = (done: number, total: number, stage?: "od" | "events") => void;

function destinationPlan(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
  onProgress?: Progress,
  shares?: Record<Direction, number[]>,
): CapacityPlan {
  const cohorts: CapacityPlan["cohorts"] = [];
  const journeys: CapacityPlan["journeys"] = Object.create(null);
  const allocations: CapacityPlan["allocations"] = [];
  const unallocated: CapacityPlan["unallocated"] = [];
  const rowIndices = new Map(rows.map((row, i) => [row, i]));
  const result = assignDestinationArrivals(
    index,
    rows,
    config,
    onProgress,
    shares,
    (row, passengers, journey) => {
      const id = String(cohorts.length);
      const arrival = journey?.legs[0].departure ?? row.start;
      cohorts.push({
        id,
        demandIndex: rowIndices.get(row)!,
        passengers,
        start: row.start,
        end: row.end,
        arrival,
      });
      if (journey) {
        journeys[journey.id] ??= { legs: journey.legs };
        allocations.push({
          cohortId: id,
          journeyId: journey.id,
          passengers,
          costMinutes: 0,
          probability: 1,
        });
      } else
        unallocated.push({
          cohortId: id,
          passengers,
          reason: "指定した到着時間帯の便なし",
        });
    },
  );
  return {
    input: rows,
    cohorts,
    journeys,
    allocations,
    unallocated,
    config,
    totals: result.totals,
    diagnostics: result.diagnostics,
  };
}

function laterProfiles(index: RoutingIndex, config: AssignmentConfig) {
  const profile = lineAssignmentProfile(index);
  const cache = new Map<string, Journey[]>();
  return (q: RouteQuery, row: AssignmentDemand) => {
    const key = JSON.stringify([
      q.origin.stationId,
      q.destination.stationId,
      q.maxTransfers,
      q.boundaryOriginTrains,
      q.boundaryDestinationTrains,
      row.arrivalDirection,
    ]);
    let journeys = cache.get(key);
    if (!journeys) {
      journeys = profile(
        {
          ...q,
          time: config.start,
          windowEnd: config.end + config.maxJourneySeconds,
        },
        undefined,
        row.arrivalDirection,
      );
      if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
      cache.set(key, journeys);
    }
    return journeys;
  };
}

export function assignDiagramCapacity(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
  percent: number,
  onProgress?: Progress,
  smoothedShares?: Record<Direction, number[]>,
): DiagramAssignment {
  if (!validBoardingLimit(percent))
    throw new Error("乗車を打ち切る混雑率を確認してください");
  if (
    index.selections.length !== 1 ||
    config.maxTransfers > 1 ||
    [...index.walks.values()].some((links) =>
      links.some((link) => link.ids.length),
    )
  )
    throw new Error("混雑率上限での配分は、単一路線・乗換1回までに対応します");
  const unknown = [...index.trips.values()].filter(
    ({ train, selection }) =>
      transportCapacity(selection.project, selection.timetableId, train.id) ===
      null,
  ).length;
  if (unknown)
    throw new Error(
      `輸送定員が未登録の営業列車が${unknown}本あります。データ設定で輸送定員を登録すると、混雑率上限で計算できます。`,
    );
  const arrivalMode = rows.some((r) => r.arrivalDirection !== undefined);
  const base = arrivalMode
    ? destinationPlan(index, rows, config, onProgress, smoothedShares)
    : assignDemand(
        index,
        rows,
        config,
        onProgress,
        lineAssignmentProfile(index),
      );
  const out = simulateCapacity(index, base, config, onProgress, {
    percent,
    profiles: laterProfiles(index, config),
  });
  const hourlyArrivals = arrivalMode
    ? {
        up: Array<number>(arrivalHourCount).fill(0),
        down: Array<number>(arrivalHourCount).fill(0),
      }
    : undefined;
  let afterServiceDay = 0;
  if (hourlyArrivals) {
    const cohorts = new Map(base.cohorts.map((c) => [c.id, c]));
    for (const packet of out.packets) {
      if (packet.state !== "completed") continue;
      const finalTime = packet.lastArrival!;
      const dir =
        rows[cohorts.get(packet.cohortId)!.demandIndex].arrivalDirection!;
      if (finalTime >= config.end) afterServiceDay += packet.passengers;
      else
        hourlyArrivals[dir][arrivalHourIndex(finalTime)] += packet.passengers;
    }
  }
  return {
    config,
    loads: out.loads,
    transfers: summarizeDiagramTransfers(out.packets, (p) => p.history),
    totals: {
      ...base.totals,
      assigned: out.totals.completed,
      unassigned: out.totals.waiting + out.totals.noPath + out.totals.inTransit,
      boardingEvents: out.loads.reduce(
        (sum, load) => sum + load.totalBoardings,
        0,
      ),
    },
    diagnostics: {
      ...base.diagnostics,
      milliseconds: base.diagnostics.milliseconds + out.milliseconds,
      warnings: out.warnings,
      hourlyArrivals,
      boardingLimit: {
        percent,
        horizon: out.horizon,
        denied: out.totals.deniedUnique,
        waiting: out.totals.waiting,
        afterServiceDay,
      },
    },
  };
}
