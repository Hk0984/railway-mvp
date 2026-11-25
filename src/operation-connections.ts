import { trainVisits } from "./analysis";
import type {
  Project,
  StationOperation,
  Stop,
  Timetable,
  Train,
} from "./model";
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

  // Invalid times obscure the stay on the tracks involved. A missing track
  // also makes the other tracks at this station possible.
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
    const tracks = new Set([stop.track, ...moves.map(({ track }) => track)]);
    const start = Math.min(...known);
    const end = Math.max(...known);
    return (tracks.has(undefined) ? [undefined] : [...tracks]).map((track) => ({
      track,
      start,
      end,
    }));
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

export interface FormationConnection {
  from: Train;
  fromIndex: number;
  to: Train;
  toIndex: number;
  kind: "couple" | "split";
  operation: StationOperation;
}

type FormationPoint = {
  train: Train;
  index: number;
  time: number;
  referenceTime?: number;
  track: string;
};

function connectionTime(op: StationOperation, dayStart: number) {
  const syntax =
    op.phase === "after" ? /^5\/(\d*)\$[0-3]$/ : /^5\/(\d*)\$[^$]*$/;
  const timeField = syntax.exec(op.raw)?.[1];
  return timeField === undefined ? NaN : operationTime(timeField, dayStart);
}

const formationConnections = new WeakMap<
  Project,
  Map<Timetable, FormationConnection[]>
>();

export function passengerFormationConnections(
  project: Project,
  timetable: Timetable,
) {
  if (project.oud2?.fileType !== "OuDiaSecond.1.17") return [];
  const cached =
    formationConnections.get(project) ??
    new Map<Timetable, FormationConnection[]>();
  formationConnections.set(project, cached);
  const known = cached.get(timetable);
  if (known) return known;
  const dayStart = project.oud2.serviceDayStart;
  type Endpoint = FormationPoint & { side: "before" | "after" };
  type Work = FormationPoint & {
    kind: FormationConnection["kind"];
    operation: StationOperation;
  };
  type Station = {
    stays: (TrackStay & { train: Train })[];
    endpoints: Endpoint[];
    works: Work[];
  };
  const stations = new Map<string, Station>();
  for (const train of timetable.trains) {
    if (train.cancelled) continue;
    const visits = trainVisits(train);
    if (visits.length < 2) continue;
    const visitIndices = new Map(
      visits.flatMap((visit, i) =>
        (visit.sourcePositionIds ?? []).map((id) => [id, i] as const),
      ),
    );
    const operations = new Map<string, StationOperation[]>();
    const shuntingVisits = new Set<number | undefined>();
    for (const op of train.operations ?? []) {
      const list = operations.get(op.positionId) ?? [];
      list.push(op);
      operations.set(op.positionId, list);
      if (op.code === 0) shuntingVisits.add(visitIndices.get(op.positionId));
    }
    for (const stop of train.stops) {
      const index = visitIndices.get(stop.positionId ?? "");
      if (
        stop.status === "none" ||
        index === undefined ||
        (stop.arrival === undefined && stop.departure === undefined)
      )
        continue;
      const station = stations.get(stop.stationId) ?? {
        stays: [],
        endpoints: [],
        works: [],
      };
      stations.set(stop.stationId, station);
      const ops = operations.get(stop.positionId!) ?? [];
      const first = index === 0;
      const last = index === visits.length - 1;
      for (const stay of trackStays(stop, ops, first, last, dayStart))
        station.stays.push({ ...stay, train });
      // The file has no passenger-carrying flag for a shunt. Match same-platform connections only.
      if (!stop.track || shuntingVisits.has(index)) continue;
      const point = { train, index, track: stop.track };
      for (const op of ops) {
        if (
          op.code === 5 &&
          stop.status === "stop" &&
          (op.phase === "before" ? first : last) &&
          ops.filter((work) => work.phase === op.phase).length === 1
        ) {
          const time = op.phase === "before" ? stop.departure : stop.arrival;
          const referenceTime = connectionTime(op, dayStart);
          if (time !== undefined && !Number.isNaN(referenceTime))
            station.endpoints.push({
              ...point,
              side: op.phase,
              time,
              referenceTime,
            });
        }
        if (
          (op.code !== 1 && op.code !== 2) ||
          op.children?.length !== 1 ||
          op.children[0].code !== 5
        )
          continue;
        const kind = op.code === 1 ? "couple" : "split";
        const syntax =
          kind === "couple"
            ? /^1\/[01]\$(\d*)$/
            : /^2\/[0-2]\$(?:[1-9]|10)\/(\d*)$/;
        const time = operationTime(syntax.exec(op.raw)?.[1] ?? "", dayStart);
        const referenceTime = connectionTime(op.children[0], dayStart);
        if (
          time === undefined ||
          Number.isNaN(time) ||
          Number.isNaN(referenceTime) ||
          (stop.arrival !== undefined && time < stop.arrival) ||
          (stop.departure !== undefined && time > stop.departure) ||
          (kind === "couple"
            ? last || stop.departure === undefined
            : first || stop.arrival === undefined)
        )
          continue;
        station.works.push({
          ...point,
          kind,
          time,
          referenceTime,
          operation: op,
        });
      }
    }
  }
  const links: FormationConnection[] = [];
  for (const { stays, endpoints, works } of stations.values()) {
    const matches = new Map<Work, Endpoint[]>();
    const endpointMatches = new Map<Endpoint, number>();
    for (const work of works) {
      const join = work.kind === "couple";
      const candidates = endpoints.filter((end) => {
        if (
          end.side !== (join ? "after" : "before") ||
          end.train === work.train ||
          end.train.direction !== work.train.direction ||
          end.track !== work.track
        )
          return false;
        const start = join ? end.time : work.time;
        const finish = join ? work.time : end.time;
        return (
          start <= finish &&
          [work.referenceTime, end.referenceTime].every(
            (time) => time === undefined || (start <= time && time <= finish),
          ) &&
          !stays.some(
            (stay) =>
              stay.train !== work.train &&
              stay.train !== end.train &&
              (stay.track === undefined || stay.track === work.track) &&
              stay.start <= finish &&
              start <= stay.end,
          )
        );
      });
      matches.set(work, candidates);
      for (const end of candidates)
        endpointMatches.set(end, (endpointMatches.get(end) ?? 0) + 1);
    }
    for (const [work, candidates] of matches) {
      if (candidates.length !== 1 || endpointMatches.get(candidates[0]) !== 1)
        continue;
      const endpoint = candidates[0];
      const [from, to] =
        work.kind === "couple" ? [endpoint, work] : [work, endpoint];
      links.push({
        from: from.train,
        fromIndex: from.index,
        to: to.train,
        toIndex: to.index,
        kind: work.kind,
        operation: work.operation,
      });
    }
  }
  cached.set(timetable, links);
  return links;
}
