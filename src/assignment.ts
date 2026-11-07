import { journeyProfile, validateJourney, type RoutingIndex } from "./routing";
import { type Journey, type RouteQuery } from "./routing-model";
import { capacityOf, isPassengerTrain } from "./classification";
import { allocateVolume } from "./temporal-demand";
import { cachedProfile } from "./assignment-cache";
import { assignCapacity, validateCapacity } from "./capacity-assignment";
import { transportCapacity } from "./capacity-model";
import {
  arrivalBreaks,
  arrivalWeight,
  selectedDemand,
} from "./arrival-distribution";
import { demandDestination, validateServiceMapping } from "./integration-model";
import {
  validateAssignmentConfig,
  type AssignmentConfig,
  type AssignmentDemand,
  type AssignmentResult,
  type ArrivalCohort,
  type TrainLoad,
} from "./assignment-model";
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const close = (a: number, b: number) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= 1e-7 + 1e-12 * Math.max(Math.abs(a), Math.abs(b));
const keyOf = (datasetId: string, timetableId: string, trainId: string) =>
  JSON.stringify([datasetId, timetableId, trainId]);
export function expandJourney(index: RoutingIndex, j: Journey): Journey {
  const full = structuredClone(j);
  for (const leg of full.legs)
    if (!leg.stops.length) {
      const trip = index.trips.get(
        keyOf(leg.datasetId, leg.timetableId, leg.trainId),
      );
      if (!trip) throw new Error("候補旅程の列車が索引にありません");
      leg.stops = structuredClone(
        trip.visits.slice(leg.boardIndex, leg.alightIndex + 1),
      );
    }
  return full;
}
export function generalizedCost(
  j: Journey,
  arrival: number,
  c: AssignmentConfig["coefficients"]["commute"],
) {
  return (
    (c.riding * j.ridingSeconds) / 60 +
    (c.waiting * (j.departure - arrival + j.transferWaitSeconds)) / 60 +
    (c.walking * j.walkingSeconds) / 60 +
    c.transferPenalty * j.transferCount
  );
}
export function queryFor(
  row: AssignmentDemand,
  config: AssignmentConfig,
  time: number,
): RouteQuery {
  return {
    origin: { datasetId: row.datasetId, stationId: row.origin },
    destination: demandDestination(row),
    mode: "depart",
    time,
    sort: "arrival",
    maxTransfers: config.maxTransfers,
    minimumTransferSeconds: config.minimumTransferSeconds,
    directOnly: config.maxTransfers === 0,
    candidateMode: "choices",
    compactProfile: true,
    windowEnd: config.end + (row.accessSeconds ?? 0) + config.maxJourneySeconds,
  };
}
function validateInputs(
  index: RoutingIndex,
  rows: AssignmentDemand[],
  config: AssignmentConfig,
) {
  validateAssignmentConfig(config);
  if (index.selections.length > 1 || config.serviceMapping)
    validateServiceMapping(config.serviceMapping!, index.selections);
  if (index.selections.some((s) => s.passengerOnly === false))
    throw new Error(
      "全列車の分析用インデックスでは旅客配分できません。営業列車だけのインデックスを作成してください",
    );
  for (const r of rows)
    if (
      !r.datasetId ||
      !r.origin ||
      !r.destination ||
      (r.origin === r.destination &&
        (r.destinationDatasetId ?? r.datasetId) === r.datasetId) ||
      (r.accessSeconds !== undefined &&
        (!Number.isFinite(r.accessSeconds) || r.accessSeconds < 0)) ||
      !Number.isFinite(r.passengers) ||
      r.passengers < 0 ||
      !Number.isFinite(r.start) ||
      !Number.isFinite(r.end) ||
      r.start < 0 ||
      r.end <= r.start ||
      !["commute", "school", "shopping", "private"].includes(r.purpose) ||
      !["outbound", "return"].includes(r.kind) ||
      !["estimated", "observed", "manual"].includes(r.source)
    )
      throw new Error("配分対象ODのID・人数・目的・出典・時間枠が不正です");
}
/** Uniform station arrivals. Partition at every departure and waiting/duration feasibility boundary.
 * Generalized logit cost differences are constant inside each interval; no coarse time sampling. */
