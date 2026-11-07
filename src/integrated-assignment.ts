import {
  assignDemand,
  aggregateTrainLoads,
  generalizedCost,
} from "./assignment";
import { cachedProfile } from "./assignment-cache";
import { transportCapacity } from "./capacity-model";
import { allocateVolume } from "./temporal-demand";
import { EventQueue } from "./event-queue";
import { demandDestination, stopEventId } from "./integration-model";
import {
  stationKey,
  type Journey,
  type JourneyLeg,
  type JourneyTransfer,
  type StationRef,
} from "./routing-model";
import type { RoutingIndex } from "./routing";
import type {
  AssignmentConfig,
  AssignmentDemand,
  AssignmentResult,
} from "./assignment-model";
import type {
  CapacityPacket,
  CapacityOutcome,
  CapacityEvent,
} from "./capacity-assignment";
type Walk = RoutingIndex["walks"] extends Map<string, (infer W)[]> ? W : never;
type Packet = CapacityPacket & {
  datasetId: string;
  destinationDatasetId: string;
  planTransfers: JourneyTransfer[];
  lastAlight?: number;
  deniedWalk: number;
  completedAt?: number;
};
const key = (l: JourneyLeg) =>
  JSON.stringify([l.datasetId, l.timetableId, l.trainId]);
