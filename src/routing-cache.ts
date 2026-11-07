import type { Project } from "./model";
import type { DatasetSelection, TransferLink } from "./routing-model";
import { buildRoutingIndex, type RoutingIndex } from "./routing";
interface Entry {
  key: string;
  dia: unknown;
  trains: unknown;
  length: number;
  index: RoutingIndex;
}
let cache = new WeakMap<Project, Entry[]>();
/** Projects/timetables are immutable inputs. Call invalidateRoutingCache after direct in-place stop edits. */
export function cachedRoutingIndex(
  selections: DatasetSelection[],
  links: TransferLink[] = [],
) {
  if (selections.length !== 1) return buildRoutingIndex(selections, links);
  const s = selections[0],
    dia = s.project.timetables.find((d) => d.id === s.timetableId);
  if (!dia) throw new Error("ダイヤID不正");
  const key = JSON.stringify([
    s.datasetId,
    s.timetableId,
    s.allowedTypeIds,
    s.passengerOnly,
    s.project.serviceClasses,
    links,
  ]);
  const entries = cache.get(s.project) ?? [];
  const found = entries.find(
    (e) =>
      e.key === key &&
      e.dia === dia &&
      e.trains === dia.trains &&
      e.length === dia.trains.length,
  );
  if (found) return found.index;
  const index = buildRoutingIndex(selections, links);
  cache.set(
    s.project,
    [
      { key, dia, trains: dia.trains, length: dia.trains.length, index },
      ...entries.filter((e) => e.key !== key),
    ].slice(0, 3),
  );
  return index;
}
export function invalidateRoutingCache(project?: Project) {
  if (project) cache.delete(project);
  else cache = new WeakMap();
}
