import {
  assignDemand,
  generalizedCost,
  aggregateTrainLoads,
} from "./assignment";
import { cachedProfile } from "./assignment-cache";
import { transportCapacity, capacitySpec } from "./capacity-model";
import { allocateVolume } from "./temporal-demand";
import {
  stationKey,
  type Journey,
  type JourneyLeg,
  type RouteQuery,
} from "./routing-model";
import type { RoutingIndex } from "./routing";
import type {
  AssignmentConfig,
  AssignmentDemand,
  AssignmentResult,
  TrainLoad,
} from "./assignment-model";
import {
  assignIntegratedCapacity,
  validateIntegratedCapacity,
} from "./integrated-assignment";
export type PassengerState =
  "notStarted" | "completed" | "inTransit" | "waiting" | "noPath" | "walking";
export interface CapacityPacket {
  parentId?: number;
  rootId?: number;
  datasetId?: string;
  destinationDatasetId?: string;
  walks?: {
    from: import("./routing-model").StationRef;
    to: import("./routing-model").StationRef;
    start: number;
    end: number;
    linkIds: string[];
    access?: boolean;
  }[];
  transferSeconds?: number;
  id: number;
  cohortId: string;
  passengers: number;
  stationId: string;
  destination: string;
  state: PassengerState;
  ready: number;
  firstArrival: number;
  history: JourneyLeg[];
  plan: JourneyLeg[];
  denials: number;
  deniedSince?: number;
  lastArrival?: number;
  reason?: string;
}
export interface CapacityEvent {
  datasetId?: string;
  eventId?: string;
  time: number;
  type: "board" | "alight" | "denied";
  packetId: number;
  cohortId: string;
  stationId: string;
  destination: string;
  purpose: string;
  trainKey: string;
  passengers: number;
  reassigned: number;
  additionalWaitPersonSeconds: number;
}
export interface CapacityOutcome {
  version: 1 | 2;
  horizon: number;
  packets: CapacityPacket[];
  events: CapacityEvent[];
  loads: TrainLoad[];
  totals: Record<PassengerState, number> & {
    selected: number;
    deniedEvents: number;
    deniedUnique: number;
    reassigned: number;
    additionalWaitPersonSeconds: number;
  };
  warnings: string[];
  milliseconds: number;
}
const tripKey = (l: JourneyLeg) =>
  JSON.stringify([l.datasetId, l.timetableId, l.trainId]);
