import type { AssignmentResult } from "./assignment-model";
export type AuditState =
  "notStarted" | "waiting" | "inTransit" | "walking" | "completed" | "noPath";
export interface TraceEvent {
  sequence: number;
  time: number;
  kind: string;
  packetId: number;
  parentId?: number;
  cohortId: string;
  demandIndex: number;
  passengers: number;
  datasetId: string;
  stationId: string;
  trainKey?: string;
  from: AuditState;
  to: AuditState;
  detail: string;
}
export interface AuditPoint {
  time: number;
  states: Record<AuditState, number>;
  total: number;
  error: number;
}
export interface AssignmentAudit {
  version: "0.6";
  mode: "summary" | "full";
  rule: string;
  events: TraceEvent[];
  counts: Record<string, number>;
  points: AuditPoint[];
  checks: number;
  errors: string[];
  timings: Record<string, number>;
  snapshotIntervalNotice: boolean;
}
export const emptyStates = (): Record<AuditState, number> => ({
  notStarted: 0,
  waiting: 0,
  inTransit: 0,
  walking: 0,
  completed: 0,
  noPath: 0,
});
export function createRecorder(total: number, mode: "summary" | "full") {
  const states = emptyStates();
  states.notStarted = total;
  const data: AssignmentAudit = {
    version: "0.6",
    mode,
    rule: "同時刻一括・乗車可能時刻FIFO・同着比例・最大剰余。整数同余はOD内容・到着時刻・経路の順。",
    events: [],
    counts: {},
    points: [],
    checks: 0,
    errors: [],
    timings: {},
    snapshotIntervalNotice: false,
  };
  let sequence = 0;
  return {
    data,
    record(e: Omit<TraceEvent, "sequence">) {
      data.counts[e.kind] = (data.counts[e.kind] ?? 0) + 1;
      if (e.from !== e.to) {
        states[e.from] -= e.passengers;
        states[e.to] += e.passengers;
      }
      const error = Object.values(states).reduce((a, b) => a + b, 0) - total;
      data.checks++;
      if (
        Math.abs(error) > 1e-6 ||
        Object.values(states).some((n) => n < -1e-6)
      )
        throw new Error("計算途中の人数収支エラー");
      if (mode === "full") {
        if (data.events.length >= 500000)
          throw new Error(
            "全件診断が50万件を超えました。概要記録に切り替えてください",
          );
        data.events.push({ ...e, sequence: sequence++ });
      }
    },
    point(time: number) {
      const point = {
        time,
        states: { ...states },
        total,
        error: Object.values(states).reduce((a, b) => a + b, 0) - total,
      };
      if (data.points.at(-1)?.time === time)
        data.points[data.points.length - 1] = point;
      else data.points.push(point);
      if (data.points.length > 1000) {
        data.points = data.points.filter(
          (_, i) => i % 2 === 0 || i === data.points.length - 1,
        );
        data.snapshotIntervalNotice = true;
      }
    },
  };
}
export function statesAt(r: AssignmentResult, time: number) {
  const a = r.audit;
  if (!a) throw new Error("診断付き方式の結果が必要です");
  if (a.mode !== "full")
    return (
      a.points.filter((p) => p.time <= time).at(-1) ?? {
        time: 0,
        total: r.totals.selected,
        error: 0,
        states: { ...emptyStates(), notStarted: r.totals.selected },
      }
    );
  const states = { ...emptyStates(), notStarted: r.totals.selected };
  for (const e of a.events)
    if (e.time <= time && e.from !== e.to) {
      states[e.from] -= e.passengers;
      states[e.to] += e.passengers;
    }
  return {
    time,
    states,
    total: r.totals.selected,
    error: Object.values(states).reduce((a, b) => a + b, 0) - r.totals.selected,
  };
}
