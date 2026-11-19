import type { Direction } from "./model";
import { stationKey, type Journey, type RouteQuery } from "./routing-model";
import {
  canAlight,
  journeyFromRides,
  rideKey,
  type Board,
  type Ride,
  type RoutingIndex,
  type Trip,
} from "./routing";

type RidePreference = -1 | 0 | 1;
type Landing = { index: number; arrival: number };
type Offer = {
  first: Ride;
  second?: Ride;
  arrival: number;
  riding: number;
};

const preferences: RidePreference[] = [-1, 0, 1];
const seconds = (ride: Ride) => ride.arrival - ride.departure;
const offerKey = (offer: Offer) =>
  rideKey(offer.first) + (offer.second ? rideKey(offer.second) : "");
function better(a: Offer, b: Offer, preference: RidePreference) {
  return (
    (a.arrival - b.arrival ||
      Number(!!a.second) - Number(!!b.second) ||
      preference * (a.riding - b.riding) ||
      offerKey(a).localeCompare(offerKey(b))) < 0
  );
}
function lowerBound<T>(
  entries: readonly T[],
  time: number,
  at: (x: T) => number,
) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(entries[mid]) < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function destinationIndex(
  index: RoutingIndex,
  destination: string,
  trainIds?: string[],
) {
  const allowed = trainIds && new Set(trainIds);
  const landings = new Map<Trip, Landing[]>();
  for (const trip of index.trips.values()) {
    if (allowed && !allowed.has(trip.train.id)) continue;
    const visits = trip.visits;
    for (
      let j = allowed ? visits.length - 1 : 0;
      j >= 0 && j < visits.length;
      j++
    ) {
      const stop = visits[j];
      if (trip.stationKeys[j] !== destination) continue;
      const arrival = allowed
        ? (stop.arrival ?? stop.departure)
        : canAlight(stop)
          ? stop.arrival
          : undefined;
      if (arrival === undefined) continue;
      const options = landings.get(trip) ?? [];
      options.push({ index: j, arrival });
      landings.set(trip, options);
    }
  }
  const direct = (board: Board): Ride[] => {
    const options = landings.get(board.trip);
    if (!options) return [];
    let earliest = Infinity;
    const rides: Ride[] = [];
    for (const landing of options) {
      if (
        landing.index <= board.index ||
        landing.arrival < board.departure ||
        landing.arrival > earliest
      )
        continue;
      if (landing.arrival < earliest) rides.length = 0;
      earliest = landing.arrival;
      rides.push({
        trip: board.trip,
        i: board.index,
        j: landing.index,
        departure: board.departure,
        arrival: landing.arrival,
      });
    }
    return rides;
  };

  // A reverse pass gives the earliest useful continuation after any ready time.
  // Retain the riding-time extremes and the lexical winner for generalized-cost ties.
  const transfers = new Map<string, { entries: Ride[]; best: Ride[][] }>();
  function next(station: string, ready: number) {
    let list = transfers.get(station);
    if (!list) {
      const entries = (index.boards.get(station) ?? []).flatMap(direct);
      const best: Ride[][] = new Array(entries.length);
      let suffix: (Ride | undefined)[] = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const current = entries[i];
        suffix = preferences.map((preference, j) => {
          const prior = suffix[j];
          if (
            !prior ||
            (current.arrival - prior.arrival ||
              preference * (seconds(current) - seconds(prior)) ||
              rideKey(current).localeCompare(rideKey(prior))) < 0
          )
            return current;
          return prior;
        });
        best[i] = [...new Set(suffix as Ride[])];
      }
      transfers.set(station, (list = { entries, best }));
    }
    return list.best[lowerBound(list.entries, ready, (r) => r.departure)] ?? [];
  }
  return { direct, next };
}

/**
 * Earliest-arrival profiles for a single timetable and at most one same-station
 * transfer. A later arrival from the same first boarding cannot win or become
 * feasible when the earlier arrival is outside the journey-time bound.
 */
export function lineAssignmentProfile(index: RoutingIndex) {
  const destinations = new Map<string, ReturnType<typeof destinationIndex>>();
  return (q: RouteQuery, firstDirection?: Direction): Journey[] => {
    const origin = stationKey(q.origin),
      destination = stationKey(q.destination);
    if (origin === destination) return [];
    const key = JSON.stringify([destination, q.boundaryDestinationTrains]);
    let target = destinations.get(key);
    if (!target) {
      target = destinationIndex(
        index,
        destination,
        q.boundaryDestinationTrains,
      );
      if (destinations.size === 48)
        destinations.delete(destinations.keys().next().value!);
      destinations.set(key, target);
    }
    const allowed = q.boundaryOriginTrains && new Set(q.boundaryOriginTrains);
    const boards =
      (allowed ? index.boundaryBoards : index.boards)?.get(origin) ?? [];
    const latest = q.windowEnd ?? Infinity;
    const profiles: Journey[] = [];
    for (
      let i = lowerBound(boards, q.time, (b) => b.departure);
      i < boards.length;
      i++
    ) {
      const board = boards[i];
      if (board.departure > latest) break;
      if (allowed && !allowed.has(board.trip.train.id)) continue;
      if (firstDirection && board.trip.train.direction !== firstDirection)
        continue;
      const best: (Offer | undefined)[] = [];
      const consider = (offer: Offer) => {
        if (offer.arrival > latest) return;
        for (const [j, preference] of preferences.entries()) {
          const prior = best[j];
          if (!prior || better(offer, prior, preference)) best[j] = offer;
        }
      };
      for (const first of target.direct(board))
        consider({ first, arrival: first.arrival, riding: seconds(first) });
      if (!q.directOnly && q.maxTransfers === 1) {
        const trip = board.trip;
        for (let j = board.index + 1; j < trip.visits.length; j++) {
          const stop = trip.visits[j],
            station = trip.stationKeys[j];
          if (!canAlight(stop) || station === destination) continue;
          const arrival = stop.arrival!;
          if (
            arrival < board.departure ||
            arrival + q.minimumTransferSeconds > (best[0]?.arrival ?? latest)
          )
            continue;
          const first = {
            trip,
            i: board.index,
            j,
            departure: board.departure,
            arrival,
          };
          for (const second of target.next(
            station,
            arrival + q.minimumTransferSeconds,
          )) {
            // Reboarding the same train never improves on riding through.
            if (second.trip === trip) continue;
            consider({
              first,
              second,
              arrival: second.arrival,
              riding: seconds(first) + seconds(second),
            });
          }
        }
      }
      const identities = new Set<string>();
      for (const offer of best) {
        if (!offer) continue;
        const id = offerKey(offer);
        if (identities.has(id)) continue;
        identities.add(id);
        const { first, second } = offer;
        profiles.push(
          second
            ? journeyFromRides(
                [first, second],
                [
                  {
                    from: first.trip.refs[first.j],
                    to: second.trip.refs[second.i],
                    arrival: first.arrival,
                    departure: second.departure,
                    walkingSeconds: 0,
                    waitingSeconds: second.departure - first.arrival,
                    minimumSeconds: q.minimumTransferSeconds,
                    linkIds: [],
                  },
                ],
                id,
              )
            : journeyFromRides([first], [], id),
        );
      }
    }
    return profiles;
  };
}
