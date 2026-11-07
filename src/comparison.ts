import { validateProject, type Project } from "./model";
import { cachedRoutingIndex } from "./routing-cache";
import { assignDemand } from "./assignment";
import { analyzeService } from "./service";
import { classificationCounts } from "./classification";
import type {
  AssignmentDemand,
  AssignmentConfig,
  AssignmentResult,
} from "./assignment-model";
export interface ComparisonRow {
  label: string;
  before: number | null;
  after: number | null;
  difference: number | null;
  unit: string;
}
export interface ComparisonResult {
  beforeId: string;
  afterId: string;
  fixedDemand: boolean;
  rows: ComparisonRow[];
  before: AssignmentResult;
  after: AssignmentResult;
  assumptions: string;
}
function metrics(
  p: Project,
  diaId: string,
  input: AssignmentDemand[],
  c: AssignmentConfig,
  origin: string,
  destination: string,
) {
  const index = cachedRoutingIndex([
      { datasetId: p.datasetId!, project: p, timetableId: diaId },
    ]),
    result = assignDemand(index, input, c);
  const service = analyzeService(
    index,
    {
      origin: { datasetId: p.datasetId!, stationId: origin },
      destination: { datasetId: p.datasetId!, stationId: destination },
      mode: "depart",
      time: c.start,
      sort: "arrival",
      maxTransfers: c.maxTransfers,
      minimumTransferSeconds: c.minimumTransferSeconds,
      directOnly: c.maxTransfers === 0,
    },
    c.start,
    c.end,
  );
  const loads = result.capacity?.loads ?? result.loads;
  const occupancy = loads.flatMap((l) =>
    l.peakOccupancy === null ? [] : [l.peakOccupancy * 100],
  );
  const counts = classificationCounts(p, diaId);
  return {
    result,
    values: [
      counts.active,
      counts.passenger,
      service.directEffectiveCount,
      service.journeyCount,
      service.journeyHeadways?.mean ?? null,
      service.journeyHeadways?.max ?? null,
      service.journeyWait.minutes,
      service.fastest ? service.fastest.elapsedSeconds / 60 : null,
      occupancy.length ? Math.max(...occupancy) : null,
      result.capacity?.totals.deniedUnique ?? null,
      result.capacity
        ? result.capacity.totals.additionalWaitPersonSeconds / 60
        : null,
      result.capacity?.totals.completed ?? result.totals.assigned,
      result.capacity
        ? result.capacity.totals.waiting +
          result.capacity.totals.noPath +
          result.capacity.totals.inTransit
        : result.totals.unassigned,
    ],
  };
}
export function compareTimetables(
  p: Project,
  input: AssignmentDemand[],
  beforeId: string,
  afterId: string,
  c: AssignmentConfig,
  origin: string,
  destination: string,
  afterInput?: AssignmentDemand[],
  afterProject?: Project,
): ComparisonResult {
  validateProject(p);
  if (afterProject) {
    validateProject(afterProject);
    if (
      afterProject.datasetId !== p.datasetId ||
      JSON.stringify(afterProject.stations.map((s) => s.id).sort()) !==
        JSON.stringify(p.stations.map((s) => s.id).sort()) ||
      !afterProject.timetables.some((d) => d.id === afterId)
    )
      throw new Error("シナリオ比較の駅・ダイヤIDが一致しません");
  }
  if (
    !p.datasetId ||
    !p.timetables.some((d) => d.id === beforeId) ||
    !p.timetables.some((d) => d.id === afterId) ||
    !p.stations.some((s) => s.id === origin) ||
    !p.stations.some((s) => s.id === destination) ||
    origin === destination ||
    [...input, ...(afterInput ?? [])].some((d) => d.datasetId !== p.datasetId)
  )
    throw new Error("比較対象のデータセット・ダイヤ・駅IDが一致しません");
  const frozen = structuredClone(input),
    a = metrics(p, beforeId, frozen, c, origin, destination),
    b = metrics(
      afterProject ?? p,
      afterId,
      afterInput ? structuredClone(afterInput) : frozen,
      c,
      origin,
      destination,
    );
  const labels = [
    ["全運行本数", "本"],
    ["営業運行本数", "本"],
    ["OD直通有効本数", "本"],
    ["OD有効出発機会", "回"],
    ["平均運転間隔", "分"],
    ["最大運転間隔", "分"],
    ["期待待ち時間", "分"],
    ["最速到着旅程の所要時間", "分"],
    ["全列車の最大混雑率", "%"],
    ["積み残し経験人数", "人"],
    ["後続便までの追加待ち", "人分"],
    ["輸送完了／無制約配分済み", "人"],
    ["未輸送／無制約未配分", "人"],
  ];
  return {
    beforeId,
    afterId,
    fixedDemand: !afterInput,
    rows: labels.map(([label, unit], i) => ({
      label,
      unit,
      before: a.values[i],
      after: b.values[i],
      difference:
        a.values[i] === null || b.values[i] === null
          ? null
          : b.values[i]! - a.values[i]!,
    })),
    before: a.result,
    after: b.result,
    assumptions: afterInput
      ? "同じダイヤ・異なる需要シナリオの比較。需要再推計型のダイヤ比較ではありません。"
      : "同じデータセットの駅ID・固定時間帯OD・配分条件で比較。営業区分は各ダイヤの実効設定を使用。運転間隔は有効出発機会、待ち時間は最速到着を選ぶ一様到着条件付き期待値。輸送完了は制約時の計算終了時点。",
  };
}
