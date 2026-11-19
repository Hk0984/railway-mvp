import { trainVisits } from "./analysis";
import type { Stop, Train } from "./model";
import { isPassengerTrain, classificationCounts } from "./classification";
import {
  stationKey,
  type DatasetSelection,
  type Journey,
  type JourneyLeg,
  type JourneyTransfer,
  type RouteQuery,
  type RouteSearchResult,
  type StationRef,
  type TransferLink,
} from "./routing-model";

export interface Trip {
  selection: DatasetSelection;
  train: Train;
  visits: Stop[];
  key: string;
  refs: StationRef[];
  stationKeys: string[];
}
export interface Board {
  id: number;
  trip: Trip;
  index: number;
  departure: number;
}
export interface Ride {
  trip: Trip;
  i: number;
  j: number;
  departure: number;
  arrival: number;
}
interface Walk {
  to: StationRef;
  seconds: number;
  walkingSeconds?: number;
  ids: string[];
}
interface Label {
  key: string;
  station: StationRef;
  arrival: number;
  departure: number;
  riding: number;
  walking: number;
  path: PathNode | null;
  depth: number;
  firstTrip: string;
}
interface PathNode {
  previous: PathNode | null;
  ride: Ride;
  transfer?: JourneyTransfer;
  walkIds: string[];
}
let directRounds = new WeakMap<
  RoutingIndex,
  {
    entries: Map<string, { labels: Map<string, Label[]>; weight: number }>;
    weight: number;
  }
>();
export function clearRoutingProfileCache() {
  directRounds = new WeakMap();
}
export interface RoutingIndex {
  selections: DatasetSelection[];
  boards: Map<string, Board[]>;
  boundaryBoards?: Map<string, Board[]>;
  trips: Map<string, Trip>;
  stations: Set<string>;
  walks: Map<string, Walk[]>;
  warnings: string[];
}
const canBoard = (s: Stop) =>
  s.status === "stop" && s.pickupAllowed !== false && s.departure !== undefined;
export const canAlight = (s: Stop) =>
  s.status === "stop" && s.dropoffAllowed !== false && s.arrival !== undefined;
const tripKey = (datasetId: string, dia: string, train: string) =>
  JSON.stringify([datasetId, dia, train]);
