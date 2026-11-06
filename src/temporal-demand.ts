import type { Project } from "./model";
import { generateDemand } from "./demand";
import {
  purposes,
  validateTemporalConfig,
  type TemporalConfig,
  type TemporalState,
  type DailyOD,
  type TimedOD,
} from "./temporal-model";

export function defaultTemporalConfig(start = 4 * 3600): TemporalConfig {
  const hourly = (purpose: string) =>
    Array.from({ length: 24 }, (_, i) => {
      const h = (i + start / 3600) % 24;
      return purpose === "commute" || purpose === "school"
        ? h === 7
          ? 4
          : h === 8
            ? 5
            : h === 6
              ? 1
              : 0.05
        : h >= 9 && h <= 19
          ? 1
          : 0.02;
    });
  return {
    id: "daily-1",
    name: "日間需要シナリオ",
    serviceDayStart: start,
    slotMinutes: 60,
    beta: 0.05,
    rounding: "fractional",
    purposes: purposes.map((purpose) => ({
      purpose,
      generation:
        purpose === "commute" ? 0.15 : purpose === "school" ? 0.06 : 0.04,
      employmentWeight: purpose === "commute" ? 1 : 0,
      studentWeight: purpose === "school" ? 1 : 0,
      attractionWeight: purpose === "shopping" || purpose === "private" ? 1 : 0,
      timeWeights: hourly(purpose),
      returnShare: 1,
      stayDistribution: [
        {
          minutes:
            purpose === "commute" ? 480 : purpose === "school" ? 360 : 60,
          weight: 0.7,
        },
        {
          minutes:
            purpose === "commute" ? 600 : purpose === "school" ? 480 : 180,
          weight: 0.3,
        },
      ],
    })),
  };
}
/** Fractional residual goes to the last nonzero bucket; integer mode uses largest remainders. */
export function allocateVolume(
  total: number,
  weights: number[],
  integer = false,
): number[] {
  if (
    !Number.isFinite(total) ||
    total < 0 ||
    !weights.length ||
    weights.some((w) => !Number.isFinite(w) || w < 0) ||
    weights.reduce((a, b) => a + b, 0) <= 0
  )
    throw new Error("配分人数・重みが不正です");
  if (integer && !Number.isInteger(total))
    throw new Error("整数配分には整数の日間人数が必要です");
  const sum = weights.reduce((a, b) => a + b, 0),
    raw = weights.map((w) => (total * w) / sum);
  if (integer) {
    const result = raw.map(Math.floor);
    let residual = total - result.reduce((a, b) => a + b, 0);
    for (const i of raw
      .map((x, i) => ({ i, remainder: x - result[i] }))
      .sort((a, b) => b.remainder - a.remainder || a.i - b.i)
      .slice(0, residual))
      result[i.i]++;
    return result;
  }
  let last = weights.length - 1;
  while (weights[last] === 0) last--;
  raw[last] = Math.max(
    0,
    total - raw.reduce((s, x, i) => (i === last ? s : s + x), 0),
  );
  return raw;
}
export function resplitTemporal(
  state: Pick<
    TemporalState,
    "config" | "costs" | "dailyOutbound" | "generated" | "unallocated"
  > &
    Partial<Pick<TemporalState, "manualSplits" | "dailyCoefficientSnapshot">>,
): TemporalState {
  const { config: c, costs } = state;
  validateTemporalConfig(c);
  const slots: TimedOD[] = [],
    daily: DailyOD[] = [],
    warnings: string[] = [];
  for (const input of state.dailyOutbound) {
    if (
      input.kind !== "outbound" ||
      input.origin === input.destination ||
      !Number.isFinite(input.passengers) ||
      input.passengers < 0
    )
      throw new Error("日間往路ODが不正です");
    const profile = c.purposes.find((p) => p.purpose === input.purpose);
    if (!profile) throw new Error("目的別設定がありません");
    const row = {
      ...input,
      passengers:
        c.rounding === "integer"
          ? Math.round(input.passengers)
          : input.passengers,
    };
    daily.push(row);
    const override = state.manualSplits?.find(
      (s) =>
        s.origin === row.origin &&
        s.destination === row.destination &&
        s.purpose === row.purpose,
    );
    const weights =
      override && override.counts.reduce((s, n) => s + n, 0) > 0
        ? override.counts
        : profile.timeWeights;
    const outbound = allocateVolume(
      row.passengers,
      weights,
      c.rounding === "integer",
    );
    outbound.forEach((passengers, i) => {
      if (passengers > 0)
        slots.push({
          ...row,
          passengers,
          start: c.serviceDayStart + i * c.slotMinutes * 60,
          end: c.serviceDayStart + (i + 1) * c.slotMinutes * 60,
        });
    });
    const returnTotal =
      c.rounding === "integer"
        ? Math.round(row.passengers * profile.returnShare)
        : row.passengers * profile.returnShare;
    if (!returnTotal) continue;
    const travel = costs[row.origin]?.[row.destination];
    if (travel === undefined) {
      warnings.push(
        `${row.origin}→${row.destination}: 固定移動時間がないため帰路${returnTotal}人を生成できません`,
      );
      continue;
    }
    const returnWeights = new Map<number, number>();
    outbound.forEach((n, i) => {
      if (!n) return;
      for (const stay of profile.stayDistribution) {
        const when =
          c.serviceDayStart +
          i * c.slotMinutes * 60 +
          (travel + stay.minutes) * 60;
        const bin = Math.floor(
          (when - c.serviceDayStart) / (c.slotMinutes * 60),
        );
        returnWeights.set(bin, (returnWeights.get(bin) ?? 0) + n * stay.weight);
      }
    });
    const bins = [...returnWeights.keys()].sort((a, b) => a - b),
      returns = allocateVolume(
        returnTotal,
        bins.map((i) => returnWeights.get(i)!),
        c.rounding === "integer",
      );
    const back: DailyOD = {
      origin: row.destination,
      destination: row.origin,
      purpose: row.purpose,
      passengers: returnTotal,
      source: "estimated",
      kind: "return",
    };
    daily.push(back);
    returns.forEach((passengers, i) => {
      if (passengers > 0)
        slots.push({
          ...back,
          passengers,
          start: c.serviceDayStart + bins[i] * c.slotMinutes * 60,
          end: c.serviceDayStart + (bins[i] + 1) * c.slotMinutes * 60,
        });
    });
  }
  return {
    ...state,
    config: structuredClone(c),
    costs: structuredClone(costs),
    dailyOutbound: daily
      .filter((r) => r.kind === "outbound")
      .map((r) => ({ ...r })),
    daily,
    slots,
    warnings,
  };
}
export function generateTemporalDemand(
  p: Project,
  config: TemporalConfig,
  costs: Project["costs"] = p.costs,
): TemporalState {
  validateTemporalConfig(config);
  let generated = 0,
    unallocated = 0;
  const dailyOutbound: DailyOD[] = [];
  const warnings: string[] = [];
  for (const profile of config.purposes) {
    const result = generateDemand(
      {
        ...p,
        parameters: {
          ...p.parameters,
          ...profile,
          beta: config.beta,
          period: "1日",
        },
      },
      costs,
    );
    generated += result.generated;
    unallocated += result.unallocated;
    warnings.push(...result.warnings);
    for (const d of result.demands)
      dailyOutbound.push({
        origin: d.origin,
        destination: d.destination,
        purpose: d.purpose,
        passengers: d.passengers,
        source: d.source,
        kind: "outbound",
      });
  }
  const result = resplitTemporal({
    config,
    costs,
    dailyOutbound,
    generated,
    unallocated,
    dailyCoefficientSnapshot: structuredClone(config),
  });
  result.warnings = [...warnings, ...result.warnings];
  return result;
}
export function resizeTimeSlots(
  config: TemporalConfig,
  minutes: 60 | 15,
): TemporalConfig {
  if (config.slotMinutes === minutes) return structuredClone(config);
  const next = structuredClone(config);
  next.slotMinutes = minutes;
  for (const p of next.purposes)
    p.timeWeights =
      minutes === 15
        ? p.timeWeights.flatMap((w) => [w / 4, w / 4, w / 4, w / 4])
        : Array.from({ length: 24 }, (_, h) =>
            p.timeWeights.slice(h * 4, h * 4 + 4).reduce((a, b) => a + b, 0),
          );
  return next;
}
