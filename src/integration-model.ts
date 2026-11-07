import type { DatasetSelection, StationRef } from "./routing-model";
export interface ServiceMapping {
  group: string;
  basis: string;
  members: { datasetId: string; timetableId: string; group: string }[];
}
export function validateServiceMapping(
  m: ServiceMapping,
  selections?: DatasetSelection[],
) {
  if (
    !m ||
    !m.group?.trim() ||
    !m.basis?.trim() ||
    !Array.isArray(m.members) ||
    !m.members.length ||
    m.members.some(
      (x) => !x.datasetId || !x.timetableId || x.group !== m.group,
    ) ||
    new Set(m.members.map((x) => x.datasetId)).size !== m.members.length
  )
    throw new Error(
      "利用日区分の明示対応が不正です。異なる区分は混在できません",
    );
  if (
    selections &&
    (selections.length !== m.members.length ||
      selections.some(
        (s) =>
          !m.members.some(
            (x) =>
              x.datasetId === s.datasetId && x.timetableId === s.timetableId,
          ),
      ))
  )
    throw new Error("選択ダイヤと利用日対応が一致しません");
}
export const stopEventId = (
  datasetId: string,
  timetableId: string,
  trainId: string,
  index: number,
  phase: "arrival" | "departure",
) => JSON.stringify([datasetId, timetableId, trainId, index, phase]);
export const demandDestination = (r: {
  datasetId: string;
  destination: string;
  destinationDatasetId?: string;
}): StationRef => ({
  datasetId: r.destinationDatasetId ?? r.datasetId,
  stationId: r.destination,
});
