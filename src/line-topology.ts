import type { Project } from "./model";

export function lineNeighbors(project: Project) {
  const neighbors = new Map(
    project.stations.map(({ id }) => [id, new Set<string>()]),
  );
  for (const { from, to } of project.oud2?.links ?? []) {
    if (from === to || !neighbors.has(from) || !neighbors.has(to)) continue;
    neighbors.get(from)!.add(to);
    neighbors.get(to)!.add(from);
  }
  return neighbors;
}

export function pathsFrom(neighbors: Map<string, Set<string>>, root: string) {
  const parents = new Map<string, string | null>([[root, null]]);
  const queue = [root];
  let degreeSum = 0;
  for (const id of queue) {
    const adjacent = neighbors.get(id)!;
    degreeSum += adjacent.size;
    for (const next of adjacent) {
      if (parents.has(next)) continue;
      parents.set(next, id);
      queue.push(next);
    }
  }
  return {
    size: parents.size,
    tree: degreeSum === 2 * (parents.size - 1),
    path(end: string) {
      const path: string[] = [];
      if (!parents.has(end)) return path;
      for (let at: string | null = end; at !== null; at = parents.get(at)!)
        path.push(at);
      return path.reverse();
    },
  };
}

export function lineStationPath(project: Project, from: string, to: string) {
  const stations = project.stations.map(({ id }) => id);
  const start = stations.indexOf(from),
    end = stations.indexOf(to);
  if (start < 0 || end < 0) return undefined;
  if (!project.oud2?.links.length) {
    const path = stations.slice(Math.min(start, end), Math.max(start, end) + 1);
    return start <= end ? path : path.reverse();
  }
  const paths = pathsFrom(lineNeighbors(project), from);
  // An ambiguous graph does not establish where the passenger turned back.
  if (!paths.tree) return undefined;
  const path = paths.path(to);
  return path.length ? path : undefined;
}
