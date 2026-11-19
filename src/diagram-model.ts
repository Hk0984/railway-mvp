import { trainVisits } from "./analysis";
import type { DiagramAssignment, TrainLoad } from "./assignment-model";
import type { Project, Stop, Train } from "./model";

export const crowdingLimits = [100, 130, 160, 200];
export const crowdingColors = [
  "#158c51",
  "#d7ab00",
  "#ed7c18",
  "#d93042",
  "#903bbe",
];

export function crowdingBand(
  percent: number | null,
  limits: readonly number[],
) {
  if (percent === null || !Number.isFinite(percent) || percent < 0) return -1;
  const index = limits.findIndex((limit) => percent <= limit);
  return index < 0 ? limits.length : index;
}

export interface DiagramTrain {
  train: Train;
  visits: Stop[];
  load?: TrainLoad;
  segments: DiagramSegment[];
}

export interface DiagramSegment {
  service: DiagramTrain;
  from: Stop;
  to: Stop;
  start: number;
  end: number;
  kind: "run" | "dwell" | "gap" | "point";
  outsideWindow: boolean;
  passengers: number | null;
  percent: number | null;
}

export function diagramTrains(
  p: Project,
  diaId: string,
  result?: DiagramAssignment,
) {
  const horizon =
    result?.capacity?.horizon ??
    (result ? result.config.end + result.config.maxJourneySeconds : Infinity);
  const loads = new Map(
    result?.loads
      .filter((l) => l.datasetId === p.datasetId && l.timetableId === diaId)
      .map((l) => [l.trainId, l]),
  );
  return (p.timetables.find((d) => d.id === diaId)?.trains ?? [])
    .filter((t) => !t.cancelled)
    .map((train): DiagramTrain => {
      const visits = trainVisits(train);
      const load = loads.get(train.id);
      const service: DiagramTrain = { train, visits, load, segments: [] };
      function add(
        from: Stop,
        to: Stop,
        start: number,
        end: number,
        kind: DiagramSegment["kind"],
        index?: number,
      ) {
        const outsideWindow =
          kind === "run" &&
          result !== undefined &&
          (start < result.config.start ||
            start > horizon ||
            (index !== undefined && load?.segmentObserved?.[index] === false));
        const matched =
          !outsideWindow &&
          index !== undefined &&
          load &&
          load.stops[index]?.stationId === from.stationId &&
          load.stops[index]?.positionId === from.positionId &&
          load.stops[index]?.departure === from.departure &&
          load.stops[index + 1]?.stationId === to.stationId &&
          load.stops[index + 1]?.positionId === to.positionId &&
          load.stops[index + 1]?.arrival === to.arrival;
        const ratio = matched ? (load.occupancies[index] ?? null) : null;
        service.segments.push({
          service,
          from,
          to,
          start,
          end,
          kind,
          outsideWindow,
          passengers: matched ? (load.segmentLoads[index] ?? null) : null,
          percent: ratio === null ? null : ratio * 100,
        });
      }
      let previous: { stop: Stop; end: number; index: number } | undefined;
      visits.forEach((stop, index) => {
        const arrival = stop.arrival ?? stop.departure;
        const departure = stop.departure ?? stop.arrival;
        if (arrival === undefined || departure === undefined) return;
        if (previous) {
          const adjacent = previous.index === index - 1;
          add(
            previous.stop,
            stop,
            previous.end,
            arrival,
            adjacent ? "run" : "gap",
            adjacent ? previous.index : undefined,
          );
        }
        if (arrival < departure) add(stop, stop, arrival, departure, "dwell");
        previous = { stop, end: departure, index };
      });
      if (!service.segments.length && previous)
        add(previous.stop, previous.stop, previous.end, previous.end, "point");
      return service;
    });
}
