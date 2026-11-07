import type { AssignmentDemand, AssignmentConfig } from "./assignment-model";
export interface ArrivalModel {
  mode: "representative" | "minute";
  distribution: "uniform" | "front" | "back" | "custom";
  stepSeconds: number;
  weights?: number[];
}
export function validateArrivalModel(m: ArrivalModel) {
  if (
    !m ||
    !["representative", "minute"].includes(m.mode) ||
    !["uniform", "front", "back", "custom"].includes(m.distribution) ||
    !Number.isFinite(m.stepSeconds) ||
    m.stepSeconds < 1 ||
    m.stepSeconds > 3600 ||
    (m.mode === "representative" && m.distribution !== "uniform") ||
    (m.distribution === "custom" &&
      (!Array.isArray(m.weights) ||
        !m.weights.length ||
        m.weights.some((n) => !Number.isFinite(n) || n < 0) ||
        !m.weights.some((n) => n > 0)))
  )
    throw new Error("駅到着分布の方式・刻み・重みが不正です");
}
export function arrivalWeight(
  row: AssignmentDemand,
  a: number,
  b: number,
  c: AssignmentConfig,
): number {
  if (!(b > a)) return 0;
  const m = c.arrivalModel;
  if (!m || m.distribution === "uniform") return b - a;
  const width = row.end - row.start,
    x = (a - row.start) / width,
    y = (b - row.start) / width;
  if (m.distribution === "front")
    return width * (2 * (y - x) - (y * y - x * x));
  if (m.distribution === "back") return width * (y * y - x * x);
  const weights = m.weights!,
    n = weights.length;
  let value = 0;
  for (
    let i = Math.max(0, Math.floor(x * n));
    i < Math.min(n, Math.ceil(y * n));
    i++
  )
    value +=
      Math.max(
        0,
        Math.min(b, row.start + ((i + 1) * width) / n) -
          Math.max(a, row.start + (i * width) / n),
      ) * weights[i];
  return value;
}
export function selectedDemand(row: AssignmentDemand, c: AssignmentConfig) {
  const a = Math.max(row.start, c.start),
    b = Math.min(row.end, c.end);
  if (!(b > a)) return 0;
  if (!c.arrivalModel || c.arrivalModel.distribution === "uniform")
    return (row.passengers * (b - a)) / (row.end - row.start);
  return (
    (row.passengers * arrivalWeight(row, a, b, c)) /
    arrivalWeight(row, row.start, row.end, c)
  );
}
export function arrivalBreaks(
  row: AssignmentDemand,
  start: number,
  end: number,
  boundaries: Set<number>,
  c: AssignmentConfig,
) {
  if (c.arrivalModel?.mode !== "minute") return;
  const step = c.arrivalModel.stepSeconds;
  if ((end - start) / step > 100000)
    throw new Error(
      "到着枠が多すぎます。需要時間窓を短くするか刻みを広げてください",
    );
  for (
    let t = row.start + (Math.floor((start - row.start) / step) + 1) * step;
    t < end;
    t += step
  )
    if (t > start) boundaries.add(t);
  if (c.arrivalModel.distribution === "custom") {
    const n = c.arrivalModel.weights!.length;
    for (let i = 1; i < n; i++) {
      const t = row.start + ((row.end - row.start) * i) / n;
      if (t > start && t < end) boundaries.add(t);
    }
  }
}
