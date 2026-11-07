import type { Project } from "./model";
import { trainClassKey } from "./classification";
export interface CapacitySpec {
  value: number;
  kind: "seats" | "transport";
  basis: string;
  vehicle?: string;
}
export interface CapacitySettings {
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
  const c = p.capacitySettings;
  return (
    c?.trains[trainClassKey(diaId, trainId)] ??
    (train.capacity === undefined
      ? undefined
      : {
          value: train.capacity,
          kind: "transport",
          basis: "旧Train.capacityの設定輸送定員",
        }) ??
    c?.types[train.typeId] ??
    (p.typeCapacities?.[train.typeId] === undefined
      ? undefined
      : {
          value: p.typeCapacities[train.typeId],
          kind: "transport",
          basis: "旧typeCapacitiesの設定輸送定員",
        }) ??
    c?.timetables[diaId] ??
    null
  );
}
export function transportCapacity(p: Project, diaId: string, trainId: string) {
  const spec = capacitySpec(p, diaId, trainId);
  return spec?.kind === "transport" ? spec.value : null;
}
export function validateCapacitySettings(p: Project) {
  const c = p.capacitySettings;
  if (!c) return;
  const refs = [
    new Set(p.timetables.map((d) => d.id)),
    new Set(
      p.timetables.flatMap((d) =>
        d.trains.map((t) => trainClassKey(d.id, t.id)),
      ),
    ),
    new Set(p.types.map((t) => t.id)),
  ];
  for (const [i, map] of [c.timetables, c.trains, c.types].entries()) {
    if (!map || typeof map !== "object" || Array.isArray(map))
      throw new Error("定員設定の形式不正");
    for (const [key, s] of Object.entries(map))
      if (
        !refs[i].has(key) ||
        !s ||
        !Number.isInteger(s.value) ||
        s.value <= 0 ||
        !["seats", "transport"].includes(s.kind) ||
        typeof s.basis !== "string" ||
        !s.basis.trim() ||
        (s.vehicle !== undefined && typeof s.vehicle !== "string")
      )
        throw new Error("定員設定の参照・種別・根拠が不正です");
  }
}
