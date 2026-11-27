import { trainVisits } from "./analysis";
import { segmentCapacity, type DiagramAssignment, type TrainLoad } from "./assignment-model";
import type { Project, Stop, Train } from "./model";
import { formationProfile } from "./train-formation";

export const seatedCrowdingLimit = 40;
export const crowdingLimits = [100, 130, 160, 200];
export const crowdingColors = [
  "#38bdf8",
  "#158c51",
  "#d7ab00",
  "#ed7c18",
  "#d93042",
  "#903bbe",
];
export const crowdingLabels = [
  "全員着席レベル",
  "比較的余裕あり",
  "やや混雑",
  "混雑",
  "非常に混雑",
  "極度の混雑",
];

export function crowdingRange(band: number, limits: readonly number[]) {
  const high = limits[band - 1];
  if (band === 0) return `${seatedCrowdingLimit}%未満`;
  if (band === 1) return `${seatedCrowdingLimit}〜${high}%`;
  return `${limits[band - 2]}%超${high === undefined ? "" : `〜${high}%`}`;
}

export function crowdingBand(
  percent: number | null,
  limits: readonly number[],
) {
  if (percent === null || !Number.isFinite(percent) || percent < 0) return -1;
  if (percent < seatedCrowdingLimit) return 0;
  const index = limits.findIndex((limit) => percent <= limit);
  return (index < 0 ? limits.length : index) + 1;
}

export interface DiagramTrain {
  train: Train;
  visits: Stop[];
  load?: TrainLoad;
  formation?: ReturnType<typeof formationProfile>;
  segments: DiagramSegment[];
}

export interface DiagramSegment {
  service: DiagramTrain;
  from: Stop;
  to: Stop;
  fromIndex: number;
  toIndex: number;
  start: number;
  end: number;
  kind: "run" | "dwell" | "gap" | "point";
  untimedPasses?: Stop[];
  outsideWindow: boolean;
  passengers: number | null;
  percent: number | null;
}

function matchingRun(
  load: TrainLoad,
  visits: Stop[],
  from: number,
  to: number,
) {
  for (let i = from; i <= to; i++) {
    const recorded = load.stops[i],
      visit = visits[i];
    if (
      !recorded ||
      recorded.stationId !== visit.stationId ||
      recorded.positionId !== visit.positionId ||
      recorded.status !== visit.status ||
      recorded.arrival !== visit.arrival ||
      recorded.departure !== visit.departure
    )
      return false;
    if (
      i > from &&
      i < to &&
      (load.boardings[i] !== 0 || load.alightings[i] !== 0 ||
        segmentCapacity(load, i) !== segmentCapacity(load, from))
    )
      return false;
  }
  return true;
}

export function diagramTrains(
  p: Project,
  diaId: string,
  result?: DiagramAssignment,
  trainIds?: ReadonlySet<string>,
) {
  const destinationTiming = result?.diagnostics?.hourlyArrivals !== undefined;
  const capacityHorizon =
    result?.capacity?.horizon ?? result?.diagnostics?.boardingLimit?.horizon;
  const horizon =
    capacityHorizon ??
    (result
      ? result.config.end +
        (destinationTiming ? 0 : result.config.maxJourneySeconds)
      : Infinity);
  const loads = new Map(
    (result?.capacity?.loads ?? result?.loads)
      ?.filter((l) => l.datasetId === p.datasetId && l.timetableId === diaId)
      .map((l) => [l.trainId, l]),
  );
  return (p.timetables.find((d) => d.id === diaId)?.trains ?? [])
    .filter((t) => !t.cancelled && (!trainIds || trainIds.has(t.id)))
    .map((train): DiagramTrain => {
      const visits = trainVisits(train);
      const load = loads.get(train.id);
      const service: DiagramTrain = { train, visits, load, formation: formationProfile(p, diaId, train, visits), segments: [] };
      function add(
        fromIndex: number,
        toIndex: number,
        start: number,
        end: number,
        kind: DiagramSegment["kind"],
        untimedPasses?: Stop[],
      ) {
        const outsideWindow =
          kind === "run" &&
          result !== undefined &&
          (start < result.config.start ||
            (destinationTiming && capacityHorizon === undefined
              ? start >= horizon
              : start > horizon) ||
            load?.segmentObserved?.[fromIndex] === false ||
            (untimedPasses !== undefined &&
              capacityHorizon !== undefined &&
              end > horizon));
        // An untimed pass has no boarding or alighting. The first leg's load
        // remains valid until the next recorded time without estimating pass times.
        const matched =
          kind === "run" &&
          !outsideWindow &&
          load &&
          matchingRun(load, visits, fromIndex, toIndex);
        const ratio = matched ? (load.occupancies[fromIndex] ?? null) : null;
        service.segments.push({
          service,
          from: visits[fromIndex],
          to: visits[toIndex],
          fromIndex,
          toIndex,
          start,
          end,
          kind,
          ...(untimedPasses && { untimedPasses }),
          outsideWindow,
          passengers: matched ? (load.segmentLoads[fromIndex] ?? null) : null,
          percent: ratio === null ? null : ratio * 100,
        });
      }
      let previous: { end: number; index: number } | undefined;
      visits.forEach((stop, index) => {
        const arrival = stop.arrival ?? stop.departure;
        const departure = stop.departure ?? stop.arrival;
        if (arrival === undefined || departure === undefined) return;
        if (previous) {
          const skipped =
            index > previous.index + 1
              ? visits.slice(previous.index + 1, index)
              : undefined;
          const passOnly =
            skipped?.every((s) => s.status === "pass") &&
            visits[previous.index].stationId !== stop.stationId;
          add(
            previous.index,
            index,
            previous.end,
            arrival,
            !skipped || passOnly ? "run" : "gap",
            passOnly ? skipped : undefined,
          );
        }
        if (arrival < departure) add(index, index, arrival, departure, "dwell");
        previous = { end: departure, index };
      });
      if (!service.segments.length && previous)
        add(
          previous.index,
          previous.index,
          previous.end,
          previous.end,
          "point",
        );
      return service;
    });
}
