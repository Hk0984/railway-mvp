import type { Project } from "./model";
import type { CapacitySpec } from "./capacity-model";
import type { TemporalState } from "./temporal-model";
import { validateTemporalState } from "./temporal-model";
import {
  generateTemporalDemand,
  defaultTemporalConfig,
  resplitTemporal,
} from "./temporal-demand";
import {
  validateObservations,
  validateCalibrationRun,
  type Observation,
  type CalibrationRun,
} from "./calibration";
export interface DemandScenario {
  capacityOverride?: CapacitySpec;
  id: string;
  name: string;
  mode: "automatic" | "observed" | "hybrid";
  temporal: TemporalState;
  assumptions: string;
  created: string;
}
export interface AnalyticsState {
  version: 1;
  observations: Observation[];
  calibrations: CalibrationRun[];
  scenarios: DemandScenario[];
  activeScenarioId?: string;
}
export function analytics(p: Project) {
  return (p.analytics ??= {
    version: 1,
    observations: [],
    calibrations: [],
    scenarios: [],
  });
}
export function validateAnalytics(p: Project) {
  const a = p.analytics;
  if (!a) return;
  if (
    a.version !== 1 ||
    !Array.isArray(a.scenarios) ||
    !Array.isArray(a.observations) ||
    !Array.isArray(a.calibrations)
  )
    throw new Error("分析保存データの形式不正");
  validateObservations(p, a.observations);
  const ids = new Set(p.stations.map((s) => s.id));
  for (const s of a.scenarios) {
    if (
      s.capacityOverride &&
      (!Number.isInteger(s.capacityOverride.value) ||
        s.capacityOverride.value <= 0 ||
        s.capacityOverride.kind !== "transport" ||
        !s.capacityOverride.basis?.trim())
    )
      throw new Error("シナリオの輸送定員が不正です");
    if (
      !s.id ||
      !s.name?.trim() ||
      !["automatic", "observed", "hybrid"].includes(s.mode) ||
      typeof s.assumptions !== "string"
    )
      throw new Error("需要シナリオ不正");
    validateTemporalState(s.temporal, ids);
  }
  if (
    new Set(a.scenarios.map((s) => s.id)).size !== a.scenarios.length ||
    (a.activeScenarioId &&
      !a.scenarios.some((s) => s.id === a.activeScenarioId))
  )
    throw new Error("シナリオID不正");
  for (const r of a.calibrations)
    if (
      !r.id ||
      typeof r.converged !== "boolean" ||
      !Array.isArray(r.daily) ||
      r.daily.some(
        (d) =>
          !ids.has(d.origin) ||
          !ids.has(d.destination) ||
          !Number.isFinite(d.passengers) ||
          d.passengers < 0,
      )
    )
      throw new Error("校正結果不正");
  for (const r of a.calibrations) validateCalibrationRun(p, r);
}
export function projectForScenario(p: Project, s?: DemandScenario): Project {
  const value: Project = {
    ...p,
    analytics: undefined,
    temporal: undefined,
    temporalConfig: undefined,
  };
  if (s?.capacityOverride) {
    value.timetables = p.timetables.map((d) => ({
      ...d,
      trains: d.trains.map((t) => ({ ...t, capacity: undefined })),
    }));
    value.typeCapacities = undefined;
    value.capacitySettings = {
      timetables: Object.fromEntries(
        p.timetables.map((d) => [d.id, structuredClone(s.capacityOverride!)]),
      ),
      trains: {},
      types: {},
    };
  }
  return value;
}
export function buildScenario(
  p: Project,
  name: string,
  mode: DemandScenario["mode"],
  period: string,
  factors = {
    population: 1,
    employment: 1,
    students: 1,
    railShare: 1,
    concentration: 1,
  },
): DemandScenario {
  if (
    !name.trim() ||
    Object.values(factors).some((n) => !Number.isFinite(n) || n < 0)
  )
    throw new Error("シナリオ名・倍率を確認してください");
  const clone = structuredClone(p);
  clone.stations = clone.stations.map((s) => ({
    ...s,
    population: s.population * factors.population,
    employment: s.employment * factors.employment,
    students: s.students * factors.students,
    railShare: Math.min(1, s.railShare * factors.railShare),
  }));
  const c = structuredClone(
    p.temporal?.config ?? p.temporalConfig ?? defaultTemporalConfig(),
  );
  c.purposes.forEach(
    (x) =>
      (x.timeWeights = x.timeWeights.map((w) =>
        Math.pow(w, factors.concentration),
      )),
  );
  let state = generateTemporalDemand(clone, c, p.temporal?.costs ?? p.costs);
  if (mode !== "automatic") {
    const rows = analytics(p).observations.filter(
      (r) => r.kind === "od" && r.period === period && r.role === "fit",
    );
    if (!rows.length) throw new Error("指定期間の実測ODがありません");
    const observed = rows.map((r) => ({
      origin: r.origin,
      destination: r.destination,
      purpose: "commute" as const,
      kind: "outbound" as const,
      source: "observed" as const,
      passengers: r.value,
    }));
    const keys = new Set(
      observed.map((r) => JSON.stringify([r.origin, r.destination])),
    );
    const dailyOutbound =
      mode === "observed"
        ? observed
        : [
            ...state.dailyOutbound.filter(
              (r) => !keys.has(JSON.stringify([r.origin, r.destination])),
            ),
            ...observed,
          ];
    state = resplitTemporal({
      ...state,
      dailyOutbound,
      manualSplits: [],
      generated: dailyOutbound.reduce((s, d) => s + d.passengers, 0),
      unallocated: 0,
    });
  }
  // Resplit imported observed OD using explicit existing temporal assumptions; source stays observed for outbound.
  return {
    id: crypto.randomUUID(),
    name,
    mode,
    temporal: state,
    created: new Date().toISOString(),
    assumptions: `人口×${factors.population}、雇用×${factors.employment}、学生×${factors.students}、利用率×${factors.railShare}（上限1）、時間重み指数${factors.concentration}。実績ODは目的情報がないため通勤往路として利用者が明示採用。期間=${period}`,
  };
}
