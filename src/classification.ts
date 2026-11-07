import type { Project, Train } from "./model";
export type ServiceClass = "passenger" | "nonPassenger" | "review";
export interface ClassDecision {
  state: ServiceClass;
  basis: string;
}
export interface ServiceClassification {
  types: Record<string, ClassDecision>;
  trains: Record<string, ClassDecision>;
}
export const classLabels: Record<ServiceClass, string> = {
  passenger: "営業",
  nonPassenger: "非営業",
  review: "要確認",
};
export const trainClassKey = (timetableId: string, trainId: string) =>
  JSON.stringify([timetableId, trainId]);
export function serviceClass(
  p: Project,
  timetableId: string,
  t: Train,
): ClassDecision {
  return (
    p.serviceClasses?.trains[trainClassKey(timetableId, t.id)] ??
    p.serviceClasses?.types[t.typeId] ?? {
      state: "review",
      basis: "原データに旅客営業区分がないため未確認",
    }
  );
}
export const isPassengerTrain = (p: Project, diaId: string, t: Train) =>
  !t.cancelled && serviceClass(p, diaId, t).state === "passenger";
export const capacityOf = (p: Project, t: Train): number | null =>
  t.capacity ?? p.typeCapacities?.[t.typeId] ?? null;
export function validateClassifications(p: Project) {
  const states = ["passenger", "nonPassenger", "review"];
  const typeIds = new Set(p.types.map((t) => t.id));
  const trainIds = new Set(
    p.timetables.flatMap((d) => d.trains.map((t) => trainClassKey(d.id, t.id))),
  );
  if (p.serviceClasses) {
    if (!p.serviceClasses.types || !p.serviceClasses.trains)
      throw new Error("営業区分の保存形式が不正です");
    for (const [values, ids] of [
      [p.serviceClasses.types, typeIds],
      [p.serviceClasses.trains, trainIds],
    ] as const)
      for (const [id, v] of Object.entries(values))
        if (
          !ids.has(id) ||
          !v ||
          !states.includes(v.state) ||
          typeof v.basis !== "string" ||
          !v.basis.trim()
        )
          throw new Error("営業区分の参照・状態・設定根拠が不正です");
  }
  for (const [id, n] of Object.entries(p.typeCapacities ?? {}))
    if (
      !typeIds.has(id) ||
      !Number.isFinite(n) ||
      n <= 0 ||
      !Number.isInteger(n)
    )
      throw new Error("種別定員は既存種別に対する正の整数が必要です");
}
export function classificationCounts(p: Project, diaId: string) {
  const d = p.timetables.find((d) => d.id === diaId);
  if (!d) throw new Error("ダイヤID不正");
  const c = {
    registered: d.trains.length,
    active: 0,
    passenger: 0,
    nonPassenger: 0,
    review: 0,
    cancelled: 0,
  };
  for (const t of d.trains) {
    if (t.cancelled) {
      c.cancelled++;
      continue;
    }
    c.active++;
    c[serviceClass(p, diaId, t).state]++;
  }
  return c;
}
const profiles: Record<string, { name: string; states: ServiceClass[] }> = {
  aef5a00fea407193151b1255926ae95cecf10e3588007a7d1033d31d5f22fec7: {
    name: "琴町線",
    states: [
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "nonPassenger",
      "review",
      "nonPassenger",
    ],
  },
  "8da42108d4326c0f8af89cd1ec94bd4f30dd456e42360c993f9ef0a8aa352fa4": {
    name: "堀電バス",
    states: [
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "passenger",
      "nonPassenger",
    ],
  },
};
export function referenceClassification(
  p: Project,
  fingerprint = p.datasetId?.replace(/^oud-/, ""),
) {
  const preset = fingerprint ? profiles[fingerprint.toLowerCase()] : undefined;
  if (
    !preset ||
    preset.states.length !== p.types.length ||
    !p.oud2 ||
    p.oud2.fileType !== "OuDiaSecond.1.17"
  )
    return null;
  return {
    name: preset.name,
    decisions: Object.fromEntries(
      preset.states.map((state, i) => [
        String(i),
        {
          state,
          basis: `${preset.name}参照ファイル専用の利用者適用設定（種別ID ${i}）。${state === "review" ? "営業可否は要確認" : "MVP 0.3初期分類。必要に応じて変更してください"}`,
        },
      ]),
    ) as Record<string, ClassDecision>,
  };
}
/** Explicit action only. No name-based auto-approval or mutation at parse time. */
export function applyReferenceClassification(p: Project, fingerprint?: string) {
  const preset = referenceClassification(p, fingerprint);
  if (!preset)
    throw new Error(
      "参照ファイルの識別子が一致しないため初期分類を適用できません",
    );
  p.serviceClasses = {
    types: structuredClone(preset.decisions),
    trains: p.serviceClasses?.trains ?? {},
  };
}