const location = (p: CapacityPacket): StationRef => ({
  datasetId: p.datasetId!,
  stationId: p.stationId,
});
const near = (a: number, b: number) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= 1e-7 + 1e-11 * Math.max(Math.abs(a), Math.abs(b));
/** A single vehicle stock and event heap across every dataset. Pedestrian packets remain in the same ledger. */
export function assignIntegratedCapacity(
  index: RoutingIndex,
  input: AssignmentDemand[],
  c: AssignmentConfig,
  onProgress?: (n: number, total: number, stage?: "od" | "events") => void,
): AssignmentResult {
  const started = performance.now(),
    unknown = new Set(
      [...index.trips]
        .filter(
          ([, t]) =>
            transportCapacity(
              t.selection.project,
              t.selection.timetableId,
              t.train.id,
            ) === null,
        )
        .map(([k]) => k),
    );
  if (unknown.size && (c.unknownCapacityPolicy ?? "error") === "error")
    throw new Error(
      `統合配分に輸送定員不明の便が${unknown.size}本あります。定員設定または明示除外が必要です`,
    );
  const idx: RoutingIndex = unknown.size
    ? {
        ...index,
        trips: new Map([...index.trips].filter(([k]) => !unknown.has(k))),
        boards: new Map(
          [...index.boards].map(([k, b]) => [
            k,
            b.filter((v) => !unknown.has(v.trip.key)),
          ]),
        ),
      }
    : index;
  if (
    c.integer &&
    [...idx.trips.values()].some(
      (t) =>
        !Number.isInteger(
          transportCapacity(
            t.selection.project,
            t.selection.timetableId,
            t.train.id,
          ),
        ),
    )
  )
    throw new Error("整数配分には整数の輸送定員が必要です");
  const base = assignDemand(
      idx,
      input,
      { ...c, capacityConstrained: false },
      onProgress,
    ),
    horizon = c.simulationEnd ?? c.end + c.maxJourneySeconds;
  const packets: Packet[] = [],
    out: CapacityOutcome = {
      version: 2,
      horizon,
      packets,
      events: [],
      loads: aggregateTrainLoads(idx, { journeys: {}, allocations: [] }),
      totals: {
        selected: base.totals.selected,
        completed: 0,
        inTransit: 0,
        walking: 0,
        waiting: 0,
        noPath: 0,
        deniedEvents: 0,
        deniedUnique: 0,
        reassigned: 0,
        additionalWaitPersonSeconds: 0,
      },
      warnings: [
        ...idx.warnings,
        ...(unknown.size ? [`輸送定員不明の${unknown.size}本を明示除外`] : []),
      ],
      milliseconds: 0,
    };
  const heap = new EventQueue(),
    cohorts = new Map(base.cohorts.map((v) => [v.id, v])),
    queues = new Map<string, Packet[]>(),
    closed = new Set<string>(),
    loads = new Map(out.loads.map((l) => [l.key, l]));
  const cars = new Map<string, { count: number; people: Set<Packet> }>();
  let serial = 0,
    eventCount = 0;
  const log = (
    p: Packet,
    type: CapacityEvent["type"],
    time: number,
    l: JourneyLeg,
    amount = p.passengers,
    reassigned = 0,
    extra = 0,
  ) =>
    out.events.push({
      type,
      time,
      packetId: p.id,
      cohortId: p.cohortId,
      datasetId: l.datasetId,
      stationId:
        type === "alight" ? l.destination.stationId : l.origin.stationId,
      destination: p.destination,
      purpose: input[cohorts.get(p.cohortId)!.demandIndex].purpose,
      trainKey: key(l),
      eventId: stopEventId(
        l.datasetId,
        l.timetableId,
        l.trainId,
        type === "alight" ? l.alightIndex : l.boardIndex,
        type === "alight" ? "arrival" : "departure",
      ),
      passengers: amount,
      reassigned,
      additionalWaitPersonSeconds: extra,
    });
  const enqueue = (p: Packet) => {
    const l = p.plan[0];
    if (!l) throw new Error("乗車予定なしの待機要求");
    if (
      stationKey(location(p)) !== stationKey(l.origin) ||
      l.departure + 1e-8 < p.ready
    )
      throw new Error("徒歩完了・最低乗換時間を満たさない乗車要求");
    const id = stopEventId(
      l.datasetId,
      l.timetableId,
      l.trainId,
      l.boardIndex,
      "departure",
    );
    if (closed.has(id))
      throw new Error(
        "既に出発した同時刻便への接続です。ゼロ所要の同時刻連鎖は再設定してください",
      );
    const list = queues.get(id) ?? [];
    list.push(p);
    queues.set(id, list);
    p.state = "waiting";
  };
  function transfer(p: Packet, w: Walk, now: number) {
    const from = location(p),
      physical = w.walkingSeconds ?? w.seconds;
    p.transferSeconds = (p.transferSeconds ?? 0) + w.seconds;
    const minimum = p.history.length ? c.minimumTransferSeconds : 0;
    p.ready = Math.max(
      now + w.seconds,
      (p.lastAlight ?? p.firstArrival) + minimum + (p.transferSeconds ?? 0),
    );
    if (!w.ids.length) {
      p.datasetId = w.to.datasetId;
      p.stationId = w.to.stationId;
      enqueue(p);
      return;
    }
    p.walks ??= [];
    p.walks.push({
      from,
      to: { ...w.to },
      start: now,
      end: now + physical,
      linkIds: w.ids.slice(),
    });
    if (p.deniedSince !== undefined) p.deniedWalk += physical;
    p.state = "walking";
    heap.push(now + physical, 1, () => {
      p.datasetId = w.to.datasetId;
      p.stationId = w.to.stationId;
      enqueue(p);
    });
  }
  function alight(p: Packet, l: JourneyLeg) {
    const car = cars.get(key(l))!;
    if (!car.people.delete(p)) throw new Error("降車する旅客が車内にいません");
    car.count -= p.passengers;
    loads.get(key(l))!.alightings[l.alightIndex] += p.passengers;
    log(p, "alight", l.arrival, l);
    p.datasetId = l.destination.datasetId;
    p.stationId = l.destination.stationId;
    p.lastAlight = l.arrival;
    p.lastArrival = l.arrival;
    p.transferSeconds = 0;
    if (
      stationKey(location(p)) ===
      stationKey({
        datasetId: p.destinationDatasetId,
        stationId: p.destination,
      })
    ) {
      p.state = "completed";
      p.completedAt = l.arrival;
      p.plan = [];
      return;
    }
    const next = p.plan[0],
      planned = p.planTransfers.shift();
    if (!next || !planned)
      throw new Error("未到着の乗客に次の旅程がありません");
    const w = idx.walks
      .get(stationKey(location(p)))
      ?.find(
        (w) =>
          stationKey(w.to) === stationKey(next.origin) &&
          JSON.stringify(w.ids) === JSON.stringify(planned.linkIds),
      );
    if (!w) throw new Error("予定徒歩連絡が索引に存在しません");
    transfer(p, w, l.arrival);
  }
  function reroute(p: Packet, now: number) {
    const remaining = c.maxTransfers + 1 - p.history.length,
      deadline = p.firstArrival + c.maxJourneySeconds,
      row = input[cohorts.get(p.cohortId)!.demandIndex];
    p.plan = [];
    p.planTransfers = [];
    p.state = "waiting";
    if (remaining <= 0) {
      p.reason = "残り乗換回数なし";
      return;
    }
    const choices: { j: Journey; w: Walk; cost: number }[] = [];
    for (const w of idx.walks.get(stationKey(location(p))) ?? []) {
      const time = Math.max(
        now + 1e-6 + w.seconds,
        (p.lastAlight ?? p.firstArrival) +
          (p.history.length ? c.minimumTransferSeconds : 0) +
          (p.transferSeconds ?? 0) +
          w.seconds,
      );
      if (time > deadline) continue;
      try {
        const js = cachedProfile(idx, {
          origin: w.to,
          destination: demandDestination(row),
          mode: "depart",
          time,
          sort: "arrival",
          maxTransfers: remaining - 1,
          minimumTransferSeconds: c.minimumTransferSeconds,
          directOnly: remaining === 1,
          candidateMode: "choices",
          windowEnd: deadline,
        });
        for (const j of js)
          if (
            j.arrival <= deadline &&
            (p.history.length ||
              j.departure - p.firstArrival <= c.maxWaitSeconds)
          )
            choices.push({
              j,
              w,
              cost:
                generalizedCost(j, now, c.coefficients[row.purpose]) +
                ((c.coefficients[row.purpose].walking -
                  c.coefficients[row.purpose].waiting) *
                  (w.walkingSeconds ?? w.seconds)) /
                  60,
            });
      } catch (error) {
        out.warnings.push((error as Error).message);
      }
    }
    choices.sort((a, b) =>
      c.method === "fastest"
        ? a.j.arrival - b.j.arrival ||
          a.j.transferCount - b.j.transferCount ||
          a.cost - b.cost ||
          a.j.id.localeCompare(b.j.id)
        : a.cost - b.cost ||
          a.j.arrival - b.j.arrival ||
          a.j.id.localeCompare(b.j.id),
    );
    const candidates = choices.slice(
      0,
      c.method === "fastest" ? 1 : c.maxChoices,
    );
    if (!candidates.length) {
      p.reason = "積み残し後に利用可能な後続経路なし";
      return;
    }
    const weights = candidates.map((x) =>
        Math.exp(
          -c.coefficients[row.purpose].scale * (x.cost - candidates[0].cost),
        ),
      ),
      counts = allocateVolume(p.passengers, weights, c.integer),
      snapshot = { ...p, history: p.history.slice(), walks: p.walks?.slice() };
    let first = true;
    candidates.forEach((v, i) => {
      if (!counts[i]) return;
      const part: Packet = first
        ? p
        : {
            ...snapshot,
            id: serial++,
            history: snapshot.history.slice(),
            walks: snapshot.walks?.slice(),
          };
      part.passengers = counts[i];
      part.plan = v.j.legs.slice();
      part.planTransfers = v.j.transfers.slice();
      if (!first) packets.push(part);
      first = false;
      transfer(part, v.w, now);
    });
  }
  function depart(id: string, k: string, i: number, time: number) {
    closed.add(id);
    const list = queues.get(id) ?? [];
    queues.delete(id);
    list.sort(
      (a, b) =>
        a.ready - b.ready || a.firstArrival - b.firstArrival || a.id - b.id,
    );
    const trip = idx.trips.get(k)!,
      car = cars.get(k)!,
      cap = transportCapacity(
        trip.selection.project,
        trip.selection.timetableId,
        trip.train.id,
      )!;
    for (const waiting of list) {
      if (waiting.state !== "waiting" || waiting.ready > time + 1e-8)
        throw new Error("未完了の移動中に乗車しようとしました");
      const amount = Math.min(waiting.passengers, Math.max(0, cap - car.count));
      let p = waiting;
      if (amount > 0) {
        if (amount < waiting.passengers) {
          p = {
            ...waiting,
            id: serial++,
            passengers: amount,
            history: waiting.history.slice(),
            walks: waiting.walks?.slice(),
            plan: waiting.plan.slice(),
            planTransfers: waiting.planTransfers.slice(),
          };
          waiting.passengers -= amount;
          packets.push(p);
        }
        const leg = p.plan.shift()!;
        p.history = [...p.history, leg];
        p.state = "inTransit";
        p.transferSeconds = 0;
        car.count += amount;
        car.people.add(p);
        loads.get(k)!.boardings[i] += amount;
        const extra =
          p.deniedSince === undefined
            ? 0
            : Math.max(0, time - p.deniedSince - p.deniedWalk) * amount;
        log(
          p,
          "board",
          time,
          leg,
          amount,
          p.deniedSince === undefined ? 0 : amount,
          extra,
        );
        delete p.deniedSince;
        p.deniedWalk = 0;
        heap.push(leg.arrival, 0, () => alight(p, leg));
      }
      if (!amount || p !== waiting) {
        waiting.denials++;
        waiting.deniedSince ??= time;
        const leg = waiting.plan[0];
        log(waiting, "denied", time, leg);
        reroute(waiting, time);
      }
    }
  }
  for (const [k, t] of idx.trips) {
    cars.set(k, { count: 0, people: new Set() });
    for (const [i, s] of t.visits.entries())
      if (s.departure !== undefined) {
        const id = stopEventId(
          t.selection.datasetId,
          t.selection.timetableId,
          t.train.id,
          i,
          "departure",
        );
        heap.push(s.departure, 2, () => depart(id, k, i, s.departure!));
      }
  }
  const create = (
    cohortId: string,
    passengers: number,
    j?: Journey,
    reason?: string,
  ) => {
    const cohort = cohorts.get(cohortId)!,
      r = input[cohort.demandIndex],
      p: Packet = {
        id: serial++,
        cohortId,
        passengers,
        datasetId: r.datasetId,
        destinationDatasetId: r.destinationDatasetId ?? r.datasetId,
        stationId: r.origin,
        destination: r.destination,
        state: "waiting",
        ready: cohort.arrival,
        firstArrival: cohort.arrival,
        history: [],
        plan: j?.legs.slice() ?? [],
        planTransfers: j?.transfers.slice() ?? [],
        walks: [],
        denials: 0,
        deniedWalk: 0,
        reason,
      };
    packets.push(p);
    const arrive = () => {
      if (j) enqueue(p);
      else p.state = "noPath";
    };
    const access = r.accessSeconds ?? 0;
    heap.push(cohort.arrival - access, 1, () => {
      if (access) {
        p.walks!.push({
          from: location(p),
          to: location(p),
          start: cohort.arrival - access,
          end: cohort.arrival,
          linkIds: [],
          access: true,
        });
        p.state = "walking";
        heap.push(cohort.arrival, 1, arrive);
      } else arrive();
    });
  };
  for (const a of base.allocations)
    create(a.cohortId, a.passengers, base.journeys[a.journeyId]);
  for (const a of base.unallocated)
    create(a.cohortId, a.passengers, undefined, a.reason);
  while (heap.size) {
    const event = heap.pop()!;
    if (event.time > horizon) break;
    event.run();
    if (++eventCount % 256 === 0)
      onProgress?.(eventCount, eventCount + heap.size, "events");
  }
  for (const p of packets) {
    out.totals[p.state] += p.passengers;
    if (p.denials) out.totals.deniedUnique += p.passengers;
  }
  for (const e of out.events) {
    if (e.type === "denied") out.totals.deniedEvents += e.passengers;
    out.totals.reassigned += e.reassigned;
    out.totals.additionalWaitPersonSeconds += e.additionalWaitPersonSeconds;
  }
  for (const l of out.loads) {
    let n = 0;
    l.segmentLoads = [];
    l.segmentObserved = [];
    l.observedUntil = horizon;
    for (let i = 0; i < l.stops.length; i++) {
      n += l.boardings[i] - l.alightings[i];
      if (i < l.stops.length - 1) {
        const seen =
          (l.stops[i].departure ?? l.stops[i].arrival ?? Infinity) <= horizon;
        l.segmentObserved.push(seen);
        l.segmentLoads.push(seen ? n : 0);
      }
    }
    l.totalBoardings = l.boardings.reduce((a, b) => a + b, 0);
    l.totalAlightings = l.alightings.reduce((a, b) => a + b, 0);
    l.uniquePassengers = packets
      .filter((p) => p.history.some((h) => key(h) === l.key))
      .reduce((s, p) => s + p.passengers, 0);
    l.peakLoad = Math.max(0, ...l.segmentLoads);
    l.peakSegments = l.segmentLoads.flatMap((n, i) =>
      n > 0 && near(n, l.peakLoad) ? [i] : [],
    );
    l.occupancies = l.segmentLoads.map((n, i) =>
      l.segmentObserved![i] ? n / l.capacity! : null,
    );
    l.peakOccupancy = l.peakLoad / l.capacity!;
  }
  base.config = structuredClone(c);
  out.milliseconds = performance.now() - started;
  base.capacity = out;
  const errors = validateIntegratedCapacity(idx, base, out);
  if (errors.length)
    throw new Error("統合配分の整合性検証失敗: " + errors.join(" / "));
  return base;
}
export function validateIntegratedCapacity(
  index: RoutingIndex,
  base: AssignmentResult,
  o: CapacityOutcome,
) {
  const errors: string[] = [],
    sum = (ps: CapacityPacket[]) => ps.reduce((s, p) => s + p.passengers, 0),
    cohorts = new Map(base.cohorts.map((c) => [c.id, c]));
  if (
    !near(sum(o.packets), o.totals.selected) ||
    !near(o.totals.selected, base.totals.selected)
  )
    errors.push("全需要保存則");
  for (const state of [
    "completed",
    "inTransit",
    "walking",
    "waiting",
    "noPath",
  ] as const)
    if (!near(sum(o.packets.filter((p) => p.state === state)), o.totals[state]))
      errors.push("状態別人数不一致");
  const cohortCounts = new Map<string, number>();
  for (const p of o.packets)
    cohortCounts.set(
      p.cohortId,
      (cohortCounts.get(p.cohortId) ?? 0) + p.passengers,
    );
  for (const [id, c] of cohorts)
    if (!near(cohortCounts.get(id) ?? 0, c.passengers))
      errors.push("到着枠の人数不一致");
  if (new Set(o.packets.map((p) => p.id)).size !== o.packets.length)
    errors.push("旅客ID重複");
  for (const p of o.packets) {
    const cohort = cohorts.get(p.cohortId);
    if (!cohort) {
      errors.push("到着枠参照不正");
      continue;
    }
    const row = base.input[cohort.demandIndex],
      last = p.history.at(-1);
    if (
      !Number.isFinite(p.passengers) ||
      p.passengers < 0 ||
      (base.config.integer && !Number.isInteger(p.passengers))
    )
      errors.push("旅客人数不正");
    if (
      (p.state === "completed" &&
        (!last ||
          stationKey(location(p)) !== stationKey(demandDestination(row)) ||
          stationKey(last.destination) !== stationKey(demandDestination(row)) ||
          last.arrival > o.horizon)) ||
      (p.state === "inTransit" &&
        (!last || last.departure > o.horizon || last.arrival <= o.horizon)) ||
      (p.state === "walking" &&
        !p.walks?.some((w) => w.start <= o.horizon && w.end > o.horizon)) ||
      (p.state === "noPath" && p.history.length > 0) ||
      (p.state === "waiting" && last && last.arrival > o.horizon)
    )
      errors.push("終端状態不正");
    let loc: StationRef = { datasetId: row.datasetId, stationId: row.origin },
      available = p.firstArrival;
    for (const [legIndex, l] of p.history.entries()) {
      let walked = 0,
        walkClock = available;
      for (const w of (p.walks ?? []).filter(
        (w) => !w.access && w.start >= available && w.end <= l.departure,
      )) {
        if (stationKey(w.from) !== stationKey(loc))
          errors.push("徒歩の接続順不正");
        if (w.start < walkClock) errors.push("徒歩イベント順不正");
        walkClock = w.end;
        const proof = index.walks
          .get(stationKey(w.from))
          ?.find(
            (v) =>
              stationKey(v.to) === stationKey(w.to) &&
              JSON.stringify(v.ids) === JSON.stringify(w.linkIds),
          );
        walked += proof?.seconds ?? 0;
        loc = w.to;
      }
      const t = index.trips.get(key(l)),
        a = t?.visits[l.boardIndex],
        b = t?.visits[l.alightIndex];
      if (
        !t ||
        a?.departure !== l.departure ||
        b?.arrival !== l.arrival ||
        a.status !== "stop" ||
        a.pickupAllowed === false ||
        b.status !== "stop" ||
        b.dropoffAllowed === false ||
        stationKey(loc) !== stationKey(l.origin) ||
        l.departure <
          Math.max(
            walkClock,
            available +
              (legIndex ? base.config.minimumTransferSeconds : 0) +
              walked,
          ) ||
        l.arrival - p.firstArrival > base.config.maxJourneySeconds
      )
        errors.push("乗車区間不正");
      loc = l.destination;
      available = l.arrival;
    }
    for (const w of p.walks ?? []) {
      if (w.access) continue;
      const link = index.walks
        .get(stationKey(w.from))
        ?.find(
          (v) =>
            stationKey(v.to) === stationKey(w.to) &&
            JSON.stringify(v.ids) === JSON.stringify(w.linkIds),
        );
      if (!link || !near(w.end - w.start, link.walkingSeconds ?? link.seconds))
        errors.push("徒歩連絡の根拠不一致");
    }
  }
  for (const l of o.loads) {
    const t = index.trips.get(l.key),
      cap = t
        ? transportCapacity(
            t.selection.project,
            t.selection.timetableId,
            t.train.id,
          )
        : null;
    let n = 0;
    if (cap === null || cap !== l.capacity) errors.push("輸送定員不正");
    for (let i = 0; i < l.stops.length; i++) {
      n += l.boardings[i] - l.alightings[i];
      if (
        n < -1e-7 ||
        n > (cap ?? 0) + 1e-7 ||
        (l.segmentObserved?.[i] && !near(n, l.segmentLoads[i]))
      )
        errors.push("列車容量・区間収支");
    }
    if (
      !near(
        n,
        sum(
          o.packets.filter(
            (p) => p.state === "inTransit" && key(p.history.at(-1)!) === l.key,
          ),
        ),
      )
    )
      errors.push("車内残数不一致");
    for (const type of ["board", "alight"] as const) {
      const total = o.events
        .filter((e) => e.trainKey === l.key && e.type === type)
        .reduce((s, e) => s + e.passengers, 0);
      if (!near(total, type === "board" ? l.totalBoardings : l.totalAlightings))
        errors.push("乗降イベント不一致");
    }
  }
  return [...new Set(errors)];
}
