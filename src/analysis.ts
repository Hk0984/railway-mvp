import type { Timetable, Train, Stop } from "./model";
/** Merge adjacent active rows only when an explicit branch mapping gave them the same physical ID.
 * Only explicitly present times are used; missing arrivals are never estimated. */
export function trainVisits(train: Train): Stop[] {
  const visits: Stop[] = [];
  for (const stop of train.stops) {
    if (stop.status === "none") continue;
    const previous = visits.at(-1);
    if (previous?.stationId === stop.stationId) {
      if (previous.arrival === undefined && stop.arrival !== undefined)
        previous.dropoffAllowed =
          stop.status === "stop" && stop.dropoffAllowed !== false;
      if (stop.departure !== undefined)
        previous.pickupAllowed =
          stop.status === "stop" && stop.pickupAllowed !== false;
      previous.arrival ??= stop.arrival;
      previous.departure = stop.departure ?? previous.departure;
      previous.sourcePositionIds = [
        ...new Set([
          ...(previous.sourcePositionIds ?? []),
          ...(stop.sourcePositionIds ??
            (stop.positionId ? [stop.positionId] : [])),
        ]),
      ];
      if (stop.status === "stop") previous.status = "stop";
    } else
      visits.push({
        ...stop,
        pickupAllowed: stop.status === "stop" && stop.pickupAllowed !== false,
        dropoffAllowed: stop.status === "stop" && stop.dropoffAllowed !== false,
        sourcePositionIds:
          stop.sourcePositionIds ??
          (stop.positionId ? [stop.positionId] : undefined),
      });
  }
  return visits;
}
export const clock = (s: number) =>
  `${Math.floor(s / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((s % 3600) / 60)
    .toString()
    .padStart(2, "0")}${
    s % 60
      ? ":" +
        Math.floor(s % 60)
          .toString()
          .padStart(2, "0")
      : ""
  }`;
export function headways(departures: number[]) {
  const a = [...departures].sort((a, b) => a - b);
  const gaps = a.slice(1).map((t, i) => (t - a[i]) / 60);
  if (!gaps.length) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    mean,
    median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    max: Math.max(...gaps),
    sd: Math.sqrt(gaps.reduce((s, x) => s + (x - mean) ** 2, 0) / n),
  };
}
export interface Direct {
  train: Train;
  departure: number;
  arrival: number;
  effective: boolean;
}
export function directTrains(
  dia: Timetable,
  origin: string,
  destination: string,
): Direct[] {
  if (origin === destination) return [];
  const result: Direct[] = [];
  for (const train of dia.trains) {
    if (train.cancelled) continue;
    const visits = trainVisits(train);
    const i = visits.findIndex((s) => s.stationId === origin);
    const j = visits.findIndex((s) => s.stationId === destination);
    const a = visits[i],
      b = visits[j];
    if (
      i >= 0 &&
      j > i &&
      a.status === "stop" &&
      b.status === "stop" &&
      a.pickupAllowed !== false &&
      b.dropoffAllowed !== false &&
      a.departure !== undefined &&
      b.arrival !== undefined &&
      b.arrival >= a.departure
    )
      result.push({
        train,
        departure: a.departure,
        arrival: b.arrival,
        effective: true,
      });
  }
  // Scan from later departures; equal departure/arrival duplicates stay equivalent.
  const descending = [...result].sort(
    (a, b) => b.departure - a.departure || a.arrival - b.arrival,
  );
  let laterBest = Infinity;
  for (let i = 0; i < descending.length;) {
    let j = i + 1;
    while (
      j < descending.length &&
      descending[j].departure === descending[i].departure
    )
      j++;
    const groupBest = descending[i].arrival;
    for (let k = i; k < j; k++)
      descending[k].effective =
        descending[k].arrival <= groupBest && descending[k].arrival < laterBest;
    laterBest = Math.min(laterBest, groupBest);
    i = j;
  }
  return result.sort(
    (a, b) => a.departure - b.departure || a.arrival - b.arrival,
  );
}
/** Uniform arrivals on [start,end). Fastest-arrival choice; ties choose latest departure.
 * No service after end is invented. Unserved share is reported, mean is conditional. */
export function expectedWait(
  rows: Pick<Direct, "departure" | "arrival">[],
  start: number,
  end: number,
) {
  if (!(end > start)) throw new Error("時間窓の終了は開始より後にしてください");
  const points = [
    start,
    ...rows.map((r) => r.departure).filter((t) => t > start && t < end),
    end,
  ].sort((a, b) => a - b);
  let served = 0,
    integral = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1],
      mid = (a + b) / 2;
    const best = rows
      .filter((r) => r.departure >= mid)
      .sort((x, y) => x.arrival - y.arrival || y.departure - x.departure)[0];
    if (best) {
      served += b - a;
      integral += (best.departure - (a + b) / 2) * (b - a);
    }
  }
  return {
    minutes: served ? integral / served / 60 : null,
    coverage: served / (end - start),
  };
}
export function stationDepartures(
  dia: Timetable,
  id: string,
  direction: string,
  typeId: string,
  start = 0,
  end = Infinity,
) {
  return dia.trains
    .filter(
      (t) =>
        !t.cancelled &&
        (!direction || t.direction === direction) &&
        (!typeId || t.typeId === typeId),
    )
    .flatMap((t) => {
      const s = trainVisits(t).find((s) => s.stationId === id);
      return s?.status === "stop" &&
        s.pickupAllowed !== false &&
        s.departure !== undefined &&
        s.departure >= start &&
        s.departure < end
        ? [s.departure]
        : [];
    })
    .sort((a, b) => a - b);
}
