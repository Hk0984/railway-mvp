import { aggregateTrainLoads } from "./assignment";
import type {
  AssignmentConfig,
  AssignmentDemand,
  DiagramAssignment,
} from "./assignment-model";
import { minimumTransferGainSeconds } from "./diagram-continuation";
import { demandMass, hourlyDemandCurve } from "./hourly-demand-curve";
import { summarizeDiagramTransfers } from "./diagram-transfers";
import { arrivalHourCount, arrivalHourIndex } from "./line-demand";
import { lineAssignmentProfile } from "./line-assignment-profile";
import {
  buildRoutingIndex,
  type Board,
  type RoutingIndex,
  type Trip,
} from "./routing";
import { stationKey, type Journey, type JourneyLeg } from "./routing-model";
import type { Direction, Train } from "./model";

function reverseRoutingIndex(index: RoutingIndex, mirror: number) {
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
  return buildRoutingIndex(
    [
      {
        ...selection,
        project: { ...selection.project, timetables: [{ ...dia, trains }] },
      },
    ],
    [],
    { includeBoundaryBoards: true },
  );
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

type PlannedArrival = (
  row: AssignmentDemand,
  count: number,
  journey?: { id: string; legs: JourneyLeg[] },
) => void;

/** Assign each part of the hourly demand curve to the closest arrival in that hour. */
export function assignDestinationArrivals(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
  onProgress?: (done: number, total: number) => void,
  smoothedShares?: Record<Direction, number[]>,
  onPlan?: PlannedArrival,
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
  const reversed = reverseRoutingIndex(index, mirror);
  const profile = lineAssignmentProfile(reversed);
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
    const destination = {
      datasetId: row.datasetId,
      stationId: row.destination,
    };
    const through = new Map<Trip, Board[]>();
    const allowed =
      row.boundaryDestinationTrains && new Set(row.boundaryDestinationTrains);
    const destinationBoards =
      (allowed ? reversed.boundaryBoards : reversed.boards)?.get(
        stationKey(destination),
      ) ?? [];
    for (const board of destinationBoards) {
      if (
        board.trip.train.direction !== direction ||
        (allowed && !allowed.has(board.trip.train.id))
      )
        continue;
      const boards = through.get(board.trip) ?? [];
      boards.push(board);
      through.set(board.trip, boards);
    }

    // An earliest-arrival search on reversed trips gives a latest-departure
    // itinerary for each usable destination arrival in the forward timetable.
    const byWindow = new Map<string, { journey: Journey; arrives: number }[]>();
    group.forEach((demand) => {
      const { start, end, passengers } = demand;
      const key = JSON.stringify([start, end]);
      let choices = byWindow.get(key);
      if (!choices) {
        const after = mirror - end;
        const latestDeparture = mirror - start;
        const offerings = profile(
          {
            origin: destination,
            destination: { datasetId: row.datasetId, stationId: row.origin },
            boundaryOriginTrains: row.boundaryDestinationTrains,
            boundaryDestinationTrains: row.boundaryOriginTrains,
            mode: "depart",
            time: after,
            windowEnd: mirror - config.start,
            maxTransfers: config.maxTransfers,
            minimumTransferSeconds: config.minimumTransferSeconds,
            directOnly: config.maxTransfers === 0,
            sort: "arrival",
          },
          direction,
          undefined,
          {
            latestDeparture,
            allowsTransfer: (first, second) => {
              // The second reverse leg is the train boarded first in forward time.
              // Its earlier reverse stops include any later forward drop-off.
              const direct = through.get(second.trip);
              return !direct?.some(
                (board) =>
                  board.index < second.i &&
                  board.departure > after &&
                  board.departure <= latestDeparture &&
                  second.arrival - board.departure <=
                    config.maxJourneySeconds &&
                  first.departure - board.departure <
                    minimumTransferGainSeconds,
              );
            },
          },
        )
          .filter(
            (j) =>
              j.departure > after &&
              j.elapsedSeconds <= config.maxJourneySeconds,
          )
          .sort(
            (a, b) =>
              b.departure - a.departure ||
              a.arrival - b.arrival ||
              a.transferCount - b.transferCount ||
              a.id.localeCompare(b.id),
          );
        choices = offerings
          .filter(
            (j, i) => i === 0 || j.departure !== offerings[i - 1].departure,
          )
          .map((journey) => ({ journey, arrives: mirror - journey.departure }));
        byWindow.set(key, choices);
      }
      if (!choices.length) {
        unassigned += passengers;
        onPlan?.(demand, passengers);
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
        if (count === 0) return;
        assigned += count;
        boardingEvents += count * journey.legs.length;
        hourlyArrivals[direction][arrivalHourIndex(arrives)] += count;
        const plan = (journeys[journey.id] ??= {
          legs: forwardLegs(index, journey, mirror),
        });
        onPlan?.(demand, count, { id: journey.id, legs: plan.legs });
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
    ...(!onPlan && {
      transfers: summarizeDiagramTransfers(
        allocations.values(),
        (a) => journeys[a.journeyId].legs,
      ),
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
