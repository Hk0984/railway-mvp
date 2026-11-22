import { assignDemand, summarizeTrainLoad } from "./assignment";
import type {
  AssignmentConfig,
  AssignmentDemand,
  DiagramAssignment,
  DiagramTransfers,
} from "./assignment-model";
import { simulateCapacity, type CapacityPlan } from "./capacity-assignment";
import { transportCapacity } from "./capacity-model";
import { assignDestinationArrivals } from "./destination-assignment";
import {
  diagramCrowdingCosts,
  lessCrowdedJourney,
  type DiagramCrowdingCosts,
} from "./diagram-crowding";
import { seatedCrowdingLimit } from "./diagram-model";
import { summarizeDiagramTransfers } from "./diagram-transfers";
import { lineAssignmentProfile } from "./line-assignment-profile";
import { preferThroughJourneys } from "./diagram-continuation";
import {
  arrivalHourCount,
  arrivalHourIndex,
  validBoardingLimit,
} from "./line-demand";
import type { Direction } from "./model";
import type { RoutingIndex } from "./routing";
import type { Journey, RouteQuery } from "./routing-model";

type Progress = (done: number, total: number, stage?: "od" | "events") => void;
type DiagramPlan = CapacityPlan & Pick<DiagramAssignment, "loads">;

function destinationPlan(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
  onProgress?: Progress,
  shares?: Record<Direction, number[]>,
  crowding?: DiagramCrowdingCosts,
): DiagramPlan {
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
    crowding,
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
    loads: result.loads,
  };
}

const average = (a: number[], b: number[]) =>
  a.map((value, i) => (value + b[i]) / 2);

function meanResults(
  a: Pick<DiagramAssignment, "totals" | "diagnostics">,
  b: Pick<DiagramAssignment, "totals" | "diagnostics">,
) {
  const hourly = a.diagnostics.hourlyArrivals;
  const otherHourly = b.diagnostics.hourlyArrivals;
  return {
    totals: {
      ...a.totals,
      assigned: (a.totals.assigned + b.totals.assigned) / 2,
      unassigned: (a.totals.unassigned + b.totals.unassigned) / 2,
      boardingEvents: (a.totals.boardingEvents + b.totals.boardingEvents) / 2,
    },
    diagnostics: {
      ...a.diagnostics,
      profiles: a.diagnostics.profiles + b.diagnostics.profiles,
      milliseconds: a.diagnostics.milliseconds + b.diagnostics.milliseconds,
      warnings: [
        ...new Set([...a.diagnostics.warnings, ...b.diagnostics.warnings]),
      ],
      ...(hourly &&
        otherHourly && {
          hourlyArrivals: {
            up: average(hourly.up, otherHourly.up),
            down: average(hourly.down, otherHourly.down),
          },
        }),
      crowdingConsidered: true,
    },
  };
}

function combinePlans(a: DiagramPlan, b: DiagramPlan): DiagramPlan {
  // These fresh plans are owned by this calculation. Reuse their cohorts and
  // allocations instead of cloning the demand again for the capacity simulator.
  for (const cohort of a.cohorts) cohort.passengers /= 2;
  for (const row of a.allocations) row.passengers /= 2;
  for (const row of a.unallocated) row.passengers /= 2;
  for (const cohort of b.cohorts) {
    cohort.id = `comfort:${cohort.id}`;
    cohort.passengers /= 2;
  }
  for (const row of b.allocations) {
    row.cohortId = `comfort:${row.cohortId}`;
    row.passengers /= 2;
  }
  for (const row of b.unallocated) {
    row.cohortId = `comfort:${row.cohortId}`;
    row.passengers /= 2;
  }
  return {
    ...a,
    ...meanResults(a, b),
    journeys: { ...a.journeys, ...b.journeys },
    cohorts: a.cohorts.concat(b.cohorts),
    allocations: a.allocations.concat(b.allocations),
    unallocated: a.unallocated.concat(b.unallocated),
  };
}

