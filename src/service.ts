import { directTrains, expectedWait, headways } from "./analysis";
import { journeyProfile, type RoutingIndex } from "./routing";
import { stationKey, type Journey, type RouteQuery } from "./routing-model";
export function effectiveJourneyDepartures(journeys: Journey[]) {
  const grouped = new Map<number, Journey>();
  for (const j of journeys) {
    const current = grouped.get(j.departure);
    if (
      !current ||
      j.arrival < current.arrival ||
      (j.arrival === current.arrival && j.transferCount < current.transferCount)
    )
      grouped.set(j.departure, j);
  }
  const desc = [...grouped.values()].sort((a, b) => b.departure - a.departure);
  let best = Infinity;
  return desc
    .filter((j) => {
      const effective = j.arrival < best;
      best = Math.min(best, j.arrival);
      return effective;
    })
    .reverse();
}
/** Unique earliest-arrival opportunity per FIRST departure instant, not number of combinatorial itineraries. */
export function analyzeService(
  index: RoutingIndex,
  q: RouteQuery,
  start: number,
  end: number,
) {
  if (!(end > start)) throw new Error("集計窓の終了は開始より後にしてください");
  const all = journeyProfile(index, {
    ...q,
    mode: "depart",
    time: start,
    windowStart: undefined,
    windowEnd: undefined,
  });
  const effective = effectiveJourneyDepartures(all);
  const departures = effective.filter(
    (j) => j.departure >= start && j.departure < end,
  );
  let direct: ReturnType<typeof directTrains> = [];
  if (q.origin.datasetId === q.destination.datasetId) {
    const s = index.selections.find((s) => s.datasetId === q.origin.datasetId);
    if (s) {
      const dia = s.project.timetables.find((d) => d.id === s.timetableId)!;
      const filtered = {
        ...dia,
        trains: dia.trains.filter((t) =>
          index.trips.has(JSON.stringify([s.datasetId, s.timetableId, t.id])),
        ),
      };
      direct = directTrains(
        filtered,
        q.origin.stationId,
        q.destination.stationId,
      );
    }
  }
  const directWindow = direct.filter(
      (r) => r.departure >= start && r.departure < end,
    ),
    directEffective = directWindow.filter((r) => r.effective);
  return {
    allJourneys: all,
    directCount: directWindow.length,
    directEffectiveCount: directEffective.length,
    directDepartures: directEffective.map((r) => r.departure),
    directHeadways: headways(directEffective.map((r) => r.departure)),
    directWait: expectedWait(direct, start, end),
    journeyCount: departures.length,
    journeyDepartures: departures.map((j) => j.departure),
    journeyHeadways: headways(departures.map((j) => j.departure)),
    journeyWait: expectedWait(all, start, end),
    fastest:
      all.sort(
        (a, b) => a.arrival - b.arrival || b.departure - a.departure,
      )[0] ?? null,
    journeys: departures,
  };
}
