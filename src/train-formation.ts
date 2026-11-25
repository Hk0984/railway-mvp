import { trainVisits } from "./analysis";
import {
  capacityForTrain,
  trainCarCount,
  type CapacitySettings,
  type FormationValues,
} from "./capacity-model";
import { trainClassKey } from "./classification";
import type { Project, StationOperation, Stop, Train } from "./model";
import { passengerFormationConnections } from "./operation-connections";
import {
  operationGroup,
  operationPattern,
  stationOperationNumbers,
} from "./operation-numbers";

export const isFormationChange = (op: StationOperation) =>
  op.code === 1 || op.code === 2;
export const hasFormationChanges = (train: Train) =>
  train.operations?.some(isFormationChange) === true;
export const formationPosition = (stop: Stop) =>
  stop.positionId ?? stop.stationId;

function workAtVisits(train: Train, visits: Stop[]) {
  const byPosition = new Map<string, StationOperation[]>();
  for (const work of train.operations ?? []) {
    const actions = byPosition.get(work.positionId) ?? [];
    actions.push(work);
    byPosition.set(work.positionId, actions);
  }
  return visits.map((stop) =>
    (stop.sourcePositionIds ?? [formationPosition(stop)])
      .flatMap((position) => byPosition.get(position) ?? [])
      .sort(
        (a, b) => Number(b.phase === "before") - Number(a.phase === "before"),
      ),
  );
}

export function formationStages(train: Train, visits = trainVisits(train)) {
  if (!hasFormationChanges(train)) return [];
  const work = workAtVisits(train, visits);
  return visits.slice(0, -1).flatMap((stop, index) => {
    const changes = work[index].filter(isFormationChange);
    return index === 0 || changes.length ? [{ index, stop, changes }] : [];
  });
}

// A combined display number can precede the ordered component list.
function components(numbers: string[]) {
  const [first, ...rest] = numbers;
  const combined = first?.split("+") ?? [];
  return combined.length > 1 &&
    combined.length === rest.length &&
    [...combined].sort().join(";") === [...rest].sort().join(";")
    ? rest
    : numbers;
}

export function formationUnitGroups(p: Project, train: Train) {
  if (!hasFormationChanges(train)) return [];
  return (train.operations ?? [])
    .flatMap((op) => [op, ...(op.children ?? [])])
    .flatMap((op) => components(stationOperationNumbers(p, op)))
    .flatMap((number) => {
      const group = operationPattern(number);
      return group ? [[group, number] as const] : [];
    });
}

function incomingSplit(p: Project, diaId: string, train: Train) {
  if (
    !train.operations?.some(
      ({ code, phase }) => code === 5 && phase === "before",
    )
  )
    return undefined;
  const timetable = p.timetables.find(({ id }) => id === diaId);
  const links =
    timetable &&
    passengerFormationConnections(p, timetable).filter(
      ({ kind, to }) => kind === "split" && to === train,
    );
  return links?.length === 1 ? links[0] : undefined;
}

function traceUnits(
  p: Project,
  diaId: string,
  train: Train,
  work: StationOperation[][],
  seen = new Set<Train>(),
):
  | {
      sections: (string[] | undefined)[];
      detached: Map<StationOperation, string[]>;
    }
  | undefined {
  if (seen.has(train)) return undefined;
  seen.add(train);
  const split =
    train.operationNumbers === undefined && incomingSplit(p, diaId, train);
  const seed = operationGroup(p, train);
  let units = train.operationNumbers?.length
    ? components(train.operationNumbers)
    : seed.inheritedFrom && seed.numbers.length === 1
      ? seed.numbers
      : undefined;
  if (split) {
    const previous = workAtVisits(split.from, trainVisits(split.from));
    units =
      traceUnits(p, diaId, split.from, previous, seen)?.detached.get(
        split.operation,
      ) ?? units;
  }
  const detached = new Map<StationOperation, string[]>();
  const sections = work.map((operations) => {
    for (const op of operations) {
      const numbers = stationOperationNumbers(p, op);
      if (
        numbers.length &&
        (op.code === 6 || train.operationNumbers === undefined)
      )
        units = components(numbers);
      if (op.code === 1) {
        const added = components(
          (op.children ?? []).flatMap((child) =>
            stationOperationNumbers(p, child),
          ),
        );
        units =
          units?.length && added.length
            ? op.raw.startsWith("1/1$")
              ? [...added, ...units]
              : [...units, ...added]
            : undefined;
      } else if (op.code === 2 && units) {
        const match = /^2\/([01])\$([1-9]\d*)\//.exec(op.raw);
        const count = Number(match?.[2]);
        if (!match || count > units.length) {
          units = undefined;
        } else if (match[1] === "1") {
          detached.set(op, units.slice(0, count));
          units = units.slice(count);
        } else {
          detached.set(op, units.slice(-count));
          units = units.slice(0, -count);
        }
      }
    }
    return units;
  });
  seen.delete(train);
  return { sections, detached };
}

