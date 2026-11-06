import type { Project, Purpose } from "./model";
import { expectedWait } from "./analysis";
import type { StationRef, Journey } from "./routing-model";
/** Demand is read, never regenerated when a timetable or route option changes. */
export function compareODService(
  project: Project,
  origin: StationRef,
  destination: StationRef,
  start: number,
  end: number,
  journeys: Journey[],
  purpose?: Purpose,
) {
  if (!(end > start)) throw new Error("需給評価の時間窓不正");
  const state = project.temporal;
  if (
    !state ||
    origin.datasetId !== destination.datasetId ||
    origin.datasetId !== project.datasetId
  )
    return null;
  const matches = (r: {
    origin: string;
    destination: string;
    purpose: Purpose;
  }) =>
    r.origin === origin.stationId &&
    r.destination === destination.stationId &&
    (!purpose || r.purpose === purpose);
  const daily = state.daily.filter(matches),
    slots = state.slots.filter(matches);
  let hourly = 0,
    available = 0,
    waitNumerator = 0;
  const sources = { estimated: 0, observed: 0, manual: 0 };
  for (const slot of slots) {
    const a = Math.max(start, slot.start),
      b = Math.min(end, slot.end);
    if (!(b > a)) continue;
    const n = (slot.passengers * (b - a)) / (slot.end - slot.start);
    hourly += n;
    sources[slot.source] += n;
    const w = expectedWait(journeys, a, b);
    available += n * w.coverage;
    waitNumerator += n * w.coverage * (w.minutes ?? 0);
  }
  return {
    daily: daily.reduce((s, d) => s + d.passengers, 0),
    hourly,
    available,
    unserved: Math.max(0, hourly - available),
    expectedWaitMinutes: available ? waitNumerator / available : null,
    sources,
    assumption:
      "各需要時間枠内で一様到着。最速到着を選択。容量・混雑・列車への配分は未計算",
  };
}
