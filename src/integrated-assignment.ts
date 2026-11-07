import {
  assignDemand,
  aggregateTrainLoads,
  generalizedCost,
  expandJourney,
} from "./assignment";
import { cachedProfile } from "./assignment-cache";
import { transportCapacity } from "./capacity-model";
import { allocateVolume } from "./temporal-demand";
import { createRecorder, type AuditState } from "./assignment-diagnostics";
import { demandKey } from "./result-conditions";
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
  const modern = c.competition === "simultaneous",
    cutoff = c.boardingCutoffSeconds ?? 0;
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
  const setupStarted = performance.now();
  let rerouteMs = 0,
    boardingSearchMs = 0;
  const stopCache = new Map<string, import("./model").Stop[]>();
  const packets: Packet[] = [],
    out: CapacityOutcome = {
      version: 2,
      horizon,
      packets,
      events: [],
      loads: aggregateTrainLoads(idx, { journeys: {}, allocations: [] }),
      totals: {
        selected: base.totals.selected,
        notStarted: 0,
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
  const recorder = modern
    ? createRecorder(base.totals.selected, c.diagnosticMode ?? "summary")
    : undefined;
  const trace = (
    p: Packet,
    kind: string,
    time: number,
    detail = "",
    next: AuditState = p.state,
    trainKey?: string,
  ) => {
    recorder?.record({
      time,
      kind,
      packetId: p.id,
      parentId: p.parentId,
      cohortId: p.cohortId,
      demandIndex: cohorts.get(p.cohortId)!.demandIndex,
      passengers: p.passengers,
      datasetId: p.datasetId,
      stationId: p.stationId,
      trainKey,
      from: p.state,
      to: next,
      detail,
    });
    p.state = next;
  };
  const heap = new EventQueue(),
    cohorts = new Map(base.cohorts.map((v) => [v.id, v])),
    queues = new Map<string, Packet[]>(),
    closed = new Set<string>(),
    loads = new Map(out.loads.map((l) => [l.key, l]));
  const cars = new Map<string, { count: number; people: Set<Packet> }>();
  const pending = new Map<
    string,
    { id: string; k: string; i: number; time: number }
  >();
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
      l.departure - cutoff + 1e-8 < p.ready
    )
      throw new Error("徒歩完了・最低乗換時間を満たさない乗車要求");
    const id = stopEventId(
      l.datasetId,
      l.timetableId,
      l.trainId,
      l.boardIndex,
      "departure",
    );
    if (closed.has(id) && modern) {
      p.reason = "同時発車段階終了後のゼロ所要接続。後続便を再探索";
      trace(p, "connection-closed", l.departure, p.reason, "waiting");
      reroute(p, l.departure);
      return;
    }
    if (closed.has(id))
      throw new Error(
        "既に出発した同時刻便への接続です。ゼロ所要の同時刻連鎖は再設定してください",
      );
    const list = queues.get(id) ?? [];
    list.push(p);
    queues.set(id, list);
    trace(p, "ready", p.ready, "乗車候補確定", "waiting");
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
    trace(p, "walk-start", now, "明示徒歩連絡", "walking");
    heap.push(now + physical, 1, () => {
      p.datasetId = w.to.datasetId;
      p.stationId = w.to.stationId;
      trace(p, "walk-end", now + physical, "徒歩完了", "waiting");
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
    trace(p, "alight", l.arrival, "降車", "waiting", key(l));
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
      trace(p, "completed", l.arrival, "目的地到着", "completed");
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
    const t = performance.now();
    try {
      rerouteCore(p, now);
    } finally {
      rerouteMs += performance.now() - t;
    }
  }
  function rerouteCore(p: Packet, now: number) {
    const remaining = c.maxTransfers + 1 - p.history.length,
      deadline = p.firstArrival + c.maxJourneySeconds,
      row = input[cohorts.get(p.cohortId)!.demandIndex];
    p.plan = [];
    p.planTransfers = [];
    trace(p, "reroute", now, "積み残し後の再探索", "waiting");
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
          time: time + cutoff,
          sort: "arrival",
          maxTransfers: remaining - 1,
          minimumTransferSeconds: c.minimumTransferSeconds + cutoff,
          directOnly: remaining === 1,
          candidateMode: "choices",
          windowEnd: modern
            ? c.end + (row.accessSeconds ?? 0) + c.maxJourneySeconds
            : deadline,
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
            parentId: p.id,
            rootId: p.rootId ?? p.id,
            history: snapshot.history.slice(),
            walks: snapshot.walks?.slice(),
          };
      part.passengers = counts[i];
      part.plan = v.j.legs.slice();
      part.planTransfers = v.j.transfers.slice();
      if (!first) packets.push(part);
      trace(
        part,
        "route-selected",
        now,
        v.j.legs.map((l) => key(l)).join(" → "),
      );
      first = false;
      transfer(part, v.w, now);
    });
  }
  function board(
    waiting: Packet,
    amount: number,
    j: Journey | undefined,
    k: string,
    i: number,
    time: number,
  ) {
    const car = cars.get(k)!;
    let p = waiting;
    if (amount < waiting.passengers - 1e-9) {
      p = {
        ...waiting,
        id: serial++,
        parentId: waiting.id,
        rootId: waiting.rootId ?? waiting.id,
        passengers: amount,
        history: waiting.history.slice(),
        walks: waiting.walks?.slice(),
        plan: waiting.plan.slice(),
        planTransfers: waiting.planTransfers.slice(),
      };
      waiting.passengers -= amount;
      packets.push(p);
      trace(p, "split", time, "分割元 " + waiting.id);
    }
    if (j) {
      const full = expandJourney(idx, j, stopCache);
      p.plan = full.legs.slice();
      p.planTransfers = full.transfers.slice();
      trace(p, "route-selected", time, p.plan.map(key).join(" → "));
    }
    const leg = p.plan.shift()!;
    p.history = [...p.history, leg];
    trace(p, "board", time, "乗車成功", "inTransit", k);
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
    return p;
  }
  const stable = (p: Packet) =>
    JSON.stringify([
      demandKey(input[cohorts.get(p.cohortId)!.demandIndex]),
      p.firstArrival,
      p.history.map((l) => [l.origin, l.destination, l.departure, l.arrival]),
    ]);
  function concurrentDepart() {
    const stops = [...pending.values()],
      time = stops[0].time;
    pending.clear();
    const stopsById = new Map(stops.map((s) => [s.id, s]));
    const waiting = [...new Set(stops.flatMap((s) => queues.get(s.id) ?? []))]
      .filter((p) => p.state === "waiting")
      .sort((a, b) => a.ready - b.ready || stable(a).localeCompare(stable(b)));
    for (const s of stops) {
      queues.delete(s.id);
      closed.add(s.id);
    }
    const choices = new Map<
      Packet,
      { j: Journey; stop: (typeof stops)[number]; cost: number }[]
    >();
    for (const p of waiting) {
      if (p.ready > time - cutoff + 1e-8)
        throw new Error("乗車締切・乗換時間の矛盾");
      const row = input[cohorts.get(p.cohortId)!.demandIndex],
        remaining = c.maxTransfers - p.history.length;
      const q = {
        origin: location(p),
        destination: demandDestination(row),
        mode: "depart" as const,
        time,
        sort: "arrival" as const,
        maxTransfers: remaining,
        minimumTransferSeconds: c.minimumTransferSeconds + cutoff,
        directOnly: remaining === 0,
        candidateMode: "choices" as const,
        compactProfile: true,
        windowEnd: c.end + (row.accessSeconds ?? 0) + c.maxJourneySeconds,
      };
      const searchStarted = performance.now();
      const js = cachedProfile(idx, q).filter(
        (j) =>
          j.departure === time &&
          j.arrival - p.firstArrival <= c.maxJourneySeconds &&
          (p.history.length || time - p.firstArrival <= c.maxWaitSeconds),
      );
      boardingSearchMs += performance.now() - searchStarted;
      const cs = js
        .flatMap((j) => {
          const l = j.legs[0],
            id = stopEventId(
              l.datasetId,
              l.timetableId,
              l.trainId,
              l.boardIndex,
              "departure",
            ),
            stop = stopsById.get(id);
          return stop
            ? [
                {
                  j,
                  stop,
                  cost: generalizedCost(
                    j,
                    p.firstArrival,
                    c.coefficients[row.purpose],
                  ),
                },
              ]
            : [];
        })
        .sort(
          (a, b) =>
            a.j.arrival - b.j.arrival ||
            a.cost - b.cost ||
            JSON.stringify(
              a.j.legs.map((l) => [
                l.origin,
                l.destination,
                l.departure,
                l.arrival,
              ]),
            ).localeCompare(
              JSON.stringify(
                b.j.legs.map((l) => [
                  l.origin,
                  l.destination,
                  l.departure,
                  l.arrival,
                ]),
              ),
            ) ||
            a.j.id.localeCompare(b.j.id),
        );
      choices.set(p, cs);
      trace(
        p,
        "boarding-candidates",
        time,
        cs.map((v) => v.stop.k).join(" | "),
      );
    }
    for (let from = 0; from < waiting.length;) {
      let end = from + 1;
      while (
        end < waiting.length &&
        near(waiting[end].ready, waiting[from].ready)
      )
        end++;
      const remaining = new Map(
        waiting.slice(from, end).map((p) => [p, p.passengers]),
      );
      for (let round = 0; round < stops.length + 2; round++) {
        const requests = new Map<
          string,
          { p: Packet; j: Journey; n: number; stop: (typeof stops)[number] }[]
        >();
        for (const [p, n] of remaining) {
          if (n < 1e-8) continue;
          let cs = (choices.get(p) ?? []).filter((v) => {
            const car = cars.get(v.stop.k)!,
              cap = loads.get(v.stop.k)!.capacity!;
            return cap - car.count > 1e-8;
          });
          if (!cs.length) continue;
          if (c.method === "fastest") {
            const a = cs[0];
            cs = cs.filter(
              (v) =>
                v.j.arrival === a.j.arrival &&
                v.j.transferCount === a.j.transferCount &&
                near(v.cost, a.cost),
            );
          } else cs = cs.sort((a, b) => a.cost - b.cost).slice(0, c.maxChoices);
          const best = Math.min(...cs.map((v) => v.cost)),
            weights = cs.map((v) =>
              c.method === "fastest"
                ? 1
                : Math.exp(
                    -c.coefficients[
                      input[cohorts.get(p.cohortId)!.demandIndex].purpose
                    ].scale *
                      (v.cost - best),
                  ),
            ),
            volumes = allocateVolume(n, weights, c.integer);
          cs.forEach((v, i) => {
            if (!volumes[i]) return;
            const list = requests.get(v.stop.k) ?? [];
            list.push({ p, j: v.j, n: volumes[i], stop: v.stop });
            requests.set(v.stop.k, list);
          });
        }
        if (!requests.size) break;
        let progress = 0;
        // Resolve every train from the same proposal snapshot, then apply accepted counts.
        const accepted: {
          p: Packet;
          j: Journey;
          n: number;
          stop: (typeof stops)[number];
        }[] = [];
        for (const list of requests.values()) {
          list.sort((a, b) => stable(a.p).localeCompare(stable(b.p)));
          const stop = list[0].stop,
            space = Math.max(
              0,
              loads.get(stop.k)!.capacity! - cars.get(stop.k)!.count,
            ),
            total = list.reduce((s, v) => s + v.n, 0),
            amount = Math.min(space, total),
            counts = allocateVolume(
              amount,
              list.map((v) => v.n),
              c.integer,
            );
          list.forEach((v, i) => {
            if (counts[i]) accepted.push({ ...v, n: counts[i] });
          });
        }
        for (const v of accepted) {
          board(v.p, v.n, v.j, v.stop.k, v.stop.i, time);
          remaining.set(v.p, Math.max(0, remaining.get(v.p)! - v.n));
          progress += v.n;
        }
        if (progress < 1e-8) break;
      }
      for (const [p, n] of remaining)
        if (n > 1e-7) {
          const leg = p.plan[0];
          p.denials++;
          p.deniedSince ??= time;
          trace(
            p,
            "denied",
            time,
            "同時刻候補の定員不足・積み残し",
            "waiting",
            key(leg),
          );
          log(p, "denied", time, leg);
          reroute(p, time);
        }
      from = end;
    }
  }
  function depart(id: string, k: string, i: number, time: number) {
    if (modern) {
      pending.set(id, { id, k, i, time });
      return;
    }
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
        state: modern ? "notStarted" : "waiting",
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
    p.rootId = p.id;
    packets.push(p);
    const arrive = () => {
      if (modern) trace(p, "arrival", cohort.arrival, "駅到着", "waiting");
      if (j) enqueue(p);
      else
        trace(
          p,
          "untransported",
          cohort.arrival,
          reason ?? "経路なし",
          "noPath",
        );
    };
    const access = r.accessSeconds ?? 0;
    heap.push(cohort.arrival - access, 1, () => {
      if (modern) {
        trace(
          p,
          "demand",
          cohort.arrival - access,
          "需要発生",
          access ? "walking" : "waiting",
        );
        if (j)
          trace(
            p,
            "initial-route",
            cohort.arrival - access,
            j.legs.map(key).join(" → "),
          );
      }
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
  const eventSetupMs = performance.now() - setupStarted,
    eventStarted = performance.now();
  while (heap.size) {
    const event = heap.pop()!;
    if (event.time > horizon) break;
    event.run();
    if (
      modern &&
      pending.size &&
      (!heap.peek() || heap.peek().time !== event.time)
    )
      concurrentDepart();
    if (modern && (!heap.peek() || heap.peek().time !== event.time))
      recorder!.point(event.time);
    if (++eventCount % 256 === 0)
      onProgress?.(eventCount, eventCount + heap.size, "events");
  }
  const eventProcessingMs = performance.now() - eventStarted,
    aggregationStarted = performance.now();
  for (const p of packets) {
    if (modern && p.state !== "completed" && p.state !== "noPath")
      trace(
        p,
        "untransported",
        horizon,
        p.reason ?? "計算終了時点の未輸送（状態を保持）",
      );
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
  base.diagnostics.timings = {
    ...base.diagnostics.timings,
    eventSetupMs,
    eventProcessingMs,
    rerouteMs,
    boardingSearchMs,
    capacityAggregationMs: performance.now() - aggregationStarted,
  };
  if (recorder) {
    recorder.data.timings = { ...base.diagnostics.timings };
    recorder.point(horizon);
    base.audit = recorder.data;
  }
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
    "notStarted",
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
              (base.config.boardingCutoffSeconds ?? 0) +
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
