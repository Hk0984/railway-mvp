import type { DiagramTrain } from "./diagram-model";
import { lineNeighbors, pathsFrom } from "./line-topology";
import type { Project } from "./model";

export function diagramRoutes(project: Project, trains: DiagramTrain[]) {
  const original = project.stations.map((s) => s.id);
  const links = project.oud2?.links;
  if (!links?.length) return [original];
  const neighbors = lineNeighbors(project);
  if (![...neighbors.values()].some((next) => next.size > 2)) return [original];

  const leaves = original.filter((id) => neighbors.get(id)!.size === 1);
  const root = leaves[0];
  if (!root) return [original];
  const trunk = pathsFrom(neighbors, root);
  // OuDia2nd's branch links normally form a tree. An ambiguous graph keeps the file order.
  if (trunk.size !== original.length || !trunk.tree) return [original];

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
    const path = pathsFrom(neighbors, from).path(to);
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
