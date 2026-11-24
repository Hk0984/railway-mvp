import type { Project, StationOperation, Stop, Train } from "./model";
import { parseOudTime } from "./oud2-text";

interface TrackStay {
  track: string | undefined;
  start: number;
  end: number;
  side?: "before" | "after";
}

function operationTime(raw: string, dayStart: number) {
  try {
    return parseOudTime(raw, dayStart);
  } catch {
    return NaN;
  }
}

function trackStays(
  stop: Stop,
  operations: readonly StationOperation[],
  first: boolean,
  last: boolean,
  dayStart: number,
): TrackStay[] {
  const arrival = stop.arrival ?? stop.departure!;
  const departure = stop.departure ?? arrival;
  const shunts = (side: "before" | "after") =>
    operations
      .filter((op) => op.code === 0 && op.phase === side)
      .map((op) => {
        const [, track, from, to] =
          /^0\/(\d+)\$(\d*)\/(\d*)\$0$/.exec(op.raw) ?? [];
        return {
          track,
          from: operationTime(from, dayStart) ?? NaN,
          to: operationTime(to, dayStart) ?? NaN,
        };
      });
  const before = shunts("before");
  const after = shunts("after");
  const origin = operations[0];
  const terminal = operations.at(-1);
  const incoming =
    first &&
    !last &&
    stop.status === "stop" &&
    stop.departure !== undefined &&
    origin?.phase === "before" &&
    origin.code === 5 &&
    operations.length === before.length + 1
      ? /^5\/(\d*)\$[^$]*$/.exec(origin.raw)
      : null;
  const outgoing =
    last &&
    !first &&
    stop.status === "stop" &&
    stop.arrival !== undefined &&
    terminal?.phase === "after" &&
    terminal.code === 5 &&
    operations.length === after.length + 1
      ? /^5\/(\d*)\$[0-3]$/.exec(terminal.raw)
      : null;

  const stays: TrackStay[] = [
    ...before.map((move, i) => ({
      track: move.track,
      start: i === 0 ? move.from : before[i - 1].to,
      end: move.from,
    })),
    {
      track: stop.track,
      start: before.at(-1)?.to ?? arrival,
      end: after[0]?.from ?? departure,
    },
    ...after.map((move, i) => ({
      track: move.track,
      start: move.to,
      end: after[i + 1]?.from ?? move.to,
    })),
  ];
  if (incoming && stays[0].track !== undefined) {
    stays[0].side = "before";
    stays[0].start = operationTime(incoming[1], dayStart) ?? stays[0].start;
  }
  if (outgoing) {
    const end = stays.at(-1)!;
    if (end.track !== undefined) {
      end.side = "after";
      end.end = operationTime(outgoing[1], dayStart) ?? end.end;
    }
  }

  // An inconsistent move cannot establish which track held the train.
  const moves = [...before, ...after];
  if (
    moves.some(({ from, to }) => !(from <= to)) ||
    !(
      stays[before.length].start <= arrival &&
      departure <= stays[before.length].end
    ) ||
    stays.some(
      ({ start, end }, i) =>
        !(start <= end) || (i > 0 && stays[i - 1].end > start),
    )
  ) {
    const known = [
      arrival,
      departure,
      ...moves.flatMap(({ from, to }) => [from, to]),
    ].filter(Number.isFinite);
    return [
      {
        track: moves.length ? undefined : stop.track,
        start: Math.min(...known),
        end: Math.max(...known),
      },
    ];
  }
  return stays;
}

const predecessors = new WeakMap<Project, ReadonlyMap<Train, Train>>();

export function previousOperationTrain(project: Project, train: Train) {
  if (project.oud2?.fileType !== "OuDiaSecond.1.17") return undefined;
  let links = predecessors.get(project);
  if (!links) {
    links = findPredecessors(project);
    predecessors.set(project, links);
  }
  return links.get(train);
}

function findPredecessors(project: Project) {
  const result = new Map<Train, Train>();
  const dayStart = project.oud2!.serviceDayStart;
  type Stay = TrackStay & { train: Train };
  for (const { trains } of project.timetables) {
    const stations = new Map<string, Map<string | undefined, Stay[]>>();
    for (const train of trains) {
      if (train.cancelled) continue;
      const stops = train.stops.filter((stop) => stop.status !== "none");
      const operations = new Map<string, StationOperation[]>();
      for (const op of train.operations ?? []) {
        const stationOps = operations.get(op.positionId) ?? [];
        stationOps.push(op);
        operations.set(op.positionId, stationOps);
      }
      stops.forEach((stop, i) => {
        if (stop.arrival === undefined && stop.departure === undefined) return;
        const tracks =
          stations.get(stop.stationId) ?? new Map<string | undefined, Stay[]>();
        stations.set(stop.stationId, tracks);
        for (const slot of trackStays(
          stop,
          operations.get(stop.positionId ?? "") ?? [],
          i === 0,
          i === stops.length - 1,
          dayStart,
        )) {
          const stays = tracks.get(slot.track) ?? [];
          stays.push({ ...slot, train });
          tracks.set(slot.track, stays);
        }
      });
    }
    const order = { after: 0, before: 2 };
    for (const tracks of stations.values()) {
      const untracked = tracks.get(undefined) ?? [];
      tracks.delete(undefined);
      for (const stays of tracks.values()) {
        const timeline = [...stays, ...untracked].sort(
          (a, b) =>
            a.start - b.start ||
            (a.side ? order[a.side] : 1) - (b.side ? order[b.side] : 1),
        );
        let earlierEnd = -Infinity;
        for (let i = 1; i < timeline.length; i++) {
          const current = timeline[i];
          const previous = timeline[i - 1];
          if (i > 1) earlierEnd = Math.max(earlierEnd, timeline[i - 2].end);
          if (
            current.side === "before" &&
            previous.side === "after" &&
            current.train !== previous.train &&
            previous.end <= current.start &&
            earlierEnd < previous.start &&
            (timeline[i + 1]?.start ?? Infinity) > current.start
          )
            result.set(current.train, previous.train);
        }
      }
    }
  }
  return result;
}
