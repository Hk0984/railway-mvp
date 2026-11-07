import type { Project } from "./model";
import {
  generateTemporalDemand,
  defaultTemporalConfig,
} from "./temporal-demand";
import {
  defaultAssignmentConfig,
  type AssignmentConfig,
} from "./assignment-model";
import { buildRoutingIndex } from "./routing";
import { assignDemand } from "./assignment";
import { transportCapacity } from "./capacity-model";
import { trainClassKey } from "./classification";
import { flowSummary, passengerFlows } from "./flow-analysis";
export interface SensitivityRow {
  label: string;
  demand: number | null;
  completed: number | null;
  untransported: number | null;
  peakOccupancy: number | null;
  denied: number | null;
  meanTravelMinutes: number | null;
  error?: string;
  coefficients: unknown;
}
/** Model-generated demand sensitivity, separate from independent validation and fixed-OD revision benefits. */
export function sensitivityAnalysis(
  source: Project,
  timetableId: string,
  config: AssignmentConfig = defaultAssignmentConfig(),
  onProgress?: (n: number, total: number) => void,
): SensitivityRow[] {
  const labels = [
    "基準",
    "β×1.2",
    "雇用吸引係数×1.2",
    "通勤発生係数×1.2",
    "通学発生係数×1.2",
    "鉄道利用率×1.2（上限1）",
    "待ち時間選択係数×1.2",
    "既知輸送定員×0.8",
    "既知輸送定員×1.2",
  ];
  const rows: SensitivityRow[] = [];
  for (const [i, label] of labels.entries()) {
    const p = structuredClone({
        ...source,
        analytics: undefined,
        temporal: undefined,
      }),
      c = structuredClone(
        source.temporal?.config ??
          source.temporalConfig ??
          defaultTemporalConfig(),
      ),
      choice = structuredClone(config);
    if (i === 1) c.beta *= 1.2;
    if (i === 2) c.purposes.forEach((x) => (x.employmentWeight *= 1.2));
    if (i === 3)
      c.purposes.find((x) => x.purpose === "commute")!.generation *= 1.2;
    if (i === 4)
      c.purposes.find((x) => x.purpose === "school")!.generation *= 1.2;
    if (i === 5)
      p.stations.forEach((s) => (s.railShare = Math.min(1, s.railShare * 1.2)));
    if (i === 6)
      Object.values(choice.coefficients).forEach((v) => (v.waiting *= 1.2));
    if (i >= 7) {
      p.capacitySettings = structuredClone(
        p.capacitySettings ?? { timetables: {}, trains: {}, types: {} },
      );
      for (const d of p.timetables)
        for (const t of d.trains) {
          const cap = transportCapacity(p, d.id, t.id);
          if (cap !== null)
            p.capacitySettings.trains[trainClassKey(d.id, t.id)] = {
              value: Math.max(1, Math.round(cap * (i === 7 ? 0.8 : 1.2))),
              kind: "transport",
              basis: label + " 感度分析用",
            };
        }
    }
    try {
      const state = generateTemporalDemand(
          p,
          c,
          source.temporal?.costs ?? p.costs,
        ),
        input = state.slots.map((d) => ({ ...d, datasetId: p.datasetId! })),
        idx = buildRoutingIndex([
          { datasetId: p.datasetId!, project: p, timetableId },
        ]),
        r = assignDemand(idx, input, choice),
        summary = flowSummary(passengerFlows(r)),
        loads = r.capacity?.loads ?? r.loads,
        occupancies = loads.flatMap((l) =>
          l.peakOccupancy === null ? [] : [l.peakOccupancy],
        );
      rows.push({
        label,
        demand: r.totals.selected,
        completed: summary.completed,
        untransported: summary.untransported,
        peakOccupancy: occupancies.length ? Math.max(...occupancies) : null,
        denied: r.capacity?.totals.deniedUnique ?? null,
        meanTravelMinutes:
          summary.meanTravelSeconds === null
            ? null
            : summary.meanTravelSeconds / 60,
        coefficients: { demand: c, choice },
      });
    } catch (error) {
      rows.push({
        label,
        demand: null,
        completed: null,
        untransported: null,
        peakOccupancy: null,
        denied: null,
        meanTravelMinutes: null,
        error: (error as Error).message,
        coefficients: { demand: c, choice },
      });
    }
    onProgress?.(i + 1, labels.length);
  }
  return rows;
}
