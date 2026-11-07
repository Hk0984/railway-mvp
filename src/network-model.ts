import type { Project } from "./model";
import type { AssignmentConfig, AssignmentDemand } from "./assignment-model";
import { validateAssignmentConfig } from "./assignment-model";
import { validateServiceMapping } from "./integration-model";
import type { TransferLink } from "./routing-model";
import { buildRoutingIndex } from "./routing";
import { parseCsv, csv } from "./io";
export interface IntegrationState {
  version: 1;
  config: AssignmentConfig;
  permittedRestrictions: string[];
  demands: AssignmentDemand[];
}
export function validateIntegration(
  state: IntegrationState,
  projects: Project[],
) {
  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.permittedRestrictions) ||
    state.permittedRestrictions.some(
      (s) => typeof s !== "string" || !s.trim(),
    ) ||
    !Array.isArray(state.demands)
  )
    throw new Error("統合設定の保存形式が不正です");
  validateAssignmentConfig(state.config);
  const members = state.config.serviceMapping?.members;
  validateServiceMapping(state.config.serviceMapping!);
  for (const m of members!) {
    const p = projects.find((p) => p.datasetId === m.datasetId);
    if (!p?.timetables.some((d) => d.id === m.timetableId))
      throw new Error("統合ダイヤのデータセット・ダイヤIDが一致しません");
  }
  for (const d of state.demands) {
    const origin = projects.find((p) => p.datasetId === d.datasetId),
      destination = projects.find(
        (p) => p.datasetId === (d.destinationDatasetId ?? d.datasetId),
      );
    if (
      !origin?.stations.some((s) => s.id === d.origin) ||
      !destination?.stations.some((s) => s.id === d.destination) ||
      !members!.some((m) => m.datasetId === d.datasetId) ||
      !members!.some(
        (m) => m.datasetId === (d.destinationDatasetId ?? d.datasetId),
      ) ||
      (d.origin === d.destination &&
        d.datasetId === (d.destinationDatasetId ?? d.datasetId)) ||
      !Number.isFinite(d.passengers) ||
      d.passengers < 0 ||
      !Number.isFinite(d.start) ||
      !Number.isFinite(d.end) ||
      d.start < 0 ||
      d.end <= d.start ||
      !["commute", "school", "shopping", "private"].includes(d.purpose) ||
      !["outbound", "return"].includes(d.kind) ||
      !["estimated", "observed", "manual"].includes(d.source) ||
      (d.accessSeconds !== undefined &&
        (!Number.isFinite(d.accessSeconds) || d.accessSeconds < 0))
    )
      throw new Error("統合ODのID・人数・時刻・出典が不正です");
  }
}
export function integrationIndex(
  state: IntegrationState,
  projects: Project[],
  links: TransferLink[],
) {
  validateIntegration(state, projects);
  const selections = state.config.serviceMapping!.members.map((m) => ({
    datasetId: m.datasetId,
    timetableId: m.timetableId,
    project: projects.find((p) => p.datasetId === m.datasetId)!,
  }));
  const selected = new Set(selections.map((s) => s.datasetId));
  return buildRoutingIndex(
    selections,
    links.filter(
      (l) => selected.has(l.from.datasetId) && selected.has(l.to.datasetId),
    ),
    { permittedRestrictions: state.permittedRestrictions },
  );
}
const columns = [
  "datasetId",
  "origin",
  "destinationDatasetId",
  "destination",
  "purpose",
  "kind",
  "startSeconds",
  "endSeconds",
  "passengers",
  "source",
  "accessSeconds",
];
export function networkDemandCsv(rows: AssignmentDemand[]) {
  return csv([
    columns,
    ...rows.map((r) => [
      r.datasetId,
      r.origin,
      r.destinationDatasetId ?? r.datasetId,
      r.destination,
      r.purpose,
      r.kind,
      r.start,
      r.end,
      r.passengers,
      r.source,
      r.accessSeconds ?? 0,
    ]),
  ]);
}
export function importNetworkDemand(
  text: string,
  state: IntegrationState,
  projects: Project[],
) {
  const [header, ...lines] = parseCsv(text);
  if (JSON.stringify(header) !== JSON.stringify(columns))
    throw new Error("統合OD CSVの列順がテンプレートと一致しません");
  const demands = lines
    .filter((l) => l.some(Boolean))
    .map((l) => {
      if (
        l.length !== columns.length ||
        [l[6], l[7], l[8]].some((x) => !x.trim())
      )
        throw new Error("統合OD CSVの列数・数値が不正です");
      return {
        datasetId: l[0],
        origin: l[1],
        destinationDatasetId: l[2],
        destination: l[3],
        purpose: l[4],
        kind: l[5],
        start: Number(l[6]),
        end: Number(l[7]),
        passengers: Number(l[8]),
        source: l[9],
        accessSeconds: l[10] ? Number(l[10]) : 0,
      } as AssignmentDemand;
    });
  validateIntegration({ ...state, demands }, projects);
  return demands;
}