function registeredCars(
  settings: CapacitySettings | undefined,
  groups: (string | null)[] | undefined,
) {
  const cars = groups?.map((group) =>
    group
      ? (settings?.operationGroupCars?.[group] ??
        settings?.operationGroups?.[group]?.carCount)
      : undefined,
  );
  return cars?.length && cars.every((value) => value !== undefined)
    ? cars.reduce((sum, value) => sum + value, 0)
    : undefined;
}

export function formationCarCount(
  p: Project,
  diaId: string,
  train: Train,
  visits = trainVisits(train),
) {
  const settings = p.capacitySettings;
  if (
    settings?.formationSource === "operation" &&
    incomingSplit(p, diaId, train)
  ) {
    const manual = settings.trains[trainClassKey(diaId, train.id)]?.carCount;
    if (manual !== undefined) return manual;
    const units = traceUnits(p, diaId, train, workAtVisits(train, visits))
      ?.sections[0];
    const cars = registeredCars(settings, units?.map(operationPattern));
    if (cars !== undefined) return cars;
  }
  return trainCarCount(p, diaId, train);
}

export function formationProfile(
  p: Project,
  diaId: string,
  train: Train,
  visits: Stop[],
) {
  if (!hasFormationChanges(train)) return undefined;
  const work = workAtVisits(train, visits);
  const settings = p.capacitySettings;
  const key = trainClassKey(diaId, train.id);
  const sections = settings?.formationSections?.[key];
  const fromTypes = settings && {
    ...p,
    capacitySettings: { ...settings, formationSource: "type" as const },
  };
  const base = capacityForTrain(fromTypes ?? p, diaId, train);
  const baseCars = trainCarCount(fromTypes ?? p, diaId, train);
  const seed = operationGroup(p, train);
  const provisional =
    settings?.formationSource === "operation" && !seed.group
      ? settings.ungroupedOperationCapacity
      : undefined;
  const baseCapacity =
    base.spec?.kind === "transport" ? base.spec.value : undefined;
  const unitSections =
    settings?.formationSource === "operation"
      ? traceUnits(p, diaId, train, work)?.sections
      : undefined;
  let saved: FormationValues | undefined;
  let hasChanged = false;
  return visits.slice(0, -1).map((stop, index): FormationValues => {
    const changes = work[index].some(isFormationChange);
    if (index === 0 || changes) saved = sections?.[formationPosition(stop)];
    if (index > 0 && changes) hasChanged = true;
    const groups = unitSections?.[index]?.map(operationPattern);
    const capacity = groups?.map((group) =>
      group ? settings?.operationGroups?.[group] : undefined,
    );
    const total =
      capacity?.length && capacity.every((spec) => spec?.kind === "transport")
        ? capacity.reduce((sum, spec) => sum + spec!.value, 0)
        : undefined;
    const totalCars = registeredCars(settings, groups);
    const initialCapacity = hasChanged
      ? undefined
      : (provisional ?? baseCapacity);
    return {
      capacity:
        saved?.capacity ??
        (!hasChanged && base.source === "train"
          ? baseCapacity
          : (total ?? initialCapacity)),
      carCount:
        saved?.carCount ??
        (!hasChanged ? settings?.trains[key]?.carCount : undefined) ??
        totalCars ??
        (!hasChanged ? baseCars : undefined),
    };
  });
}

export function completeTransportCapacity(
  p: Project,
  diaId: string,
  train: Train,
  visits?: Stop[],
) {
  if (hasFormationChanges(train))
    return formationProfile(
      p,
      diaId,
      train,
      visits ?? trainVisits(train),
    )!.every(({ capacity }) => capacity !== undefined);
  return capacityForTrain(p, diaId, train).spec?.kind === "transport";
}
