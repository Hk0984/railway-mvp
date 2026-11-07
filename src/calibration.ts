import type { Project } from "./model";
import {
  validateTemporalConfig,
  type DailyOD,
  type TemporalConfig,
} from "./temporal-model";
import { parseCsv, csv } from "./io";
import { trainVisits } from "./analysis";
import type { AssignmentResult } from "./assignment-model";
export function evaluateTrainObservations(
  result: AssignmentResult,
  observations: Observation[],
  period: string,
): ErrorMetric {
  const loads = result.capacity?.loads ?? result.loads;
  const excluded: { id: string; reason: string }[] = [];
  const rows = observations
    .filter((o) => o.kind === "load" && o.period === period)
    .flatMap((o) => {
      if (
        (o.dayGroup && o.dayGroup !== result.config.serviceMapping?.group) ||
        (o.startSeconds !== undefined &&
          (o.startSeconds !== result.config.start ||
            o.endSeconds !==
              (result.capacity?.horizon ??
                result.config.simulationEnd ??
                result.config.end + result.config.maxJourneySeconds)))
      ) {
        excluded.push({
          id: o.id,
          reason: "曜日区分・輸送計算の観測期間が一致しません",
        });
        return [];
      }
      const matches = loads.filter(
        (l) =>
          l.timetableId === o.timetableId &&
          l.trainId === o.trainId &&
          (!o.datasetId || l.datasetId === o.datasetId),
      );
      const l = matches.length === 1 ? matches[0] : undefined,
        i = o.segmentIndex!;
      if (!l || l.segmentObserved?.[i] === false) {
        excluded.push({
          id: o.id,
          reason: "対象便・区間が一意でない、または期間外です",
        });
        return [];
      }
      const estimated = l.segmentLoads[i];
      if (estimated === undefined) return [];
      const error = estimated - o.value;
      return [
        {
          id: o.id,
          observed: o.value,
          estimated,
          error,
          relativeError: o.value ? error / o.value : null,
          role: o.role,
        },
      ];
    });
  return {
    count: rows.length,
    meanError: rows.length
      ? rows.reduce((s, r) => s + r.error, 0) / rows.length
      : null,
    excluded,
    mae: rows.length
      ? rows.reduce((s, r) => s + Math.abs(r.error), 0) / rows.length
      : null,
    rmse: rows.length
      ? Math.sqrt(rows.reduce((s, r) => s + r.error * r.error, 0) / rows.length)
      : null,
    rows,
  };
}
import {
  generateTemporalDemand,
  defaultTemporalConfig,
} from "./temporal-demand";
export interface Observation {
  datasetId?: string;
  dayGroup?: string;
  startSeconds?: number;
  endSeconds?: number;
  id: string;
  kind: "boarding" | "alighting" | "od" | "load";
  stationId: string;
  origin: string;
  destination: string;
  timetableId: string;
  trainId: string;
  segmentIndex: number | null;
  period: string;
  value: number;
  source: string;
  role: "fit" | "validation";
}
export interface ErrorMetric {
  meanError?: number | null;
  excluded?: { id: string; reason: string }[];
  count: number;
  mae: number | null;
  rmse: number | null;
  rows: {
    id: string;
    observed: number;
    estimated: number;
    error: number;
    relativeError: number | null;
    role: string;
  }[];
}
export interface CalibrationRun {
  observationSnapshot?: Observation[];
  id: string;
  period: string;
  targetStations: string[];
  iterations: number;
  converged: boolean;
  excluded: { id: string; reason: string }[];
  before: ErrorMetric;
  after: ErrorMetric;
  seedCoefficients: TemporalConfig;
  selectedCoefficients: TemporalConfig;
  seedDaily: DailyOD[];
  costSnapshot: Project["costs"];
  daily: DailyOD[];
  method: string;
}
const columns = [
  "kind",
  "stationId",
  "origin",
  "destination",
  "timetableId",
  "trainId",
  "segmentIndex",
  "period",
  "value",
  "source",
  "role",
];
export function observationTemplate(extended = false) {
  return csv([
    extended
      ? [...columns, "datasetId", "dayGroup", "startSeconds", "endSeconds"]
      : columns,
    extended
      ? [
          "od",
          "",
          "s0",
          "s4",
          "",
          "",
          "",
          "対象期間",
          100,
          "出典を記入",
          "fit",
          "",
          "",
          "",
          "",
        ]
      : [
          "od",
          "",
          "s0",
          "s4",
          "",
          "",
          "",
          "対象期間",
          100,
          "出典を記入",
          "fit",
        ],
  ]);
}
export function validateObservations(p: Project, rows: Observation[]) {
  const ids = new Set(p.stations.map((s) => s.id)),
    keys = new Set<string>();
  for (const r of rows) {
    if (
      (r.datasetId !== undefined && r.datasetId !== p.datasetId) ||
      (r.dayGroup !== undefined && !r.dayGroup.trim()) ||
      ((r.startSeconds !== undefined || r.endSeconds !== undefined) &&
        (!Number.isFinite(r.startSeconds) ||
          !Number.isFinite(r.endSeconds) ||
          r.startSeconds! < 0 ||
          r.endSeconds! <= r.startSeconds!))
    )
      throw new Error("観測のデータセット・曜日・時間条件が不正です");
    const key = JSON.stringify([
      r.kind,
      r.stationId,
      r.origin,
      r.destination,
      r.timetableId,
      r.trainId,
      r.segmentIndex,
      r.period,
      r.role,
      r.datasetId,
      r.dayGroup,
      r.startSeconds,
      r.endSeconds,
    ]);
    if (
      !r.id ||
      !["boarding", "alighting", "od", "load"].includes(r.kind) ||
      !r.period?.trim() ||
      !r.source?.trim() ||
      !["fit", "validation"].includes(r.role) ||
      !Number.isFinite(r.value) ||
      r.value < 0 ||
      keys.has(key)
    )
      throw new Error(
        "実測データの形式・期間・出典・値・重複を確認してください",
      );
    keys.add(key);
    if (
      (["boarding", "alighting"].includes(r.kind) && !ids.has(r.stationId)) ||
      (r.kind === "od" &&
        (!ids.has(r.origin) ||
          !ids.has(r.destination) ||
          r.origin === r.destination))
    )
      throw new Error("実測データの駅IDが一致しません");
    if (r.kind === "load") {
      const train = p.timetables
        .find((d) => d.id === r.timetableId)
        ?.trains.find((t) => t.id === r.trainId);
      if (
        !train ||
        !Number.isInteger(r.segmentIndex) ||
        r.segmentIndex! < 0 ||
        r.segmentIndex! >= trainVisits(train).length - 1
      )
        throw new Error("実測列車・区間位置が一致しません");
    }
  }
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error("実測データID重複");
}
export function importObservations(p: Project, text: string) {
  const [header, ...lines] = parseCsv(text);
  const extended =
    JSON.stringify(header) ===
    JSON.stringify([
      ...columns,
      "datasetId",
      "dayGroup",
      "startSeconds",
      "endSeconds",
    ]);
  if (
    !header ||
    (!extended && JSON.stringify(header) !== JSON.stringify(columns))
  )
    throw new Error("実測CSVの列はテンプレートと同じ順序で指定してください");
  const result = lines
    .filter((r) => r.some(Boolean))
    .map((r, i) => {
      if (
        r.length !== (extended ? columns.length + 4 : columns.length) ||
        !r[8].trim()
      )
        throw new Error("実測CSVの列数・人数が不正です");
      return {
        id: `obs-${i}`,
        kind: r[0],
        stationId: r[1],
        origin: r[2],
        destination: r[3],
        timetableId: r[4],
        trainId: r[5],
        segmentIndex: r[6] === "" ? null : Number(r[6]),
        period: r[7],
        value: Number(r[8]),
        source: r[9],
        role: r[10],
        ...(extended
          ? {
              datasetId: r[11] || undefined,
              dayGroup: r[12] || undefined,
              startSeconds: r[13] === "" ? undefined : Number(r[13]),
              endSeconds: r[14] === "" ? undefined : Number(r[14]),
            }
          : {}),
      } as Observation;
    });
  validateObservations(p, result);
  return result;
}
function predicted(daily: DailyOD[], r: Observation) {
  return daily
    .filter((d) =>
      r.kind === "od"
        ? d.origin === r.origin && d.destination === r.destination
        : r.kind === "boarding"
          ? d.origin === r.stationId
          : d.destination === r.stationId,
    )
    .reduce((s, d) => s + d.passengers, 0);
}
export function evaluateObservations(
  daily: DailyOD[],
  observations: Observation[],
  role?: Observation["role"],
): ErrorMetric {
  const rows = observations
    .filter((r) => r.kind !== "load" && (!role || r.role === role))
    .map((r) => {
      const estimated = predicted(daily, r),
        error = estimated - r.value;
      return {
        id: r.id,
        observed: r.value,
        estimated,
        error,
        relativeError: r.value === 0 ? null : error / r.value,
        role: r.role,
      };
    });
  return {
    count: rows.length,
    meanError: rows.length
      ? rows.reduce((s, r) => s + r.error, 0) / rows.length
      : null,
    mae: rows.length
      ? rows.reduce((s, r) => s + Math.abs(r.error), 0) / rows.length
      : null,
    rmse: rows.length
      ? Math.sqrt(rows.reduce((s, r) => s + r.error * r.error, 0) / rows.length)
      : null,
    rows,
  };
}
/** Fit marginal trip ends only after explicit confirmation of the count semantics. Structural zeros remain zero. */
export function calibrateDemand(
  p: Project,
  seed: DailyOD[],
  observations: Observation[],
  period: string,
  stationCountsAsTripEnds = false,
  fitCoefficients = false,
): CalibrationRun {
  validateObservations(p, observations);
  validateCalibrationDaily(p, seed);
  const selected = observations.filter((r) => r.period === period),
    excluded = observations
      .filter((r) => r.period !== period)
      .map((r) => ({ id: r.id, reason: "別の観測期間" }));
  for (const r of selected)
    if (
      r.kind === "load" ||
      (["boarding", "alighting"].includes(r.kind) && !stationCountsAsTripEnds)
    )
      excluded.push({
        id: r.id,
        reason:
          r.kind === "load"
            ? "列車実測は配分検証用として分離"
            : "駅別乗降とOD発生集中の同一視が未承認",
      });
  if (
    new Set(
      selected.map((o) =>
        JSON.stringify([
          o.datasetId ?? p.datasetId,
          o.dayGroup,
          o.startSeconds,
          o.endSeconds,
        ]),
      ),
    ).size > 1
  )
    throw new Error(
      "同一期間に異なる観測条件が混在しています。期間ラベルを分けてください",
    );
  const accepted = selected.filter((r) => !excluded.some((e) => e.id === r.id)),
    fit = accepted.filter((r) => r.role === "fit"),
    constraints = fit.filter((r) => r.kind !== "od");
  let daily = structuredClone(seed),
    iterations = 0,
    converged = constraints.length === 0;
  const c = structuredClone(
      p.temporal?.config ?? p.temporalConfig ?? defaultTemporalConfig(),
    ),
    seedCoefficients = structuredClone(c);
  let selectedCoefficients = structuredClone(c);
  if (
    accepted.some(
      (o) =>
        o.startSeconds !== undefined &&
        (o.startSeconds !== c.serviceDayStart ||
          o.endSeconds !== c.serviceDayStart + 86400),
    )
  )
    throw new Error(
      "日間往路ODの校正に部分時間帯の観測は使用できません。日間全体の条件を指定してください",
    );
  // Bounded grid search, trained exclusively on fit OD; validation rows never influence selection.
  if (fitCoefficients && fit.some((r) => r.kind === "od")) {
    let best = Infinity;
    for (const beta of [...new Set([c.beta, 0, 0.01, 0.025, 0.05, 0.1, 0.2])])
      for (const multiplier of [0.5, 1, 2]) {
        const candidate = structuredClone(c);
        candidate.beta = beta;
        candidate.purposes.forEach((x) => (x.employmentWeight *= multiplier));
        const d = generateTemporalDemand(
          p,
          candidate,
          p.temporal?.costs ?? p.costs,
        ).dailyOutbound;
        const score =
          evaluateObservations(
            d,
            fit.filter((r) => r.kind === "od"),
          ).rmse ?? Infinity;
        if (score < best) {
          best = score;
          daily = d;
          selectedCoefficients = candidate;
        }
      }
  }
  const key = (r: Observation) =>
    r.kind === "boarding" ? "origin" : "destination";
  const rowObs = constraints.filter((r) => r.kind === "boarding"),
    colObs = constraints.filter((r) => r.kind === "alighting");
  if (
    rowObs.length === p.stations.length &&
    colObs.length === p.stations.length &&
    Math.abs(
      rowObs.reduce((s, r) => s + r.value, 0) -
        colObs.reduce((s, r) => s + r.value, 0),
    ) > 1e-6
  )
    throw new Error("全駅の発生・集中観測総量が不一致で校正できません");
  for (; iterations < 500 && !converged; iterations++) {
    for (const r of constraints) {
      const field = key(r),
        current = daily
          .filter((d) => d[field] === r.stationId)
          .reduce((s, d) => s + d.passengers, 0);
      if (current === 0 && r.value > 0) {
        if (!excluded.some((e) => e.id === r.id))
          excluded.push({
            id: r.id,
            reason: "構造的ゼロで正の観測値に到達不能",
          });
        continue;
      }
      const factor = current ? r.value / current : 0;
      daily = daily.map((d) =>
        d[field] === r.stationId
          ? { ...d, passengers: d.passengers * factor, source: "estimated" }
          : d,
      );
    }
    converged = constraints.every(
      (r) => Math.abs(predicted(daily, r) - r.value) <= 1e-6 + 1e-8 * r.value,
    );
  }
  daily = daily.map((d) => ({ ...d, source: "estimated" }));
  return {
    id: crypto.randomUUID(),
    period,
    targetStations: [...new Set(constraints.map((r) => r.stationId))],
    iterations,
    converged,
    excluded,
    before: evaluateObservations(seed, accepted),
    after: evaluateObservations(daily, accepted),
    seedCoefficients,
    selectedCoefficients,
    seedDaily: structuredClone(seed),
    costSnapshot: structuredClone(p.temporal?.costs ?? p.costs),
    observationSnapshot: structuredClone(selected),
    daily,
    method: fitCoefficients
      ? "有界格子探索（β・雇用吸引係数倍率）→IPF"
      : "IPF（部分発生・集中制約）",
  };
}
export function validateCalibrationDaily(p: Project, rows: DailyOD[]) {
  const ids = new Set(p.stations.map((s) => s.id));
  if (
    !Array.isArray(rows) ||
    rows.some(
      (d) =>
        !ids.has(d.origin) ||
        !ids.has(d.destination) ||
        d.origin === d.destination ||
        !Number.isFinite(d.passengers) ||
        d.passengers < 0 ||
        !["commute", "school", "shopping", "private"].includes(d.purpose) ||
        d.kind !== "outbound" ||
        !["observed", "manual", "estimated"].includes(d.source),
    )
  )
    throw new Error("校正往路ODの形式不正");
}
export function validateCalibrationRun(p: Project, r: CalibrationRun) {
  if (
    !r ||
    !r.id ||
    typeof r.period !== "string" ||
    typeof r.converged !== "boolean" ||
    !Number.isInteger(r.iterations) ||
    r.iterations < 0 ||
    !Array.isArray(r.excluded) ||
    r.excluded.some((e) => !e.id || typeof e.reason !== "string") ||
    !Array.isArray(r.targetStations) ||
    r.targetStations.some((id) => !p.stations.some((s) => s.id === id))
  )
    throw new Error("校正結果の形式不正");
  validateCalibrationDaily(p, r.daily);
  if (r.seedDaily) validateCalibrationDaily(p, r.seedDaily);
  validateTemporalConfig(r.seedCoefficients);
  validateTemporalConfig(r.selectedCoefficients);
  for (const m of [r.before, r.after])
    if (
      !m ||
      !Array.isArray(m.rows) ||
      m.count !== m.rows.length ||
      [m.mae, m.rmse].some(
        (v) => v !== null && (!Number.isFinite(v) || v < 0),
      ) ||
      m.rows.some(
        (v) =>
          !Number.isFinite(v.estimated) ||
          !Number.isFinite(v.observed) ||
          !Number.isFinite(v.error) ||
          (v.relativeError !== null && !Number.isFinite(v.relativeError)),
      )
    )
      throw new Error("校正誤差記録が不正です");
}
