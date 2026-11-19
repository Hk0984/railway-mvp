import { aggregateTrainLoads } from "./assignment";
import type {
  AssignmentConfig,
  AssignmentDemand,
  DiagramAssignment,
} from "./assignment-model";
import { demandMass, hourlyDemandCurve } from "./hourly-demand-curve";
import { arrivalHourCount, arrivalHourIndex } from "./line-demand";
import { lineAssignmentProfile } from "./line-assignment-profile";
import { buildRoutingIndex, type RoutingIndex } from "./routing";
import type { Journey, JourneyLeg } from "./routing-model";
import type { Direction, Train } from "./model";

function reversedProfile(index: RoutingIndex, mirror: number) {
  const selection = index.selections[0];
  const trains: Train[] = [];
  for (const { train, visits } of index.trips.values()) {
    trains.push({
      ...train,
      stops: visits
        .slice()
        .reverse()
        .map((s) => ({
          ...s,
          arrival: s.departure === undefined ? undefined : mirror - s.departure,
          departure: s.arrival === undefined ? undefined : mirror - s.arrival,
          pickupAllowed: s.dropoffAllowed,
          dropoffAllowed: s.pickupAllowed,
        })),
    });
  }
  const dia = selection.project.timetables.find(
    (d) => d.id === selection.timetableId,
  )!;
  const reversed = buildRoutingIndex(
    [
      {
        ...selection,
        project: { ...selection.project, timetables: [{ ...dia, trains }] },
      },
    ],
    [],
    { includeBoundaryBoards: true },
  );
  return lineAssignmentProfile(reversed);
}

function forwardLegs(
  index: RoutingIndex,
  journey: Journey,
  mirror: number,
): JourneyLeg[] {
  return journey.legs
    .slice()
    .reverse()
    .map((leg) => {
      const key = JSON.stringify([leg.datasetId, leg.timetableId, leg.trainId]);
      const count = index.trips.get(key)!.visits.length;
      return {
        ...leg,
        origin: leg.destination,
        destination: leg.origin,
        departure: mirror - leg.arrival,
        arrival: mirror - leg.departure,
        boardIndex: count - 1 - leg.alightIndex,
        alightIndex: count - 1 - leg.boardIndex,
      };
    });
}

/** Assign each part of the hourly demand curve to the closest arrival in that hour. */
export function assignDestinationArrivals(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
  onProgress?: (done: number, total: number) => void,
  smoothedShares?: Record<Direction, number[]>,
): DiagramAssignment {
  if (
    index.selections.length !== 1 ||
    config.maxTransfers > 1 ||
    config.capacityConstrained ||
    config.integer ||
    config.method !== "fastest"
  )
    throw new Error(
      "目的地到着時刻での配分は、単一路線・乗換1回までの推計に対応します",
    );
  const began = performance.now();
  let mirror = config.end;
  for (const { visits } of index.trips.values())
    for (const stop of visits)
      mirror = Math.max(mirror, stop.arrival ?? 0, stop.departure ?? 0);
  const profile = reversedProfile(index, mirror);
  const curves = smoothedShares && {
    up: hourlyDemandCurve(smoothedShares.up, true),
    down: hourlyDemandCurve(smoothedShares.down, true),
  };
  const groups = new Map<string, AssignmentDemand[]>();
  let input = 0;
  for (const row of rows) {
    if (
      (row.arrivalDirection !== "up" && row.arrivalDirection !== "down") ||
      row.datasetId !== index.selections[0].datasetId ||
      (row.destinationDatasetId &&
        row.destinationDatasetId !== row.datasetId) ||
      !Number.isFinite(row.start) ||
      !Number.isFinite(row.end) ||
      row.start < config.start ||
      row.end > config.end ||
      row.end <= row.start ||
      !Number.isFinite(row.passengers) ||
      row.passengers < 0
    )
      throw new Error("目的地到着需要の配分条件を確認してください");
    if (!row.passengers) continue;
    input += row.passengers;
    const key = JSON.stringify([
      row.origin,
      row.destination,
      row.arrivalDirection,
      row.boundaryOriginTrains,
      row.boundaryDestinationTrains,
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const hourlyArrivals = {
    up: Array<number>(arrivalHourCount).fill(0),
    down: Array<number>(arrivalHourCount).fill(0),
  };
  const journeys: Record<string, Pick<Journey, "legs">> = Object.create(null);
  const allocations = new Map<
    string,
    { journeyId: string; passengers: number }
  >();
  let assigned = 0;
  let unassigned = 0;
  let boardingEvents = 0;
  let done = 0;
  for (const group of groups.values()) {
    const row = group[0];
    const direction = row.arrivalDirection!;
    // An earliest-arrival search on reversed trips gives a latest-departure
    // itinerary for each usable destination arrival in the forward timetable.
    const offerings = profile(
      {
        origin: { datasetId: row.datasetId, stationId: row.destination },
        destination: { datasetId: row.datasetId, stationId: row.origin },
        boundaryOriginTrains: row.boundaryDestinationTrains,
        boundaryDestinationTrains: row.boundaryOriginTrains,
        mode: "depart",
        time: mirror - config.end,
        windowEnd: mirror - config.start,
        maxTransfers: config.maxTransfers,
        minimumTransferSeconds: config.minimumTransferSeconds,
        directOnly: config.maxTransfers === 0,
        sort: "arrival",
      },
      direction,
    )
      .filter((j) => j.elapsedSeconds <= config.maxJourneySeconds)
      .sort(
        (a, b) =>
          b.departure - a.departure ||
          a.arrival - b.arrival ||
          a.transferCount - b.transferCount ||
          a.id.localeCompare(b.id),
      );
    const feasible = offerings
      .filter((j, i) => i === 0 || j.departure !== offerings[i - 1].departure)
      .map((journey) => ({ journey, arrives: mirror - journey.departure }));
    group.forEach(({ start, end, passengers }) => {
      const choices = feasible.filter(
        ({ arrives }) => start <= arrives && arrives < end,
      );
      if (!choices.length) {
        unassigned += passengers;
        return;
      }
      const curve = curves?.[direction][arrivalHourIndex(start)];
      const mass = curve ? demandMass(curve, start, end) : 0;
      let previous = start;
      choices.forEach(({ journey, arrives }, i) => {
        const until =
          i + 1 < choices.length ? (arrives + choices[i + 1].arrives) / 2 : end;
        const fraction =
          curve && mass > 0
            ? demandMass(curve, previous, until) / mass
            : (until - previous) / (end - start);
        const count = passengers * fraction;
        previous = until;
        assigned += count;
        boardingEvents += count * journey.legs.length;
        hourlyArrivals[direction][arrivalHourIndex(arrives)] += count;
        journeys[journey.id] ??= { legs: forwardLegs(index, journey, mirror) };
        const prior = allocations.get(journey.id);
        if (prior) prior.passengers += count;
        else
          allocations.set(journey.id, {
            journeyId: journey.id,
            passengers: count,
          });
      });
    });
    onProgress?.(++done, groups.size);
  }

  return {
    config,
    loads: aggregateTrainLoads(index, {
      journeys,
      allocations: [...allocations.values()],
    }),
    totals: {
      input,
      selected: input,
      outsideWindow: 0,
      assigned,
      unassigned,
      boardingEvents,
    },
    diagnostics: {
      profiles: done,
      warnings: index.warnings,
      milliseconds: performance.now() - began,
      hourlyArrivals,
    },
  };
}
