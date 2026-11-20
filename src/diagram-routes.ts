import type { DiagramTrain } from "./diagram-model";
import type { Project } from "./model";

export function diagramRoutes(project: Project, trains: DiagramTrain[]) {
  const original = project.stations.map((s) => s.id);
  const links = project.oud2?.links;
  if (!links?.length) return [original];
  const neighbors = new Map(original.map((id) => [id, new Set<string>()]));
  for (const { from, to } of links) {
    if (from === to || !neighbors.has(from) || !neighbors.has(to)) continue;
    neighbors.get(from)!.add(to);
    neighbors.get(to)!.add(from);
  }
  if (![...neighbors.values()].some((next) => next.size > 2)) return [original];

  function pathsFrom(root: string) {
    const parents = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    for (const id of queue)
      for (const next of neighbors.get(id)!)
        if (!parents.has(next)) {
          parents.set(next, id);
          queue.push(next);
        }
    return {
      size: parents.size,
      path(end: string) {
        const path = [];
        for (
          let at: string | null = end;
          at !== null;
          at = parents.get(at) ?? null
        )
          path.push(at);
        return path.reverse();
      },
    };
  }
  const leaves = original.filter((id) => neighbors.get(id)!.size === 1);
  const root = leaves[0];
  if (!root) return [original];
  const trunk = pathsFrom(root);
  const edges =
    [...neighbors.values()].reduce((s, next) => s + next.size, 0) / 2;
  // OuDia2nd's branch links normally form a tree. An ambiguous graph keeps the file order.
  if (trunk.size !== original.length || edges !== original.length - 1)
    return [original];

  const routes = leaves
    .slice(1)
    .reverse()
    .map((end) => trunk.path(end));
  const routeStations = routes.map((route) => new Set(route));
  for (const { visits } of trains) {
    const stations = new Set(visits.map((visit) => visit.stationId));
    if (
      routeStations.some((route) =>
        [...stations].every((station) => route.has(station)),
      )
    )
      continue;
    const first = visits[0]?.stationId,
      last = visits.at(-1)?.stationId;
    if (!first || !last) continue;
    const [from, to] =
      original.indexOf(first) <= original.indexOf(last)
        ? [first, last]
        : [last, first];
    const path = pathsFrom(from).path(to);
    const pathStations = new Set(path);
    if (
      path.length > 1 &&
      [...stations].every((station) => pathStations.has(station))
    ) {
      routes.push(path);
      routeStations.push(pathStations);
    }
  }
  return routes;
}
