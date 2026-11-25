import { trainVisits } from "./analysis";
import { trainClassKey } from "./classification";
import {
  activeDemandDay,
  boundaryTrains,
  type LineDemand,
} from "./line-demand";
import type { Project, Timetable, Train } from "./model";
import { formationPosition, formationStages } from "./train-formation";

function sameOrder<T>(a: T[], b: T[], matches: (a: T, b: T) => boolean) {
  return a.length === b.length && a.every((item, i) => matches(item, b[i]));
}

export function sameStationOrder(a: Project, b: Project) {
  return (
    sameOrder(
      a.stations,
      b.stations,
      (x, y) => x.id === y.id && x.name === y.name,
    ) &&
    sameOrder(
      a.oud2?.positions ?? [],
      b.oud2?.positions ?? [],
      (x, y) =>
        x.id === y.id &&
        x.stationId === y.stationId &&
        x.name === y.name &&
        x.branchCorePositionId === y.branchCorePositionId,
    ) &&
    sameOrder(
      a.oud2?.links ?? [],
      b.oud2?.links ?? [],
      (x, y) => x.from === y.from && x.to === y.to,
    )
  );
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const result = new Map<string, T | undefined>();
  for (const item of items) {
    const id = key(item);
    result.set(id, result.has(id) ? undefined : item);
  }
  return result;
}

function matchNamed<T extends { id: string; name: string }>(
  saved: T[],
  current: T[],
) {
  if (sameOrder(saved, current, (a, b) => a.id === b.id && a.name === b.name))
    return new Map(saved.map((item, i) => [item.id, current[i]]));
  const currentByName = uniqueBy(current, (item) => item.name);
  const matches = new Map<string, T>();
  for (const [name, original] of uniqueBy(saved, (item) => item.name)) {
    const target = currentByName.get(name);
    if (original && target) matches.set(original.id, target);
  }
  return matches;
}

function matchTrains(
  saved: Timetable,
  current: Timetable,
  typeIds: ReadonlyMap<string, string>,
) {
  const pairs: [Train, Train][] = [];
  for (const direction of ["down", "up"] as const) {
    const before = saved.trains.filter(
      (train) => train.direction === direction,
    );
    const after = current.trains.filter(
      (train) => train.direction === direction,
    );
    // OuDia2nd IDs depend on column order. Use them for unnumbered trains only
    // when that direction has the same ordered train and stop structure.
    if (
      sameOrder(
        before,
        after,
        (a, b) =>
          a.id === b.id &&
          a.number === b.number &&
          typeIds.get(a.typeId) === b.typeId &&
          a.externalOrigin?.terminalId === b.externalOrigin?.terminalId &&
          a.externalDestination?.terminalId ===
            b.externalDestination?.terminalId &&
          sameOrder(
            a.stops,
            b.stops,
            (x, y) =>
              x.stationId === y.stationId &&
              x.positionId === y.positionId &&
              x.status === y.status,
          ),
      )
    ) {
      before.forEach((train, i) => pairs.push([train, after[i]]));
      continue;
    }
    const currentByNumber = uniqueBy(after, (train) => train.number.trim());
    for (const [number, original] of uniqueBy(before, (train) =>
      train.number.trim(),
    )) {
      const target = currentByNumber.get(number);
      if (number && original && target) pairs.push([original, target]);
    }
  }
  return pairs;
}