function summarizePlan(plan: DiagramPlan): DiagramAssignment {
  return {
    config: plan.config,
    loads: plan.loads,
    transfers: summarizeDiagramTransfers(
      plan.allocations,
      (a) => plan.journeys[a.journeyId].legs,
    ),
    totals: plan.totals,
    diagnostics: plan.diagnostics,
  };
}

function combineSummaries(
  a: DiagramAssignment,
  b: DiagramAssignment,
): DiagramAssignment {
  const otherLoads = new Map(b.loads.map((load) => [load.key, load]));
  const transfers: DiagramTransfers = Object.create(null);
  for (const summary of [a, b]) {
    for (const [train, stations] of Object.entries(summary.transfers ?? {})) {
      const stops = (transfers[train] ??= {});
      for (const [index, transfer] of Object.entries(stations)) {
        const stop = (stops[Number(index)] ??= {
          fromConnection: 0,
          toConnection: 0,
        });
        stop.fromConnection += transfer.fromConnection / 2;
        stop.toConnection += transfer.toConnection / 2;
      }
    }
  }
  return {
    config: a.config,
    ...meanResults(a, b),
    loads: a.loads.map((load) => {
      const other = otherLoads.get(load.key)!;
      return summarizeTrainLoad({
        ...load,
        boardings: average(load.boardings, other.boardings),
        alightings: average(load.alightings, other.alightings),
        uniquePassengers: (load.uniquePassengers + other.uniquePassengers) / 2,
      });
    }),
    transfers,
  };
}

function preparePlan<T extends Pick<DiagramAssignment, "loads">>(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
  considerCrowding: boolean,
  keep: (plan: DiagramPlan) => T,
  combine: (first: T, second: T) => T,
  onProgress?: Progress,
  shares?: Record<Direction, number[]>,
) {
  const arrivalMode = rows.some((r) => r.arrivalDirection !== undefined);
  const profile = lineAssignmentProfile(index, { retainThrough: true });
  const plan = (progress?: Progress, crowding?: DiagramCrowdingCosts) =>
    keep(
      arrivalMode
        ? destinationPlan(index, rows, config, progress, shares, crowding)
        : assignDemand(index, rows, config, progress, profile, (feasible) => {
            const timeChoices = preferThroughJourneys(feasible);
            if (!crowding || timeChoices.length === 0) return timeChoices;
            const fastest = timeChoices.reduce((best, option) =>
              (option.arrival - best.arrival ||
                option.transferCount - best.transferCount) < 0
                ? option
                : best,
            );
            const comfortable = lessCrowdedJourney(feasible, fastest, crowding);
            return comfortable === fastest ? timeChoices : [comfortable];
          }),
    );
  const first = plan(
    considerCrowding
      ? (done, total) => onProgress?.(done, total * 2)
      : onProgress,
  );
  if (
    !considerCrowding ||
    !first.loads.some(
      (load) => (load.peakOccupancy ?? 0) > seatedCrowdingLimit / 100,
    )
  )
    return first;

  // Keep a time-oriented share to limit simultaneous moves to the same train.
  const second = plan(
    (done, total) => onProgress?.(done + total, total * 2),
    diagramCrowdingCosts(first.loads),
  );
  return combine(first, second);
}

function laterProfiles(index: RoutingIndex, config: AssignmentConfig) {
  const profile = lineAssignmentProfile(index, { retainThrough: true });
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
    return preferThroughJourneys(
      journeys.filter(
        (journey) =>
          journey.departure >= q.time && journey.arrival <= q.windowEnd!,
      ),
    );
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
  return assignRailwayDiagram(
    index,
    rows,
    config,
    percent,
    onProgress,
    smoothedShares,
    false,
  );
}

export function assignRailwayDiagram(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
  percent?: number,
  onProgress?: Progress,
  smoothedShares?: Record<Direction, number[]>,
  considerCrowding = true,
): DiagramAssignment {
  if (percent === undefined)
    return preparePlan(
      index,
      rows,
      config,
      considerCrowding,
      summarizePlan,
      combineSummaries,
      onProgress,
      smoothedShares,
    );
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
  const base = preparePlan(
    index,
    rows,
    config,
    considerCrowding,
    (plan) => plan,
    combinePlans,
    onProgress,
    smoothedShares,
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
