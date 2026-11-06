import type { Purpose } from "./model";
export const purposes: Purpose[] = ["commute", "school", "shopping", "private"];
export const purposeLabels: Record<Purpose, string> = {
  commute: "通勤",
  school: "通学",
  shopping: "買物",
  private: "その他私事",
};
export interface PurposeDistribution {
  purpose: Purpose;
  generation: number;
  employmentWeight: number;
  studentWeight: number;
  attractionWeight: number;
  timeWeights: number[];
  returnShare: number;
  stayDistribution: { minutes: number; weight: number }[];
}
export interface TemporalConfig {
  id: string;
  name: string;
  serviceDayStart: number;
  slotMinutes: 60 | 15;
  beta: number;
  rounding: "fractional" | "integer";
  purposes: PurposeDistribution[];
}
export interface DailyOD {
  origin: string;
  destination: string;
  purpose: Purpose;
  passengers: number;
  source: "estimated" | "observed" | "manual";
  kind: "outbound" | "return";
}
export interface TimedOD extends DailyOD {
  start: number;
  end: number;
}
export interface ManualSplit {
  origin: string;
  destination: string;
  purpose: Purpose;
  counts: number[];
}
export interface TemporalState {
  config: TemporalConfig;
  costs: Record<string, Record<string, number>>;
  dailyOutbound: DailyOD[];
  daily: DailyOD[];
  slots: TimedOD[];
  generated: number;
  unallocated: number;
  warnings: string[];
  manualSplits?: ManualSplit[];
  dailyCoefficientSnapshot?: TemporalConfig;
}
export function validateTemporalConfig(c: TemporalConfig) {
  const finite = (x: number) => Number.isFinite(x) && x >= 0;
  if (
    !c ||
    !c.id ||
    typeof c.name !== "string" ||
    !finite(c.serviceDayStart) ||
    c.serviceDayStart >= 86400 ||
    ![60, 15].includes(c.slotMinutes) ||
    !finite(c.beta) ||
    !["fractional", "integer"].includes(c.rounding) ||
    !Array.isArray(c.purposes) ||
    c.purposes.length !== 4 ||
    new Set(c.purposes.map((p) => p.purpose)).size !== 4
  )
    throw new Error("時間帯需要の設定が不正です");
  for (const p of c.purposes) {
    if (
      !purposes.includes(p.purpose) ||
      ![
        p.generation,
        p.employmentWeight,
        p.studentWeight,
        p.attractionWeight,
        p.returnShare,
      ].every(finite) ||
      p.returnShare > 1 ||
      !Array.isArray(p.timeWeights) ||
      p.timeWeights.length !== 1440 / c.slotMinutes ||
      !p.timeWeights.every(finite) ||
      p.timeWeights.reduce((a, b) => a + b, 0) <= 0 ||
      !p.stayDistribution.length ||
      p.stayDistribution.some((s) => !finite(s.minutes) || !finite(s.weight)) ||
      p.stayDistribution.reduce((s, x) => s + x.weight, 0) <= 0
    )
      throw new Error(
        "目的別係数・時間帯比率・帰宅率・滞在分布を確認してください",
      );
  }
}
export function validateTemporalState(state: TemporalState, ids: Set<string>) {
  validateTemporalConfig(state.config);
  if (state.dailyCoefficientSnapshot)
    validateTemporalConfig(state.dailyCoefficientSnapshot);
  for (const s of state.manualSplits ?? [])
    if (
      !ids.has(s.origin) ||
      !ids.has(s.destination) ||
      s.origin === s.destination ||
      !purposes.includes(s.purpose) ||
      s.counts.length !== 1440 / state.config.slotMinutes ||
      s.counts.some((n) => !Number.isFinite(n) || n < 0)
    )
      throw new Error("手動時間帯配分が不正です");
  const validRow = (r: DailyOD) =>
    ids.has(r.origin) &&
    ids.has(r.destination) &&
    r.origin !== r.destination &&
    purposes.includes(r.purpose) &&
    Number.isFinite(r.passengers) &&
    r.passengers >= 0 &&
    ["estimated", "observed", "manual"].includes(r.source) &&
    ["outbound", "return"].includes(r.kind);
  if (
    ![state.dailyOutbound, state.daily, state.slots].every(Array.isArray) ||
    state.dailyOutbound.some((r) => !validRow(r) || r.kind !== "outbound") ||
    state.daily.some((r) => !validRow(r)) ||
    state.slots.some(
      (r) =>
        !validRow(r) ||
        !Number.isFinite(r.start) ||
        r.start < 0 ||
        r.end - r.start !== state.config.slotMinutes * 60,
    ) ||
    !Number.isFinite(state.generated) ||
    state.generated < 0 ||
    !Number.isFinite(state.unallocated) ||
    state.unallocated < -1e-6 ||
    !Array.isArray(state.warnings) ||
    state.warnings.some((w) => typeof w !== "string")
  )
    throw new Error("保存された日間・時間帯ODが不正です");
  for (const [o, row] of Object.entries(state.costs)) {
    if (!ids.has(o) || !row) throw new Error("固定費用行列の発駅ID不正");
    for (const [d, v] of Object.entries(row))
      if (!ids.has(d) || !Number.isFinite(v) || v < 0)
        throw new Error("固定費用行列の値不正");
  }
  const totals = new Map<string, number>();
  const key = (r: DailyOD) =>
    JSON.stringify([r.origin, r.destination, r.purpose, r.kind, r.source]);
  for (const r of state.daily)
    totals.set(key(r), (totals.get(key(r)) ?? 0) + r.passengers);
  for (const r of state.slots)
    totals.set(key(r), (totals.get(key(r)) ?? 0) - r.passengers);
  if ([...totals.values()].some((v) => Math.abs(v) > 1e-6))
    throw new Error("日間ODと時間帯ODの総量が一致しません");
  const outboundTotals = new Map<string, number>();
  for (const r of state.dailyOutbound)
    outboundTotals.set(
      key(r),
      (outboundTotals.get(key(r)) ?? 0) + r.passengers,
    );
  for (const r of state.daily.filter((r) => r.kind === "outbound"))
    outboundTotals.set(
      key(r),
      (outboundTotals.get(key(r)) ?? 0) - r.passengers,
    );
  if ([...outboundTotals.values()].some((n) => Math.abs(n) > 1e-6))
    throw new Error("往路の日間入力と保存結果が一致しません");
  if (
    state.slots.some(
      (r) =>
        !Number.isInteger(
          (r.start - state.config.serviceDayStart) /
            (state.config.slotMinutes * 60),
        ),
    )
  )
    throw new Error("時間帯ODの開始時刻が時間枠に整合しません");
  if (
    state.config.rounding === "integer" &&
    [...state.daily, ...state.slots].some(
      (r) => !Number.isInteger(r.passengers),
    )
  )
    throw new Error("整数モードの人数に小数があります");
}