export function assignDemand(
  index: RoutingIndex,
  input: AssignmentDemand[],
  config: AssignmentConfig,
  onProgress?: (done: number, total: number, stage?: "od" | "events") => void,
): AssignmentResult {
  validateInputs(index, input, config);
  if (config.capacityConstrained)
    return assignCapacity(index, input, config, onProgress);
  const started = performance.now();
  const result: AssignmentResult = {
    config: structuredClone(config),
    input: structuredClone(input),
    cohorts: [],
    journeys: Object.create(null),
    allocations: [],
    unallocated: [],
    loads: [],
    totals: {
      input: sum(input.map((r) => r.passengers)),
      selected: 0,
      outsideWindow: 0,
      assigned: 0,
      unassigned: 0,
      boardingEvents: 0,
    },
    diagnostics: {
      profiles: 0,
      milliseconds: 0,
      warnings: [...index.warnings],
    },
  };
  const groups = new Map<string, number[]>();
  input.forEach((r, i) => {
    const a = Math.max(config.start, r.start),
      b = Math.min(config.end, r.end);
    const amount = selectedDemand(r, config);
    result.totals.selected += amount;
    if (amount > 0) {
      if (config.integer && !Number.isInteger(amount))
        throw new Error(
          "整数配分には整数人数かつ時間枠に整合した対象窓が必要です。時間帯別ODを整数モードで再配分してください",
        );
      const key = JSON.stringify([
          r.datasetId,
          r.origin,
          r.destinationDatasetId ?? r.datasetId,
          r.destination,
          r.accessSeconds ?? 0,
        ]),
        list = groups.get(key) ?? [];
      list.push(i);
      groups.set(key, list);
    }
  });
  result.totals.outsideWindow = result.totals.input - result.totals.selected;
  let processed = 0;
  for (const indices of groups.values()) {
    const rankingCache = new Map<string, { j: Journey; cost: number }[]>();
    const first = input[indices[0]];
    let journeys: Journey[] = [],
      profileError = "";
    try {
      journeys = cachedProfile(index, queryFor(first, config, config.start));
      result.diagnostics.profiles++;
      result.diagnostics.candidateJourneys =
        (result.diagnostics.candidateJourneys ?? 0) + journeys.length;
    } catch (error) {
      profileError = (error as Error).message;
      result.diagnostics.warnings.push(
        `${first.origin}→${first.destination}: ${profileError}。対象需要は未配分として保持します`,
      );
    }
    for (const demandIndex of indices) {
      const row = input[demandIndex],
        start = Math.max(config.start, row.start),
        end = Math.min(config.end, row.end),
        total = selectedDemand(row, config),
        access = row.accessSeconds ?? 0;
      const relevant = journeys.filter(
        (j) =>
          j.departure >= start + access &&
          j.departure <= end + access + config.maxWaitSeconds &&
          j.arrival <= end + access + config.maxJourneySeconds,
      );
      const boundaries = new Set([start, end]);
      for (const j of relevant)
        for (const t of [
          j.departure - access,
          j.departure - access - config.maxWaitSeconds,
          j.arrival - access - config.maxJourneySeconds,
        ])
          if (t > start && t < end) boundaries.add(t);
      arrivalBreaks(row, start, end, boundaries, config);
      const points = [...boundaries].sort((a, b) => a - b),
        volumes = allocateVolume(
          total,
          points
            .slice(1)
            .map((b, i) => arrivalWeight(row, points[i], b, config)),
          config.integer,
        );
      for (let i = 0; i < volumes.length; i++) {
        const amount = volumes[i];
        if (amount === 0) continue;
        const a = points[i],
          b = points[i + 1],
          arrival = (a + b) / 2 + access,
          cohort: ArrivalCohort = {
            id: `${demandIndex}:${i}`,
            demandIndex,
            start: a,
            end: b,
            arrival,
            passengers: amount,
          };
        result.cohorts.push(cohort);
        const feasible = relevant.filter(
            (j) =>
              j.departure >= arrival &&
              j.departure - arrival <= config.maxWaitSeconds &&
              j.arrival - arrival <= config.maxJourneySeconds,
          ),
          coeff = config.coefficients[row.purpose];
        const rankingKey = JSON.stringify([row.purpose, arrival]);
        const ranked =
          rankingCache.get(rankingKey) ??
          feasible
            .map((j) => ({ j, cost: generalizedCost(j, arrival, coeff) }))
            .sort((x, y) =>
              config.method === "fastest"
                ? x.j.arrival - y.j.arrival ||
                  x.j.transferCount - y.j.transferCount ||
                  x.cost - y.cost ||
                  x.j.id.localeCompare(y.j.id)
                : x.cost - y.cost ||
                  x.j.arrival - y.j.arrival ||
                  x.j.id.localeCompare(y.j.id),
            );
        rankingCache.set(rankingKey, ranked);
        const choices = ranked.slice(
          0,
          config.method === "fastest" ? 1 : config.maxChoices,
        );
        if (!choices.length) {
          result.unallocated.push({
            cohortId: cohort.id,
            passengers: amount,
            reason:
              profileError ||
              "時刻・営業区分・最大待ち時間・所要時間・乗換条件を満たす経路がない",
          });
          continue;
        }
        const weights =
            config.method === "fastest"
              ? [1]
              : choices.map((x) =>
                  Math.exp(-coeff.scale * (x.cost - choices[0].cost)),
                ),
          counts = allocateVolume(amount, weights, config.integer),
          weightSum = sum(weights);
        choices.forEach((choice, i) => {
          if (!counts[i]) return;
          if (!result.journeys[choice.j.id])
            result.journeys[choice.j.id] = expandJourney(index, choice.j);
          result.allocations.push({
            cohortId: cohort.id,
            journeyId: choice.j.id,
            passengers: counts[i],
            costMinutes: choice.cost,
            probability: weights[i] / weightSum,
          });
        });
      }
    }
    onProgress?.(++processed, groups.size);
  }
  result.totals.assigned = sum(result.allocations.map((a) => a.passengers));
  result.totals.unassigned = sum(result.unallocated.map((a) => a.passengers));
  result.loads = aggregateTrainLoads(index, result);
  result.totals.boardingEvents = sum(result.loads.map((l) => l.totalBoardings));
  result.diagnostics.milliseconds = performance.now() - started;
  const errors = validateAssignment(index, result);
  if (errors.length)
    throw new Error("配分収支の検証失敗: " + errors.slice(0, 5).join(" / "));
  return result;
}
export function aggregateTrainLoads(
  index: RoutingIndex,
  result: Pick<AssignmentResult, "journeys" | "allocations">,
): TrainLoad[] {
  const loads = new Map<string, TrainLoad>();
  for (const [key, trip] of index.trips) {
    const p = trip.selection.project,
      t = trip.train,
      capacity = p.capacitySettings
        ? transportCapacity(p, trip.selection.timetableId, t.id)
        : capacityOf(p, t);
    loads.set(key, {
      key,
      datasetId: trip.selection.datasetId,
      timetableId: trip.selection.timetableId,
      trainId: t.id,
      trainNumber: t.number,
      typeId: t.typeId,
      typeName: p.types.find((x) => x.id === t.typeId)!.name,
      direction: t.direction,
      stops: structuredClone(trip.visits),
      boardings: Array(trip.visits.length).fill(0),
      alightings: Array(trip.visits.length).fill(0),
      segmentLoads: [],
      totalBoardings: 0,
      totalAlightings: 0,
      uniquePassengers: 0,
      peakLoad: 0,
      peakSegments: [],
      capacity,
      capacitySource:
        t.capacity !== undefined
          ? "train"
          : p.typeCapacities?.[t.typeId] !== undefined
            ? "type"
            : "unknown",
      occupancies: [],
      peakOccupancy: null,
    });
  }
  for (const a of result.allocations) {
    const journey = result.journeys[a.journeyId];
    if (!journey) throw new Error("配分先旅程がありません");
    const touched = new Set<string>();
    for (const leg of journey.legs) {
      const key = keyOf(leg.datasetId, leg.timetableId, leg.trainId),
        load = loads.get(key);
      if (!load || leg.boardIndex < 0 || leg.alightIndex >= load.stops.length)
        throw new Error("配分先列車・乗降位置が不正です");
      load.boardings[leg.boardIndex] += a.passengers;
      load.alightings[leg.alightIndex] += a.passengers;
      touched.add(key);
    }
    for (const key of touched) loads.get(key)!.uniquePassengers += a.passengers;
  }
  for (const l of loads.values()) {
    let onboard = 0;
    for (let i = 0; i < l.stops.length; i++) {
      onboard += l.boardings[i] - l.alightings[i];
      if (Math.abs(onboard) < 1e-9) onboard = 0;
      if (i < l.stops.length - 1) l.segmentLoads.push(onboard);
    }
    l.totalBoardings = sum(l.boardings);
    l.totalAlightings = sum(l.alightings);
    l.peakLoad = Math.max(0, ...l.segmentLoads);
    l.peakSegments = l.segmentLoads.flatMap((n, i) =>
      l.peakLoad > 0 && close(n, l.peakLoad) ? [i] : [],
    );
    l.occupancies = l.segmentLoads.map((n) =>
      l.capacity === null ? null : n / l.capacity,
    );
    l.peakOccupancy = l.capacity === null ? null : l.peakLoad / l.capacity;
  }
  return [...loads.values()];
}
export function validateAssignment(
  index: RoutingIndex,
  result: AssignmentResult,
): string[] {
  if (result.capacity) return validateCapacity(index, result, result.capacity);
  const errors: string[] = [];
  const { totals: t } = result,
    cohorts = new Map(result.cohorts.map((c) => [c.id, c]));
  if (
    !close(t.input, sum(result.input.map((r) => r.passengers))) ||
    !close(t.input, t.selected + t.outsideWindow) ||
    !close(t.selected, t.assigned + t.unassigned) ||
    !close(t.assigned, sum(result.allocations.map((a) => a.passengers))) ||
    !close(t.unassigned, sum(result.unallocated.map((a) => a.passengers)))
  )
    errors.push("全体需要の保存則");
  if (cohorts.size !== result.cohorts.length) errors.push("コホートID重複");
  const balanced = new Map<string, number>(),
    rowTotals = Array(result.input.length).fill(0);
  const checkedJourneys = new Map<string, boolean>();
  for (const c of result.cohorts) {
    const r = result.input[c.demandIndex];
    if (
      !r ||
      c.start < Math.max(r.start, result.config.start) ||
      c.end > Math.min(r.end, result.config.end) ||
      !(c.start < c.end) ||
      c.arrival < c.start + (r.accessSeconds ?? 0) ||
      c.arrival >= c.end + (r.accessSeconds ?? 0) ||
      !Number.isFinite(c.passengers) ||
      c.passengers < 0
    )
      errors.push("乗客到着枠不正");
    else rowTotals[c.demandIndex] += c.passengers;
  }
  result.input.forEach((r, i) => {
    const overlap = Math.max(
      0,
      Math.min(r.end, result.config.end) -
        Math.max(r.start, result.config.start),
    );
    if (!close(rowTotals[i], selectedDemand(r, result.config)))
      errors.push("OD行ごとの人数不一致");
  });
  for (const a of result.allocations) {
    const c = cohorts.get(a.cohortId),
      j = result.journeys[a.journeyId];
    if (!c || !j || !Number.isFinite(a.passengers) || a.passengers < 0) {
      errors.push("配分参照不正");
      continue;
    }
    const r = result.input[c.demandIndex],
      q = queryFor(r, result.config, c.arrival);
    const validationKey = JSON.stringify([
      j.id,
      c.arrival,
      r.datasetId,
      r.origin,
      r.destination,
    ]);
    let invalid = checkedJourneys.get(validationKey);
    if (invalid === undefined) {
      invalid = validateJourney(index, q, j).length > 0;
      checkedJourneys.set(validationKey, invalid);
    }
    if (
      invalid ||
      j.departure - c.arrival > result.config.maxWaitSeconds ||
      j.arrival - c.arrival > result.config.maxJourneySeconds
    )
      errors.push("成立しない旅程への配分");
    for (const leg of j.legs) {
      const trip = index.trips.get(
          keyOf(leg.datasetId, leg.timetableId, leg.trainId),
        ),
        selection = trip?.selection,
        train = trip?.train;
      if (
        !selection ||
        !train ||
        !isPassengerTrain(selection.project, leg.timetableId, train)
      )
        errors.push("非営業・要確認列車への配分");
    }
    balanced.set(c.id, (balanced.get(c.id) ?? 0) + a.passengers);
  }
  for (const a of result.unallocated) {
    if (
      !cohorts.has(a.cohortId) ||
      !a.reason ||
      !Number.isFinite(a.passengers) ||
      a.passengers < 0
    )
      errors.push("未配分参照不正");
    balanced.set(a.cohortId, (balanced.get(a.cohortId) ?? 0) + a.passengers);
  }
  for (const c of result.cohorts)
    if (!close(balanced.get(c.id) ?? 0, c.passengers))
      errors.push("到着枠ごとの人数不一致");
  if (
    result.config.integer &&
    [...result.allocations, ...result.unallocated, ...result.cohorts].some(
      (a) => !Number.isInteger(a.passengers),
    )
  )
    errors.push("整数人数不一致");
  const expected = aggregateTrainLoads(index, result);
  const expectedByKey = new Map(expected.map((l) => [l.key, l]));
  for (const load of result.loads) {
    const e = expectedByKey.get(load.key);
    if (
      !e ||
      load.boardings.some((n, i) => !close(n, e.boardings[i])) ||
      load.alightings.some((n, i) => !close(n, e.alightings[i])) ||
      load.segmentLoads.some(
        (n, i) => n < -1e-7 || !close(n, e.segmentLoads[i]),
      ) ||
      !close(load.totalBoardings, load.totalAlightings) ||
      !close(load.peakLoad, e.peakLoad)
    )
      errors.push("列車乗降・車内収支不一致");
    for (let i = 0; i < load.stops.length; i++) {
      const s = load.stops[i];
      if (
        ((s.status !== "stop" ||
          s.pickupAllowed === false ||
          s.departure === undefined) &&
          load.boardings[i] > 1e-7) ||
        ((s.status !== "stop" ||
          s.dropoffAllowed === false ||
          s.arrival === undefined) &&
          load.alightings[i] > 1e-7)
      )
        errors.push("乗降不可駅で乗降");
    }
  }
  for (const l of result.loads) {
    const e = expectedByKey.get(l.key);
    if (!e) continue;
    if (
      l.boardings.length !== e.boardings.length ||
      l.alightings.length !== e.alightings.length ||
      l.segmentLoads.length !== e.segmentLoads.length ||
      l.stops.length !== e.stops.length ||
      JSON.stringify(l.stops) !== JSON.stringify(e.stops) ||
      !close(l.totalBoardings, e.totalBoardings) ||
      !close(l.totalAlightings, e.totalAlightings) ||
      !close(l.uniquePassengers, e.uniquePassengers) ||
      l.capacity !== e.capacity ||
      l.capacitySource !== e.capacitySource ||
      JSON.stringify(l.peakSegments) !== JSON.stringify(e.peakSegments) ||
      l.occupancies.length !== e.occupancies.length ||
      l.occupancies.some((v, i) =>
        v === null
          ? e.occupancies[i] !== null
          : e.occupancies[i] === null || !close(v, e.occupancies[i]!),
      ) ||
      (l.peakOccupancy === null
        ? e.peakOccupancy !== null
        : e.peakOccupancy === null || !close(l.peakOccupancy, e.peakOccupancy))
    )
      errors.push("列車集計・定員・区間数不一致");
  }
  if (
    result.loads.length !== expected.length ||
    new Set(result.loads.map((l) => l.key)).size !== expected.length ||
    !close(t.boardingEvents, sum(result.loads.map((l) => l.totalBoardings)))
  )
    errors.push("列車数・乗車イベント不一致");
  return [...new Set(errors)];
}