/** Both projects must have the same station order and branch layout. */
export function transferTimetableSettings(
  current: Project,
  saved: Project,
  backup?: { currentTimetableId: string },
) {
  const typeMatches = matchNamed(saved.types, current.types);
  const typeIds = new Map([...typeMatches].map(([id, type]) => [id, type.id]));
  const previousType = new Map<string, Project["types"][number]>();
  let skipped = 0;
  for (const type of saved.types) {
    const id = typeIds.get(type.id);
    if (id !== undefined) previousType.set(id, type);
    else if (type.carCount !== undefined) skipped++;
  }
  const timetableMatches = matchNamed(saved.timetables, current.timetables);
  const timetableIds = new Map(
    [...timetableMatches].map(([id, dia]) => [id, dia.id]),
  );
  const trainMatches = new Map<
    string,
    { before: Train; after: Train; timetableId: string }
  >();
  const trainKeys = new Map<string, string>();
  const oldCapacity = new Map<string, number | undefined>();
  for (const dia of saved.timetables) {
    const target = timetableMatches.get(dia.id);
    if (!target) continue;
    for (const [before, after] of matchTrains(dia, target, typeIds)) {
      const key = trainClassKey(dia.id, before.id);
      const newKey = trainClassKey(target.id, after.id);
      trainMatches.set(key, { before, after, timetableId: target.id });
      trainKeys.set(key, newKey);
      oldCapacity.set(newKey, before.capacity);
    }
  }

  for (const dia of saved.timetables)
    for (const train of dia.trains)
      if (
        train.capacity !== undefined &&
        !trainKeys.has(trainClassKey(dia.id, train.id))
      )
        skipped++;

  const rekey = <T>(
    values: Record<string, T>,
    ids: ReadonlyMap<string, string>,
  ) => {
    const entries: [string, T][] = [];
    for (const [id, value] of Object.entries(values)) {
      const target = ids.get(id);
      if (target === undefined) skipped++;
      else entries.push([target, value]);
    }
    return Object.fromEntries(entries);
  };
  const transferDemand = <T extends Pick<LineDemand, "outside">>(
    demand: T,
  ): T => ({
    ...demand,
    outside: demand.outside.map((area) => {
      const trains: typeof area.trains = Object.create(null);
      for (const [id, selection] of Object.entries(area.trains)) {
        const target = timetableMatches.get(id);
        if (!target) {
          skipped += selection.inbound.length + selection.outbound.length;
          continue;
        }
        const match = (flow: "inbound" | "outbound") => {
          if (!selection[flow].length) return [];
          const eligible = new Set(
            boundaryTrains(target, area.stationId, flow).map(
              (train) => train.id,
            ),
          );
          return selection[flow].flatMap((trainId) => {
            const train = trainMatches.get(trainClassKey(id, trainId))?.after;
            if (train && eligible.has(train.id)) return [train.id];
            skipped++;
            return [];
          });
        };
        trains[target.id] = {
          inbound: match("inbound"),
          outbound: match("outbound"),
        };
      }
      return { ...area, trains };
    }),
  });

  const classes = saved.serviceClasses;
  const capacity = saved.capacitySettings;
  const formationSections = capacity?.formationSections && Object.fromEntries(
    Object.entries(capacity.formationSections).flatMap(([key, values]) => {
      const match = trainMatches.get(key);
      const target = trainKeys.get(key);
      const available = new Set(match ? formationStages(match.after).map(stage => formationPosition(stage.stop)) : []);
      const entries = Object.entries(values).filter(([position]) => available.has(position));
      skipped += Object.keys(values).length - entries.length;
      return target && entries.length ? [[target, Object.fromEntries(entries)]] : [];
    }),
  );
  const analytics = saved.analytics;
  const project: Project = {
    ...saved,
    name: current.name,
    oud2: current.oud2,
    types: current.types.map((type) => {
      const old = previousType.get(type.id);
      if (!old) return type;
      const { diagramColor, timetableColor } = backup ? old : type;
      return { ...type, carCount: old.carCount, diagramColor, timetableColor };
    }),
    timetables: current.timetables.map((dia) => ({
      ...dia,
      trains: dia.trains.map((train) => {
        const key = trainClassKey(dia.id, train.id);
        const value = oldCapacity.get(key);
        return oldCapacity.has(key) && train.capacity !== value
          ? { ...train, capacity: value }
          : train;
      }),
    })),
    demandSelection: {
      day: activeDemandDay(saved),
      timetableId:
        backup?.currentTimetableId ??
        timetableIds.get(
          saved.demandSelection?.timetableId ?? saved.timetables[0].id,
        ) ??
        current.timetables[0].id,
    },
    serviceClasses: classes && {
      types: rekey(classes.types, typeIds),
      trains: rekey(classes.trains, trainKeys),
    },
    typeCapacities:
      saved.typeCapacities && rekey(saved.typeCapacities, typeIds),
    capacitySettings: capacity && {
      ...capacity,
      timetables: rekey(capacity.timetables, timetableIds),
      trains: rekey(capacity.trains, trainKeys),
      types: rekey(capacity.types, typeIds),
      formationSections,
    },
    lineDemand: saved.lineDemand && transferDemand(saved.lineDemand),
    lineDemandByDay:
      saved.lineDemandByDay &&
      Object.fromEntries(
        Object.entries(saved.lineDemandByDay).map(([day, demand]) => [
          day,
          transferDemand(demand),
        ]),
      ),
    analytics: analytics && {
      ...analytics,
      observations: analytics.observations.flatMap((observation) => {
        if (observation.kind !== "load") return [observation];
        const match = trainMatches.get(
          trainClassKey(observation.timetableId, observation.trainId),
        );
        if (match) {
          const i = observation.segmentIndex!;
          const before = trainVisits(match.before);
          const after = trainVisits(match.after);
          if (
            after[i]?.stationId === before[i]?.stationId &&
            after[i + 1]?.stationId === before[i + 1]?.stationId
          )
            return [
              {
                ...observation,
                timetableId: match.timetableId,
                trainId: match.after.id,
              },
            ];
        }
        skipped++;
        return [];
      }),
    },
  };
  return { project, skipped };
}
