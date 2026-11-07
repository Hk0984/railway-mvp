import { journeyProfile, type RoutingIndex } from "./routing";
import type { Journey, RouteQuery } from "./routing-model";
interface Cache {
  entries: Map<string, { journeys: Journey[]; weight: number }>;
  weight: number;
}
let profiles = new WeakMap<RoutingIndex, Cache>();
/** Index is an immutable timetable snapshot. Never share candidates between indexes. */
export function cachedProfile(index: RoutingIndex, q: RouteQuery) {
  let cache = profiles.get(index);
  if (!cache) {
    cache = { entries: new Map(), weight: 0 };
    profiles.set(index, cache);
  }
  const key = JSON.stringify(q),
    found = cache.entries.get(key);
  if (found) return found.journeys;
  const result = journeyProfile(index, q),
    weight = result.reduce(
      (s, j) => s + j.legs.reduce((s, l) => s + l.stops.length, 0),
      0,
    );
  if (weight > 50000) return result;
  while (
    cache.entries.size &&
    (cache.entries.size >= 128 || cache.weight + weight > 50000)
  ) {
    const first = cache.entries.keys().next().value!;
    cache.weight -= cache.entries.get(first)!.weight;
    cache.entries.delete(first);
  }
  cache.entries.set(key, { journeys: result, weight });
  cache.weight += weight;
  return result;
}
export function clearAssignmentCache() {
  profiles = new WeakMap();
}
