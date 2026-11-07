import type { AssignmentResult, AssignmentDemand } from "./assignment-model";
export function stableJson(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(stableJson).join(",") + "]";
  if (x && typeof x === "object")
    return (
      "{" +
      Object.entries(x)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableJson(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(x) ?? "null";
}
export const demandKey = (r: AssignmentDemand) =>
  stableJson({
    ...r,
    destinationDatasetId: r.destinationDatasetId ?? r.datasetId,
    accessSeconds: r.accessSeconds ?? 0,
  });
export function demandMapping(a: AssignmentDemand[], b: AssignmentDemand[]) {
  const buckets = new Map<string, number[]>();
  b.forEach((r, i) => {
    const k = demandKey(r),
      v = buckets.get(k) ?? [];
    v.push(i);
    buckets.set(k, v);
  });
  const ids = a.map((r) => buckets.get(demandKey(r))?.shift() ?? -1);
  return ids.some((i) => i < 0) || a.length !== b.length ? null : ids;
}
export function comparisonConditions(a: AssignmentResult, b: AssignmentResult) {
  const ca = a.config,
    cb = b.config,
    fields: [string, unknown, unknown][] = [
      [
        "OD・目的・時間帯需要",
        a.input.map(demandKey).sort(),
        b.input.map(demandKey).sort(),
      ],
      [
        "旅客到着分布",
        ca.arrivalModel ?? {
          mode: "representative",
          distribution: "uniform",
          stepSeconds: 60,
        },
        cb.arrivalModel ?? {
          mode: "representative",
          distribution: "uniform",
          stepSeconds: 60,
        },
      ],
      [
        "列車選択",
        [ca.method, ca.coefficients, ca.maxChoices, ca.integer],
        [cb.method, cb.coefficients, cb.maxChoices, cb.integer],
      ],
      ["競合規則", ca.competition ?? "legacy", cb.competition ?? "legacy"],
      [
        "乗換・締切",
        [
          ca.minimumTransferSeconds,
          ca.maxTransfers,
          ca.boardingCutoffSeconds ?? 0,
        ],
        [
          cb.minimumTransferSeconds,
          cb.maxTransfers,
          cb.boardingCutoffSeconds ?? 0,
        ],
      ],
      [
        "集計窓・上限",
        [
          ca.start,
          ca.end,
          ca.simulationEnd ?? ca.end + ca.maxJourneySeconds,
          ca.maxWaitSeconds,
          ca.maxJourneySeconds,
        ],
        [
          cb.start,
          cb.end,
          cb.simulationEnd ?? cb.end + cb.maxJourneySeconds,
          cb.maxWaitSeconds,
          cb.maxJourneySeconds,
        ],
      ],
      [
        "定員取扱",
        [!!ca.capacityConstrained, ca.unknownCapacityPolicy ?? "error"],
        [!!cb.capacityConstrained, cb.unknownCapacityPolicy ?? "error"],
      ],
      ["徒歩連絡", a.provenance?.walks, b.provenance?.walks],
      [
        "定員設定基準",
        a.provenance?.capacityBasis,
        b.provenance?.capacityBasis,
      ],
      [
        "鉄道利用率・生成前提",
        a.provenance?.demandAssumptions,
        b.provenance?.demandAssumptions,
      ],
    ];
  const completed = (r: AssignmentResult) =>
    r.capacity?.totals.completed ?? r.totals.assigned;
  return {
    sameDemand: !!demandMapping(a.input, b.input),
    conditions: fields.map(([field, before, after]) => ({
      field,
      before,
      after,
      available: before !== undefined && after !== undefined,
      equal: stableJson(before) === stableJson(after),
    })),
    completionBefore: a.totals.selected
      ? completed(a) / a.totals.selected
      : null,
    completionAfter: b.totals.selected
      ? completed(b) / b.totals.selected
      : null,
    warning:
      "未輸送者を時間0として便益に含めません。完了率と共通輸送人数を併読してください。定員値・ダイヤ差は比較対象の変更として別表で確認します。",
  };
}