export function validateTransferLinks(
  links: TransferLink[],
  selections: Pick<DatasetSelection, "datasetId" | "project">[],
) {
  const stations = new Set(
    selections.flatMap((s) =>
      s.project.stations.map((t) =>
        stationKey({ datasetId: s.datasetId, stationId: t.id }),
      ),
    ),
  );
  const ids = new Set<string>();
  for (const l of links) {
    if (
      !l.id ||
      ids.has(l.id) ||
      !stations.has(stationKey(l.from)) ||
      !stations.has(stationKey(l.to)) ||
      stationKey(l.from) === stationKey(l.to) ||
      !Number.isFinite(l.walkingSeconds) ||
      l.walkingSeconds < 0 ||
      !["forward", "both"].includes(l.direction) ||
      typeof l.basis !== "string" ||
      !l.basis.trim() ||
      (l.enabled !== undefined && typeof l.enabled !== "boolean") ||
      (l.additionalTransferSeconds !== undefined &&
        (!Number.isFinite(l.additionalTransferSeconds) ||
          l.additionalTransferSeconds < 0)) ||
      (l.restrictions !== undefined &&
        (!Array.isArray(l.restrictions) ||
          l.restrictions.some((x) => typeof x !== "string" || !x.trim())))
    )
      throw new Error("徒歩連絡のID・参照駅・方向・時間・設定根拠が不正です");
    ids.add(l.id);
  }
}
export function buildRoutingIndex(
  selections: DatasetSelection[],
  links: TransferLink[] = [],
  options: {
    permittedRestrictions?: string[];
    includeBoundaryBoards?: boolean;
  } = {},
): RoutingIndex {
  if (
    !selections.length ||
    new Set(selections.map((s) => s.datasetId)).size !== selections.length
  )
    throw new Error("データセットは重複なしで1件以上指定してください");
  const boards = new Map<string, Board[]>(),
    trips = new Map<string, Trip>(),
    stations = new Set<string>(),
    warnings = new Set<string>();
  const boundaryBoards = options.includeBoundaryBoards
    ? new Map<string, Board[]>()
    : undefined;
  let boardId = 0;
  for (const selection of selections) {
    const { datasetId, project, timetableId } = selection;
    const dia = project.timetables.find((d) => d.id === timetableId);
    if (!dia) throw new Error("指定ダイヤがありません");
    project.stations.forEach((s) =>
      stations.add(stationKey({ datasetId, stationId: s.id })),
    );
    if (
      selection.allowedTypeIds?.some(
        (id) => !project.types.some((t) => t.id === id),
      )
    )
      throw new Error("対象種別IDが不正です");
    for (const w of project.oud2?.warnings ?? [])
      warnings.add(`${project.name}: ${w}`);
    if (selection.passengerOnly !== false) {
      const c = classificationCounts(project, timetableId);
      if (c.review || c.nonPassenger)
        warnings.add(
          `${project.name}: 非営業${c.nonPassenger}本・要確認${c.review}本を旅客検索から除外しています。営業区分画面で確認してください`,
        );
    }
    const refs = new Map(
      project.stations.map((s) => [s.id, { datasetId, stationId: s.id }]),
    );
    for (const train of dia.trains) {
      if (
        train.cancelled ||
        (selection.passengerOnly !== false &&
          !isPassengerTrain(project, timetableId, train)) ||
        (selection.allowedTypeIds &&
          !selection.allowedTypeIds.includes(train.typeId))
      )
        continue;
      const visits = trainVisits(train);
      const trip: Trip = {
        selection,
        train,
        visits,
        key: tripKey(datasetId, timetableId, train.id),
        refs: visits.map((s) => refs.get(s.stationId)!),
        stationKeys: visits.map((s) => stationKey(refs.get(s.stationId)!)),
      };
      trips.set(trip.key, trip);
      trip.visits.forEach((s, index) => {
        const store = (target: Map<string, Board[]>, departure: number) => {
          const key = trip.stationKeys[index];
          const list = target.get(key) ?? [];
          list.push({ id: boardId++, trip, index, departure });
          target.set(key, list);
        };
        if (canBoard(s)) store(boards, s.departure!);
        const departure = s.departure ?? s.arrival;
        if (boundaryBoards && index === 0 && departure !== undefined)
          store(boundaryBoards, departure);
      });
    }
  }
  for (const list of [...boards.values(), ...(boundaryBoards?.values() ?? [])])
    list.sort(
      (a, b) =>
        a.departure - b.departure || a.trip.key.localeCompare(b.trip.key),
    );
  // Only explicitly configured links. Station names and legacy transfer strings create no edges.
  validateTransferLinks(links, selections);
  const edges = new Map<string, Walk[]>();
  for (const l of links) {
    if (l.enabled === false) continue;
    if (
      l.restrictions?.some((x) => !options.permittedRestrictions?.includes(x))
    ) {
      warnings.add(`徒歩連絡 ${l.id}: 移動制約が許可されていないため除外`);
      continue;
    }
    const add = (from: StationRef, to: StationRef) => {
      const key = stationKey(from),
        a = edges.get(key) ?? [];
      a.push({
        to,
        seconds: l.walkingSeconds + (l.additionalTransferSeconds ?? 0),
        walkingSeconds: l.walkingSeconds,
        ids: [l.id],
      });
      edges.set(key, a);
    };
    add(l.from, l.to);
    if (l.direction === "both") add(l.to, l.from);
  }
  const walks = new Map<string, Walk[]>();
  for (const source of stations) {
    const best = new Map<string, Walk>();
    const initial = JSON.parse(source) as [string, string];
    best.set(source, {
      to: { datasetId: initial[0], stationId: initial[1] },
      seconds: 0,
      ids: [],
    });
    const settled = new Set<string>();
    while (true) {
      const next = [...best]
        .filter(([k]) => !settled.has(k))
        .sort((a, b) => a[1].seconds - b[1].seconds)[0];
      if (!next) break;
      const [key, walk] = next;
      settled.add(key);
      for (const e of edges.get(key) ?? []) {
        const target = stationKey(e.to),
          seconds = walk.seconds + e.seconds;
        if (!best.has(target) || seconds < best.get(target)!.seconds)
          best.set(target, {
            to: e.to,
            seconds,
            walkingSeconds:
              (walk.walkingSeconds ?? walk.seconds) +
              (e.walkingSeconds ?? e.seconds),
            ids: [...walk.ids, ...e.ids],
          });
      }
    }
    walks.set(source, [...best.values()]);
  }
  warnings.add(
    "列車レコード間の直通継続は確定しません。別レコードへの乗継は最低乗換時間を適用します。路線外発着は表示情報のみです",
  );
  warnings.add(
    "着時刻が欠ける駅での降車・乗換は生成しません。通過・運転停車（扱い2）で乗降しません。徒歩リンクは列車間の乗換に使用し、最初・最後の徒歩だけの移動は未対応です",
  );
  return {
    selections,
    boards,
    boundaryBoards,
    trips,
    stations,
    walks,
    warnings: [...warnings],
  };
}
function lowerBound(boards: Board[], time: number) {
  let lo = 0,
    hi = boards.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (boards[mid].departure < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
// Labels share immutable parent paths instead of copying complete journeys for every candidate.
function chain(label: Label) {
  const nodes: PathNode[] = [];
  let p = label.path;
  while (p) {
    nodes.push(p);
    p = p.previous;
  }
  return nodes.reverse();
}
export const rideKey = (ride: Ride, walkIds: string[] = []) =>
  JSON.stringify([ride.trip.key, ride.i, ride.j, walkIds]);
function signature(label: Label) {
  return chain(label)
    .map(({ ride, walkIds }) => rideKey(ride, walkIds))
    .join("");
}
function dominates(a: Label, b: Label, riding: boolean, choices = false) {
  if (choices && (a.departure !== b.departure || a.firstTrip !== b.firstTrip))
    return false;
  if (riding && a.path?.ride.trip.key !== b.path?.ride.trip.key) return false;
  const ok =
    a.arrival <= b.arrival &&
    a.departure >= b.departure &&
    (!riding || a.riding <= b.riding) &&
    a.walking <= b.walking;
  if (!ok) return false;
  if (!choices) return true;
  const aw = a.arrival - a.departure - a.riding - a.walking,
    bw = b.arrival - b.departure - b.riding - b.walking;
  return (
    aw <= bw &&
    (a.arrival < b.arrival ||
      a.riding < b.riding ||
      a.walking < b.walking ||
      aw < bw ||
      a.depth < b.depth)
  );
}
function insert(
  map: Map<string, Label[]>,
  label: Label,
  riding: boolean,
  choices: boolean,
) {
  const list = map.get(label.key) ?? [];
  if (list.some((old) => dominates(old, label, riding, choices))) return false;
  const kept = list.filter((old) => !dominates(label, old, riding, choices));
  kept.push(label);
  map.set(label.key, kept);
  return true;
}
function materialize(l: Label, includeStops = true): Journey {
  const nodes = chain(l);
  return journeyFromRides(
    nodes.map(({ ride }) => ride),
    nodes.flatMap((n) => (n.transfer ? [n.transfer] : [])),
    signature(l),
    includeStops,
  );
}
export function journeyFromRides(
  rides: Ride[],
  transfers: JourneyTransfer[],
  id: string,
  includeStops = false,
): Journey {
  const legs: JourneyLeg[] = rides.map(({ trip, i, j, departure, arrival }) => {
    const s = trip.selection;
    return {
      datasetId: s.datasetId,
      timetableId: s.timetableId,
      trainId: trip.train.id,
      trainNumber: trip.train.number,
      typeId: trip.train.typeId,
      typeName: s.project.types.find((t) => t.id === trip.train.typeId)!.name,
      origin: trip.refs[i],
      destination: trip.refs[j],
      departure,
      arrival,
      boardIndex: i,
      alightIndex: j,
      stops: includeStops
        ? trip.visits.slice(i, j + 1).map((x) => ({ ...x }))
        : [],
    };
  });
  const departure = rides[0].departure,
    arrival = rides.at(-1)!.arrival;
  return {
    id,
    departure,
    arrival,
    elapsedSeconds: arrival - departure,
    ridingSeconds: rides.reduce(
      (sum, ride) => sum + ride.arrival - ride.departure,
      0,
    ),
    walkingSeconds: transfers.reduce((sum, t) => sum + t.walkingSeconds, 0),
    transferWaitSeconds: transfers.reduce((s, t) => s + t.waitingSeconds, 0),
    transferCount: rides.length - 1,
    legs,
    transfers,
    valid: true,
  };
}
function checkQuery(index: RoutingIndex, q: RouteQuery) {
  if (
    !index.stations.has(stationKey(q.origin)) ||
    !index.stations.has(stationKey(q.destination))
  )
    throw new Error("検索対象データセットに駅IDがありません");
  if (
    !Number.isFinite(q.time) ||
    q.time < 0 ||
    !Number.isInteger(q.maxTransfers) ||
    q.maxTransfers < 0 ||
    q.maxTransfers > 4 ||
    !Number.isFinite(q.minimumTransferSeconds) ||
    q.minimumTransferSeconds < 0 ||
    !["depart", "arrive"].includes(q.mode) ||
    !["arrival", "transfers", "riding"].includes(q.sort)
  )
    throw new Error("検索条件が不正です（乗換0〜4回、時間は非負の秒）");
  if (
    (q.windowStart !== undefined &&
      (!Number.isFinite(q.windowStart) || q.windowStart < 0)) ||
    (q.windowEnd !== undefined &&
      (!Number.isFinite(q.windowEnd) || q.windowEnd < 0)) ||
    (q.windowStart !== undefined &&
      q.windowEnd !== undefined &&
      q.windowEnd < q.windowStart)
  )
    throw new Error("検索時間範囲が不正です");
}

/** Boarding-round multi-label timetable search. This is not the optimized route-scanning RAPTOR.
 * Each edge is an actual board/alight pair in ONE train record. No generated running times.
 * Labels preserve arrival / first departure / riding / walking tradeoffs; rounds bound transfers.
 * The finite supplied service day is searched, including later departures outside a reporting window. */
export function journeyProfile(index: RoutingIndex, q: RouteQuery): Journey[] {
  checkQuery(index, q);
  const originKey = stationKey(q.origin),
    destinationKey = stationKey(q.destination);
  if (originKey === destinationKey) return [];
  const earliest =
    q.mode === "depart"
      ? Math.max(q.time, q.windowStart ?? 0)
      : (q.windowStart ?? 0);
  const latest =
    q.mode === "arrive"
      ? Math.min(q.time, q.windowEnd ?? Infinity)
      : (q.windowEnd ?? Infinity);
  let frontier = new Map<string, Label[]>([
    [
      originKey,
      [
        {
          key: originKey,
          station: q.origin,
          arrival: earliest,
          departure: -Infinity,
          riding: 0,
          walking: 0,
          path: null,
          depth: 0,
          firstTrip: "",
        },
      ],
    ],
  ]);
  const finals: Label[] = [],
    previousRounds = new Map<string, Label[]>();
  let work = 0;
  const choices = q.candidateMode === "choices",
    ridingCriterion = q.sort === "riding" || choices;
  const firstTrains = q.boundaryOriginTrains && new Set(q.boundaryOriginTrains);
  const lastTrains =
    q.boundaryDestinationTrains && new Set(q.boundaryDestinationTrains);
  const direct =
      (q.directOnly || q.maxTransfers === 0) && !firstTrains && !lastTrains,
    cacheKey = JSON.stringify([
      originKey,
      earliest,
      latest,
      ridingCriterion,
      choices,
    ]);
  const cachedRound = direct
    ? directRounds.get(index)?.entries.get(cacheKey)
    : undefined;
  if (cachedRound) {
    const labels = cachedRound.labels.get(destinationKey) ?? [];
    return labels.map((l) => materialize(l, !q.compactProfile));
  }
  type BoardingLabel = {
    base: Label;
    walk: Walk;
    board: Board;
    departure: number;
    walking: number;
    firstTrip: string;
  };
  const better = (a: BoardingLabel, b: BoardingLabel) => {
    if (choices && (a.departure !== b.departure || a.firstTrip !== b.firstTrip))
      return false;
    const ok =
      a.departure >= b.departure &&
      (!ridingCriterion || a.base.riding <= b.base.riding) &&
      a.walking <= b.walking;
    if (!ok || !choices) return ok;
    const aw = a.board.departure - a.departure - a.base.riding - a.walking,
      bw = b.board.departure - b.departure - b.base.riding - b.walking;
    return (
      aw <= bw &&
      (a.base.riding < b.base.riding || a.walking < b.walking || aw < bw)
    );
  };
  for (
    let round = 1;
    round <= (q.directOnly ? 0 : q.maxTransfers) + 1;
    round++
  ) {
    const next = new Map<string, Label[]>(),
      boardingLabels = new Map<number, BoardingLabel[]>();
    for (const list of frontier.values())
      for (const base of list) {
        const targets =
          round === 1
            ? [{ to: base.station, seconds: 0, ids: [] }]
            : (index.walks.get(base.key) ?? []);
        for (const walk of targets) {
          const boardSource =
            round === 1 && firstTrains ? index.boundaryBoards : index.boards;
          const boardList = boardSource?.get(stationKey(walk.to)) ?? [];
          const ready =
            base.arrival +
            walk.seconds +
            (round === 1 ? 0 : q.minimumTransferSeconds);
          for (
            let bi = lowerBound(boardList, ready);
            bi < boardList.length;
            bi++
          ) {
            const board = boardList[bi];
            if (board.departure > latest) break;
            if (
              round === 1 &&
              firstTrains &&
              !firstTrains.has(board.trip.train.id)
            )
              continue;
            if (base.path?.ride.trip.key === board.trip.key) continue;
            const candidate: BoardingLabel = {
              base,
              walk,
              board,
              departure: round === 1 ? board.departure : base.departure,
              walking: base.walking + (walk.walkingSeconds ?? walk.seconds),
              firstTrip: base.firstTrip || board.trip.key,
            };
            const labels = boardingLabels.get(board.id) ?? [];
            if (labels.some((old) => better(old, candidate))) continue;
            const kept = labels.filter((old) => !better(candidate, old));
            kept.push(candidate);
            boardingLabels.set(board.id, kept);
          }
        }
      }
    for (const list of boardingLabels.values())
      for (const { base, walk, board, firstTrip } of list) {
        for (let j = board.index + 1; j < board.trip.visits.length; j++) {
          if (++work > 12000000)
            throw new Error(
              "経路候補の探索量上限に達しました。乗換回数・対象種別・データセットを絞ってください（不完全な結果は返しません）",
            );
          const stop = board.trip.visits[j];
          const key = board.trip.stationKeys[j],
            station = board.trip.refs[j];
          const boundary = key === destinationKey && lastTrains;
          if (
            boundary &&
            (!boundary.has(board.trip.train.id) ||
              j !== board.trip.visits.length - 1)
          )
            continue;
          const arrival = boundary
            ? (stop.arrival ?? stop.departure)
            : canAlight(stop)
              ? stop.arrival
              : undefined;
          if (
            arrival === undefined ||
            arrival < board.departure ||
            arrival > latest
          )
            continue;
          const label: Label = {
            key,
            station,
            arrival,
            departure: round === 1 ? board.departure : base.departure,
            riding: base.riding + arrival - board.departure,
            walking: base.walking + (walk.walkingSeconds ?? walk.seconds),
            depth: round,
            firstTrip,
            path: {
              previous: base.path,
              ride: {
                trip: board.trip,
                i: board.index,
                j,
                departure: board.departure,
                arrival,
              },
              walkIds: walk.ids,
            },
          };
          if (
            (previousRounds.get(key) ?? []).some((old) =>
              dominates(old, label, ridingCriterion, choices),
            )
          )
            continue;
          if (insert(next, label, ridingCriterion, choices) && round > 1)
            label.path!.transfer = {
              from: base.station,
              to: walk.to,
              arrival: base.arrival,
              departure: board.departure,
              walkingSeconds: walk.walkingSeconds ?? walk.seconds,
              waitingSeconds:
                board.departure -
                base.arrival -
                (walk.walkingSeconds ?? walk.seconds),
              minimumSeconds: q.minimumTransferSeconds,
              linkIds: walk.ids,
            };
        }
      }
    if (direct) {
      let cache = directRounds.get(index);
      if (!cache) {
        cache = { entries: new Map(), weight: 0 };
        directRounds.set(index, cache);
      }
      const weight = [...next.values()].reduce((s, list) => s + list.length, 0);
      if (weight <= 20000) {
        while (
          cache.entries.size &&
          (cache.entries.size >= 16 || cache.weight + weight > 20000)
        ) {
          const first = cache.entries.keys().next().value!;
          cache.weight -= cache.entries.get(first)!.weight;
          cache.entries.delete(first);
        }
        cache.entries.set(cacheKey, { labels: new Map(next), weight });
        cache.weight += weight;
      }
    }
    for (const [key, list] of next)
      previousRounds.set(key, [...(previousRounds.get(key) ?? []), ...list]);
    finals.push(...(next.get(destinationKey) ?? []));
    next.delete(destinationKey);
    frontier = next;
    if (!frontier.size) break;
  }
  const unique = new Map(finals.map((l) => [signature(l), l]));
  const best: Label[] = [];
  const finalDominates = (a: Label, b: Label) => {
    if (choices && (a.departure !== b.departure || a.firstTrip !== b.firstTrip))
      return false;
    const ok =
      a.arrival <= b.arrival &&
      a.departure >= b.departure &&
      a.depth <= b.depth &&
      a.walking <= b.walking &&
      (!ridingCriterion || a.riding <= b.riding);
    if (!ok || !choices) return ok;
    const aw = a.arrival - a.departure - a.riding - a.walking,
      bw = b.arrival - b.departure - b.riding - b.walking;
    return (
      aw <= bw &&
      (a.arrival < b.arrival ||
        a.depth < b.depth ||
        a.riding < b.riding ||
        a.walking < b.walking ||
        aw < bw)
    );
  };
  for (const label of unique.values()) {
    if (best.some((old) => finalDominates(old, label))) continue;
    for (let i = best.length - 1; i >= 0; i--)
      if (finalDominates(label, best[i])) best.splice(i, 1);
    best.push(label);
  }
  return best.map((l) => materialize(l, !q.compactProfile));
}
export function searchJourneys(
  index: RoutingIndex,
  q: RouteQuery,
): RouteSearchResult {
  const all = journeyProfile(index, { ...q, compactProfile: false });
  const timeOrder = (a: Journey, b: Journey) =>
    q.mode === "arrive"
      ? b.departure - a.departure || a.arrival - b.arrival
      : a.arrival - b.arrival || b.departure - a.departure;
  const order = (a: Journey, b: Journey) =>
    q.sort === "transfers"
      ? a.transferCount - b.transferCount || timeOrder(a, b)
      : q.sort === "riding"
        ? a.ridingSeconds - b.ridingSeconds || timeOrder(a, b)
        : q.mode === "arrive"
          ? b.departure - a.departure ||
            a.arrival - b.arrival ||
            a.transferCount - b.transferCount
          : a.arrival - b.arrival ||
            b.departure - a.departure ||
            a.transferCount - b.transferCount;
  all.sort(order);
  const limit = q.limit ?? 6;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("表示件数は正の整数が必要です");
  return {
    journeys: all.slice(0, limit),
    candidateCount: all.length,
    warnings: index.warnings,
    reason: all.length
      ? undefined
      : stationKey(q.origin) === stationKey(q.destination)
        ? "発着が同じ駅です。移動は不要です"
        : "明示着発時刻・対象種別・時間・乗換条件を満たす経路がありません。欠損着時刻、終便後、未設定の徒歩連絡も確認してください",
    displayLimited: all.length > limit,
  };
}
/** Independently checks every returned leg against the selected timetable and every transfer. */
export function validateJourney(
  index: RoutingIndex,
  q: RouteQuery,
  j: Journey,
): string[] {
  const errors: string[] = [];
  if (!j.legs.length) return ["乗車区間なし"];
  if (
    j.departure !== j.legs[0].departure ||
    j.arrival !== j.legs.at(-1)!.arrival
  )
    errors.push("旅程全体と区間の時刻不一致");
  if (
    stationKey(j.legs[0].origin) !== stationKey(q.origin) ||
    stationKey(j.legs.at(-1)!.destination) !== stationKey(q.destination)
  )
    errors.push("発着ID不一致");
  if (
    (q.mode === "depart" && j.departure < q.time) ||
    (q.mode === "arrive" && j.arrival > q.time)
  )
    errors.push("指定時刻違反");
  if (
    j.transferCount !== j.legs.length - 1 ||
    j.transferCount > (q.directOnly ? 0 : q.maxTransfers) ||
    j.transfers.length !== j.transferCount
  )
    errors.push("乗換数違反");
  j.legs.forEach((leg, i) => {
    const trip = index.trips.get(
      tripKey(leg.datasetId, leg.timetableId, leg.trainId),
    );
    const a = trip?.visits[leg.boardIndex],
      b = trip?.visits[leg.alightIndex];
    const boundaryStart = i === 0 && q.boundaryOriginTrains;
    const boundaryEnd = i === j.legs.length - 1 && q.boundaryDestinationTrains;
    if (
      !trip ||
      !a ||
      !b ||
      leg.alightIndex <= leg.boardIndex ||
      (boundaryStart
        ? !boundaryStart.includes(leg.trainId) ||
          leg.boardIndex !== 0 ||
          leg.departure !== (a.departure ?? a.arrival)
        : !canBoard(a) || leg.departure !== a.departure) ||
      (boundaryEnd
        ? !boundaryEnd.includes(leg.trainId) ||
          leg.alightIndex !== trip.visits.length - 1 ||
          leg.arrival !== (b.arrival ?? b.departure)
        : !canAlight(b) || leg.arrival !== b.arrival) ||
      leg.origin.stationId !== a.stationId ||
      leg.destination.stationId !== b.stationId ||
      leg.origin.datasetId !== leg.datasetId ||
      leg.destination.datasetId !== leg.datasetId
    )
      errors.push(`区間${i + 1}の時刻・乗降不正`);
    if (
      trip &&
      JSON.stringify(leg.stops) !==
        JSON.stringify(trip.visits.slice(leg.boardIndex, leg.alightIndex + 1))
    )
      errors.push(`区間${i + 1}の途中駅情報不一致`);
    if (i > 0) {
      const previous = j.legs[i - 1],
        t = j.transfers[i - 1];
      const walk = index.walks
        .get(stationKey(previous.destination))
        ?.find((w) => stationKey(w.to) === stationKey(leg.origin));
      if (
        !t ||
        !walk ||
        t.walkingSeconds !== (walk.walkingSeconds ?? walk.seconds) ||
        t.arrival !== previous.arrival ||
        t.departure !== leg.departure ||
        stationKey(t.from) !== stationKey(previous.destination) ||
        stationKey(t.to) !== stationKey(leg.origin) ||
        leg.departure <
          previous.arrival + walk.seconds + q.minimumTransferSeconds ||
        t.waitingSeconds !==
          leg.departure -
            previous.arrival -
            (walk.walkingSeconds ?? walk.seconds)
      )
        errors.push(`乗換${i}の時刻・徒歩連絡不正`);
    }
  });
  if (
    j.elapsedSeconds !== j.arrival - j.departure ||
    j.ridingSeconds !==
      j.legs.reduce((s, l) => s + l.arrival - l.departure, 0) ||
    j.transferWaitSeconds !==
      j.transfers.reduce((s, t) => s + t.waitingSeconds, 0) ||
    j.walkingSeconds !==
      j.transfers.reduce((s, t) => s + t.walkingSeconds, 0) ||
    j.elapsedSeconds !==
      j.ridingSeconds + j.transferWaitSeconds + j.walkingSeconds
  )
    errors.push("所要時間の内訳不一致");
  return errors;
}
