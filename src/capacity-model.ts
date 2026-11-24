import type { Project, Train } from "./model";
import { trainClassKey } from "./classification";
import { isOperationPattern, operationGroup } from "./operation-numbers";
export interface CapacitySpec {
  value: number;
  kind: "seats" | "transport";
  basis: string;
  vehicle?: string;
  carCount?: number;
}
export interface CapacitySettings {
  formationSource?: "type" | "operation";
  operationGroups?: Record<string, CapacitySpec>;
  operationGroupCars?: Record<string, number>;
  timetables: Record<string, CapacitySpec>;
  trains: Record<string, CapacitySpec>;
  types: Record<string, CapacitySpec>;
}
export function capacitySpec(
  p: Project,
  diaId: string,
  trainId: string,
): CapacitySpec | null {
  const train = p.timetables
    .find((d) => d.id === diaId)
    ?.trains.find((t) => t.id === trainId);
  if (!train) return null;
  return capacityForTrain(p, diaId, train).spec;
}

function configuredOperationGroup(p: Project, train: Train) {
  const c = p.capacitySettings;
  if (
    !c ||
    c.formationSource === "type" ||
    (!c.operationGroups && !c.operationGroupCars)
  )
    return null;
  return operationGroup(p, train, c.formationSource === undefined).group;
}

export function capacityForTrain(
  p: Project,
  diaId: string,
  train: Train,
): {
  spec: CapacitySpec | null;
  source: "train" | "operation" | "type" | "unknown";
} {
  const c = p.capacitySettings;
  const individual = c?.trains[trainClassKey(diaId, train.id)];
  if (individual) return { spec: individual, source: "train" };
  if (train.capacity !== undefined)
    return {
      spec: {
        value: train.capacity,
        kind: "transport",
        basis: "旧Train.capacityの設定輸送定員",
      },
      source: "train",
    };
  const group = configuredOperationGroup(p, train);
  const operation = group && c?.operationGroups?.[group];
  if (operation) return { spec: operation, source: "operation" };
  const type = c?.types[train.typeId];
  if (type) return { spec: type, source: "type" };
  const typeCapacity = p.typeCapacities?.[train.typeId];
  if (typeCapacity !== undefined)
    return {
      spec: {
        value: typeCapacity,
        kind: "transport",
        basis: "旧typeCapacitiesの設定輸送定員",
      },
      source: "type",
    };
  return { spec: c?.timetables[diaId] ?? null, source: "unknown" };
}

export function transportCapacity(p: Project, diaId: string, trainId: string) {
  const spec = capacitySpec(p, diaId, trainId);
  return spec?.kind === "transport" ? spec.value : null;
}

export function trainCarCount(p: Project, diaId: string, train: Train) {
  const c = p.capacitySettings;
  const group = configuredOperationGroup(p, train);
  return (
    c?.trains[trainClassKey(diaId, train.id)]?.carCount ??
    (group
      ? (c?.operationGroupCars?.[group] ??
        c?.operationGroups?.[group]?.carCount)
      : undefined) ??
    p.types.find((type) => type.id === train.typeId)?.carCount ??
    c?.types[train.typeId]?.carCount ??
    c?.timetables[diaId]?.carCount
  );
}

export function validateCapacitySettings(p: Project) {
  const c = p.capacitySettings;
  if (!c) return;
  if (
    c.formationSource !== undefined &&
    !["type", "operation"].includes(c.formationSource)
  )
    throw new Error("編成設定方法が不正です");
  if (
    c.operationGroupCars !== undefined &&
    (!c.operationGroupCars ||
      typeof c.operationGroupCars !== "object" ||
      Array.isArray(c.operationGroupCars) ||
      Object.entries(c.operationGroupCars).some(
        ([key, cars]) =>
          !isOperationPattern(key) || !Number.isSafeInteger(cars) || cars <= 0,
      ))
  )
    throw new Error(
      "運用番号グループの編成両数は1以上の整数を入力してください",
    );
  const refs = [
    new Set(p.timetables.map((d) => d.id)),
    new Set(
      p.timetables.flatMap((d) =>
        d.trains.map((t) => trainClassKey(d.id, t.id)),
      ),
    ),
    new Set(p.types.map((t) => t.id)),
  ];
  for (const [i, map] of [
    c.timetables,
    c.trains,
    c.types,
    c.operationGroups ?? {},
  ].entries()) {
    if (!map || typeof map !== "object" || Array.isArray(map))
      throw new Error("定員設定の形式不正");
    for (const [key, s] of Object.entries(map))
      if (
        (i === 3
          ? !/^[A-Z]+$/.test(key) && !isOperationPattern(key)
          : !refs[i].has(key)) ||
        !s ||
        !Number.isInteger(s.value) ||
        s.value <= 0 ||
        !["seats", "transport"].includes(s.kind) ||
        typeof s.basis !== "string" ||
        !s.basis.trim() ||
        (s.vehicle !== undefined && typeof s.vehicle !== "string") ||
        (s.carCount !== undefined &&
          (!Number.isSafeInteger(s.carCount) || s.carCount <= 0))
      )
        throw new Error("定員設定の参照・種別・根拠が不正です");
  }
}
