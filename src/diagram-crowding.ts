import type { TrainLoad } from "./assignment-model";
import { minimumTransferGainSeconds } from "./diagram-continuation";
import { seatedCrowdingLimit } from "./diagram-model";
import type { Journey } from "./routing-model";

const maxCrowdingSeconds = 8 * 60;
const seatedLimit = seatedCrowdingLimit / 100;

export function diagramCrowdingCosts(loads: TrainLoad[]) {
  const times = new Map<string, Float64Array>();
  for (const load of loads) {
    if (
      load.segmentCapacities
        ? load.segmentCapacities.every((c) => c === null)
        : load.capacity === null || load.capacity <= 0
    )
      continue;
    const prefix = new Float64Array(load.stops.length);
    let from = 0;
    for (let to = 1; to < load.stops.length; to++) {
      const stop = load.stops[to];
      const arrival = stop.arrival ?? stop.departure;
      if (arrival === undefined && to < load.stops.length - 1) continue;
      const start = load.stops[from];
      const departure = start.departure ?? start.arrival;
      // Untimed passes share the running time between the recorded endpoints.
      const seconds =
        departure === undefined || arrival === undefined
          ? 0
          : Math.max(0, arrival - departure) / (to - from);
      for (let i = from; i < to; i++) {
        const standingBurden = Math.max(
          0,
          (load.occupancies[i] ?? 0) - seatedLimit,
        );
        prefix[i + 1] = prefix[i] + seconds * 0.45 * standingBurden;
      }
      from = to;
    }
    times.set(load.key, prefix);
  }
  const range = (
    key: string,
    board: number,
    alight: number,
    reversed: boolean,
  ) => {
    const prefix = times.get(key);
    if (!prefix) return null;
    const first = reversed ? prefix.length - 1 - alight : board;
    const last = reversed ? prefix.length - 1 - board : alight;
    return Math.min(maxCrowdingSeconds, prefix[last] - prefix[first]);
  };
  const forwardCache = new WeakMap<Pick<Journey, "legs">, number | null>();
  const reverseCache = new WeakMap<Pick<Journey, "legs">, number | null>();
  const journeyCost = (journey: Pick<Journey, "legs">, reversed = false) => {
    const cache = reversed ? reverseCache : forwardCache;
    const cached = cache.get(journey);
    if (cached !== undefined) return cached;
    let seconds = 0;
    for (const leg of journey.legs) {
      const value = range(
        JSON.stringify([leg.datasetId, leg.timetableId, leg.trainId]),
        leg.boardIndex,
        leg.alightIndex,
        reversed,
      );
      if (value === null) {
        cache.set(journey, null);
        return null;
      }
      seconds += value;
    }
    const total = Math.min(maxCrowdingSeconds, seconds);
    cache.set(journey, total);
    return total;
  };
  return { journeyCost, range, maxSeconds: maxCrowdingSeconds };
}

export type DiagramCrowdingCosts = ReturnType<typeof diagramCrowdingCosts>;

export function lessCrowdedJourney(
  candidates: Journey[],
  timeWinner: Journey,
  costs: DiagramCrowdingCosts,
) {
  const baseline = costs.journeyCost(timeWinner);
  if (baseline === null || baseline === 0) return timeWinner;
  let best = timeWinner;
  let bestScore = timeWinner.arrival + baseline;
  for (const candidate of candidates) {
    const burden = costs.journeyCost(candidate);
    if (
      burden === null ||
      burden >= baseline ||
      candidate.arrival - timeWinner.arrival > maxCrowdingSeconds
    )
      continue;
    const transfers = Math.max(
      0,
      candidate.transferCount - timeWinner.transferCount,
    );
    const score =
      candidate.arrival + burden + transfers * minimumTransferGainSeconds;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