const near = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-7 + 1e-11 * Math.max(Math.abs(a), Math.abs(b));
/** Discrete-event, aggregate FIFO passengers. No reservation of future legs after a denied boarding. */
export function assignCapacity(
  index: RoutingIndex,
  input: AssignmentDemand[],
  config: AssignmentConfig,
  onProgress?: (n: number, total: number, stage?: "od" | "events") => void,
): AssignmentResult {
  if (
    config.competition === "simultaneous" ||
    !!config.boardingCutoffSeconds ||
    index.selections.length > 1 ||
    [...index.walks.values()].some((ws) => ws.some((w) => w.ids.length)) ||
    config.arrivalModel?.mode === "minute" ||
    input.some((r) => r.accessSeconds)
  )
    return assignIntegratedCapacity(index, input, config, onProgress);
  const started = performance.now();
  if (
    index.selections.length !== 1 ||
    [...index.walks.values()].some((ws) => ws.some((w) => w.ids.length))
  )
    throw new Error(
      "定員制約は単一データセット・同一駅内乗換のみ対応です。徒歩連絡を含む容量配分は未対応です",
    );
  const unknown = [...index.trips].filter(
    ([, t]) =>
      transportCapacity(
        t.selection.project,
        t.selection.timetableId,
        t.train.id,
      ) === null,
  );
  if (unknown.length && (config.unknownCapacityPolicy ?? "error") === "error")
    throw new Error(
      `輸送定員が不明（座席定員のみを含む）の営業列車が${unknown.length}本あります。輸送定員を設定するか「不明便を明示除外」を選んでください`,
    );
  const eligible = new Set(
    [...index.trips.keys()].filter((k) => !unknown.some(([key]) => key === k)),
  );
  const idx: RoutingIndex = unknown.length
    ? {
        ...index,
        trips: new Map([...index.trips].filter(([k]) => eligible.has(k))),
        boards: new Map(
          [...index.boards].map(([k, v]) => [
            k,
            v.filter((b) => eligible.has(b.trip.key)),
          ]),
        ),
      }
    : index;
  const base = assignDemand(
      idx,
      input,
      { ...config, capacityConstrained: false },
      onProgress,
    ),
    horizon = config.simulationEnd ?? config.end + config.maxJourneySeconds;
  const out: CapacityOutcome = {
    version: 1,
    horizon,
    packets: [],
    events: [],
    loads: aggregateTrainLoads(idx, { journeys: {}, allocations: [] }),
    totals: {
      notStarted: 0,
      selected: base.totals.selected,
      completed: 0,
      inTransit: 0,
      waiting: 0,
      noPath: 0,
      walking: 0,
      deniedEvents: 0,
      deniedUnique: 0,
      reassigned: 0,
      additionalWaitPersonSeconds: 0,
    },
    warnings: [
      ...base.diagnostics.warnings,
      ...(unknown.length
        ? [`定員不明・座席定員のみの${unknown.length}本を明示設定により除外`]
        : []),
    ],
    milliseconds: 0,
  };
  const cohorts = new Map(base.cohorts.map((c) => [c.id, c]));
  const packets = out.packets,
    queues = new Map<string, CapacityPacket[]>(),
    aboard = new Map<string, CapacityPacket[]>(),
    loads = new Map(out.loads.map((l) => [l.key, l]));
  let nextId = 0;
  const queue = (p: CapacityPacket) => {
    const leg = p.plan[0];
    if (!leg) return;
    const key = JSON.stringify([tripKey(leg), leg.boardIndex]);
    const q = queues.get(key) ?? [];
    q.push(p);
    queues.set(key, q);
    p.state = "waiting";
  };
  const create = (
    cohortId: string,
    passengers: number,
    plan: JourneyLeg[],
    state: PassengerState,
  ): CapacityPacket => {
    const c = cohorts.get(cohortId)!,
      r = input[c.demandIndex];
    const p: CapacityPacket = {
      id: nextId++,
      cohortId,
      passengers,
      stationId: r.origin,
      destination: r.destination,
      state,
      ready: c.arrival,
      firstArrival: c.arrival,
      history: [],
      plan,
      denials: 0,
    };
    packets.push(p);
    return p;
  };
  for (const a of base.allocations)
    queue(
      create(
        a.cohortId,
        a.passengers,
        base.journeys[a.journeyId].legs.slice(),
        "waiting",
      ),
    );
  for (const a of base.unallocated) {
    const p = create(a.cohortId, a.passengers, [], "noPath");
    p.reason = a.reason;
  }
  const emit = (
    p: CapacityPacket,
    type: CapacityEvent["type"],
    time: number,
    key: string,
    amount = p.passengers,
    reassigned = 0,
    wait = 0,
  ) => {
    const row = input[cohorts.get(p.cohortId)!.demandIndex];
    out.events.push({
      time,
      type,
      packetId: p.id,
      cohortId: p.cohortId,
      stationId: p.stationId,
      destination: p.destination,
      purpose: row.purpose,
      trainKey: key,
      passengers: amount,
      reassigned,
      additionalWaitPersonSeconds: wait,
    });
  };
  function reroute(p: CapacityPacket, time: number) {
    const row = input[cohorts.get(p.cohortId)!.demandIndex],
      remaining = config.maxTransfers + 1 - p.history.length,
      deadline = p.firstArrival + config.maxJourneySeconds;
    if (remaining <= 0) {
      p.state = "waiting";
      p.plan = [];
      p.reason = "乗換回数上限のため再探索できない";
      return;
    }
    const ready = Math.max(time + 1e-6, p.ready);
    const q: RouteQuery = {
      origin: { datasetId: row.datasetId, stationId: p.stationId },
      destination: { datasetId: row.datasetId, stationId: p.destination },
      mode: "depart",
      time: ready,
      sort: "arrival",
      maxTransfers: remaining - 1,
      minimumTransferSeconds: config.minimumTransferSeconds,
      directOnly: remaining === 1,
      candidateMode: "choices",
      windowEnd: deadline,
    };
    let candidates: Journey[];
    try {
      candidates = cachedProfile(idx, q).filter(
        (j) =>
          j.arrival <= deadline &&
          (p.history.length > 0 ||
            j.departure - p.firstArrival <= config.maxWaitSeconds),
      );
    } catch (e) {
      out.warnings.push((e as Error).message);
      candidates = [];
    }
    const coeff = config.coefficients[row.purpose];
    const ranked = candidates
      .map((j) => ({ j, cost: generalizedCost(j, p.ready, coeff) }))
      .sort((a, b) =>
        config.method === "fastest"
          ? a.j.arrival - b.j.arrival ||
            a.j.transferCount - b.j.transferCount ||
            a.cost - b.cost ||
            a.j.id.localeCompare(b.j.id)
          : a.cost - b.cost ||
            a.j.arrival - b.j.arrival ||
            a.j.id.localeCompare(b.j.id),
      )
      .slice(0, config.method === "fastest" ? 1 : config.maxChoices);
    if (!ranked.length) {
      p.state = "waiting";
      p.plan = [];
      p.reason = "積み残し後に条件を満たす後続経路なし";
      return;
    }
    const weights = ranked.map((r) =>
        Math.exp(-coeff.scale * (r.cost - ranked[0].cost)),
      ),
      counts = allocateVolume(p.passengers, weights, config.integer);
    const snapshot = { ...p, history: p.history.slice() };
    let used = false;
    ranked.forEach((r, i) => {
      if (!counts[i]) return;
      const part = used
        ? { ...snapshot, id: nextId++, history: snapshot.history.slice() }
        : p;
      part.passengers = counts[i];
      part.plan = r.j.legs.slice();
      if (used) packets.push(part);
      used = true;
      queue(part);
    });
  }
  const events: [number, number, string, number][] = [];
  for (const [key, t] of idx.trips)
    for (const [i, s] of t.visits.entries()) {
      if (s.arrival !== undefined) events.push([s.arrival, 0, key, i]);
      if (s.departure !== undefined) events.push([s.departure, 1, key, i]);
    }
  events.sort(
    (a, b) =>
      a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]) || a[3] - b[3],
  );
  let processedEvents = 0;
  for (const [time, kind, key, i] of events) {
    if (time > horizon) break;
    if (++processedEvents % 256 === 0)
      onProgress?.(processedEvents, events.length, "events");
    const trip = idx.trips.get(key)!,
      load = loads.get(key)!,
      stationId = trip.visits[i].stationId;
    let riding = aboard.get(key) ?? [];
    if (kind === 0) {
      const off = riding.filter((p) => p.history.at(-1)!.alightIndex === i);
      riding = riding.filter((p) => p.history.at(-1)!.alightIndex !== i);
      aboard.set(key, riding);
      for (const p of off) {
        p.stationId = stationId;
        p.lastArrival = time;
        load.alightings[i] += p.passengers;
        emit(p, "alight", time, key);
        if (stationId === p.destination) {
          p.state = "completed";
          p.plan = [];
        } else {
          p.ready = time + config.minimumTransferSeconds;
          queue(p);
        }
      }
    } else {
      const list = queues.get(JSON.stringify([key, i])) ?? [];
      queues.delete(JSON.stringify([key, i]));
      list.sort(
        (a, b) =>
          a.ready - b.ready || a.firstArrival - b.firstArrival || a.id - b.id,
      );
      const cap = transportCapacity(
        trip.selection.project,
        trip.selection.timetableId,
        trip.train.id,
      )!;
      let space = cap - riding.reduce((s, p) => s + p.passengers, 0);
      for (const waiting of list) {
        if (waiting.ready > time + 1e-8)
          throw new Error("成立しない乗換が乗車待機列に入りました");
        const amount = Math.min(waiting.passengers, Math.max(0, space));
        let p = waiting;
        if (amount > 0) {
          if (amount < waiting.passengers) {
            p = {
              ...waiting,
              id: nextId++,
              passengers: amount,
              history: waiting.history.slice(),
              plan: waiting.plan.slice(),
            };
            packets.push(p);
            waiting.passengers -= amount;
          }
          const leg = p.plan.shift()!;
          if (leg.departure !== time || leg.origin.stationId !== stationId)
            throw new Error("乗車位置・時刻の不整合");
          p.history = [...p.history, leg];
          p.state = "inTransit";
          load.boardings[i] += amount;
          space -= amount;
          riding.push(p);
          const extra =
            p.deniedSince === undefined ? 0 : (time - p.deniedSince) * amount;
          emit(
            p,
            "board",
            time,
            key,
            amount,
            p.deniedSince === undefined ? 0 : amount,
            extra,
          );
          delete p.deniedSince;
          if (leg.arrival === time) {
            riding = riding.filter((x) => x !== p);
            p.stationId = leg.destination.stationId;
            p.lastArrival = time;
            load.alightings[leg.alightIndex] += amount;
            emit(p, "alight", time, key);
            if (p.stationId === p.destination) {
              p.state = "completed";
              p.plan = [];
            } else {
              if (p.plan[0]?.departure === time)
                throw new Error(
                  "ゼロ所要乗車直後の同時刻乗換の容量配分は未対応です",
                );
              p.ready = time + config.minimumTransferSeconds;
              queue(p);
            }
          }
        }
        if (amount === 0 || p !== waiting) {
          waiting.denials++;
          waiting.deniedSince ??= time;
          emit(waiting, "denied", time, key);
          reroute(waiting, time);
        }
      }
      aboard.set(key, riding);
    }
  }
  for (const p of packets) out.totals[p.state] += p.passengers;
  out.totals.deniedUnique = packets
    .filter((p) => p.denials > 0)
    .reduce((s, p) => s + p.passengers, 0);
  for (const e of out.events) {
    if (e.type === "denied") out.totals.deniedEvents += e.passengers;
    out.totals.reassigned += e.reassigned;
    out.totals.additionalWaitPersonSeconds += e.additionalWaitPersonSeconds;
  }
  for (const l of out.loads) {
    const trip = idx.trips.get(l.key)!;
    const spec = capacitySpec(
      trip.selection.project,
      trip.selection.timetableId,
      trip.train.id,
    )!;
    l.capacity = spec.value;
    l.capacitySource = spec.basis.startsWith("旧") ? l.capacitySource : "train";
    let onboard = 0;
    l.segmentLoads = [];
    l.segmentObserved = [];
    l.observedUntil = horizon;
    for (let i = 0; i < l.stops.length; i++) {
      onboard += l.boardings[i] - l.alightings[i];
      if (i < l.stops.length - 1) {
        const observed =
          (l.stops[i].departure ?? l.stops[i].arrival ?? Infinity) <= horizon;
        l.segmentObserved.push(observed);
        l.segmentLoads.push(
          observed ? (Math.abs(onboard) < 1e-9 ? 0 : onboard) : 0,
        );
      }
    }
    l.totalBoardings = l.boardings.reduce((a, b) => a + b, 0);
    l.totalAlightings = l.alightings.reduce((a, b) => a + b, 0);
    l.uniquePassengers = packets
      .filter((p) => p.history.some((h) => tripKey(h) === l.key))
      .reduce((s, p) => s + p.passengers, 0);
    l.peakLoad = Math.max(0, ...l.segmentLoads);
    l.peakSegments = l.segmentLoads.flatMap((v, i) =>
      v > 0 && near(v, l.peakLoad) ? [i] : [],
    );
    l.occupancies = l.segmentLoads.map((v, i) =>
      l.segmentObserved![i] ? v / l.capacity! : null,
    );
    l.peakOccupancy = l.peakLoad / l.capacity;
  }
  out.milliseconds = performance.now() - started;
  const errors = validateCapacity(idx, base, out);
  if (errors.length) throw new Error("容量配分検証失敗: " + errors.join(" / "));
  base.config = structuredClone(config);
  base.capacity = out;
  return base;
}
export function validateCapacity(
  index: RoutingIndex,
  base: AssignmentResult,
  o: CapacityOutcome,
) {
  if (o.version === 2) return validateIntegratedCapacity(index, base, o);
  const errors: string[] = [];
  const total = o.totals;
  if (
    !near(
      total.selected,
      total.completed + total.inTransit + total.waiting + total.noPath,
    ) ||
    !near(
      total.selected,
      o.packets.reduce((s, p) => s + p.passengers, 0),
    )
  )
    errors.push("需要状態の保存則");
  const cohorts = new Map(base.cohorts.map((c) => [c.id, c]));
  for (const state of ["completed", "inTransit", "waiting", "noPath"] as const)
    if (
      !near(
        total[state],
        o.packets
          .filter((p) => p.state === state)
          .reduce((s, p) => s + p.passengers, 0),
      )
    )
      errors.push("状態別需要不一致");
  if (
    new Set(o.packets.map((p) => p.id)).size !== o.packets.length ||
    (base.config.integer &&
      o.packets.some((p) => !Number.isInteger(p.passengers)))
  )
    errors.push("旅客ID・整数人数不正");
  for (const [id, c] of cohorts)
    if (
      !near(
        c.passengers,
        o.packets
          .filter((p) => p.cohortId === id)
          .reduce((s, p) => s + p.passengers, 0),
      )
    )
      errors.push("コホート保存則");
  for (const l of o.loads) {
    const source = index.trips.get(l.key);
    if (
      !source ||
      l.capacity !==
        transportCapacity(
          source.selection.project,
          source.selection.timetableId,
          source.train.id,
        )
    )
      errors.push("輸送定員参照不一致");
    const actual = o.events.filter((e) => e.trainKey === l.key);
    if (
      !near(
        actual
          .filter((e) => e.type === "board")
          .reduce((s, e) => s + e.passengers, 0),
        l.totalBoardings,
      ) ||
      !near(
        actual
          .filter((e) => e.type === "alight")
          .reduce((s, e) => s + e.passengers, 0),
        l.totalAlightings,
      )
    )
      errors.push("乗降イベント収支");
    let n = 0;
    for (let i = 0; i < l.stops.length; i++) {
      const s = l.stops[i];
      n += l.boardings[i] - l.alightings[i];
      if (
        n < -1e-7 ||
        n > l.capacity! + 1e-7 ||
        (i < l.segmentLoads.length &&
          l.segmentObserved?.[i] !== false &&
          !near(n, l.segmentLoads[i]))
      )
        errors.push("車内人数・容量制約");
      if (
        (l.boardings[i] > 0 &&
          (s.status !== "stop" ||
            s.pickupAllowed === false ||
            s.departure === undefined)) ||
        (l.alightings[i] > 0 &&
          (s.status !== "stop" ||
            s.dropoffAllowed === false ||
            s.arrival === undefined))
      )
        errors.push("乗降禁止位置");
    }
    const transit = o.packets
      .filter(
        (p) => p.state === "inTransit" && tripKey(p.history.at(-1)!) === l.key,
      )
      .reduce((s, p) => s + p.passengers, 0);
    if (!near(l.totalBoardings - l.totalAlightings, transit))
      errors.push("列車終端収支");
  }
  for (const p of o.packets) {
    const last = p.history.at(-1);
    if (
      (p.state === "completed" &&
        (!last ||
          last.destination.stationId !== p.destination ||
          last.arrival > o.horizon)) ||
      (p.state === "inTransit" &&
        (!last || last.departure > o.horizon || last.arrival <= o.horizon)) ||
      (p.state === "waiting" && last && last.arrival > o.horizon) ||
      (p.state === "noPath" && p.history.length)
    )
      errors.push("旅客の終端状態不正");
    if (
      p.passengers < 0 ||
      !Number.isFinite(p.passengers) ||
      !cohorts.has(p.cohortId)
    )
      errors.push("旅客状態不正");
    for (let i = 0; i < p.history.length; i++) {
      const h = p.history[i],
        trip = index.trips.get(tripKey(h));
      if (
        !trip ||
        h.departure < p.firstArrival ||
        h.boardIndex >= h.alightIndex ||
        trip.visits[h.boardIndex]?.departure !== h.departure ||
        trip.visits[h.alightIndex]?.arrival !== h.arrival ||
        (i > 0 &&
          (p.history[i - 1].destination.stationId !== h.origin.stationId ||
            p.history[i - 1].arrival + base.config.minimumTransferSeconds >
              h.departure))
      )
        errors.push("実績旅程不正");
    }
  }
  for (const event of o.events)
    if (
      event.time > o.horizon ||
      !Number.isFinite(event.passengers) ||
      event.passengers < 0
    )
      errors.push("乗降イベント値不正");
  return [...new Set(errors)];
}
