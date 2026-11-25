import { trainVisits } from "./analysis";
import {
  capacityForTrain,
  trainCarCount,
  type FormationValues,
} from "./capacity-model";
import { trainClassKey } from "./classification";
import type { Project, StationOperation, Stop, Train } from "./model";
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
  let units: string[] | undefined = train.operationNumbers?.length
    ? components(train.operationNumbers)
    : seed.inheritedFrom && seed.numbers.length === 1
      ? seed.numbers
      : undefined;
  let saved: FormationValues | undefined;
  let hasChanged = false;
  return visits.slice(0, -1).map((stop, index): FormationValues => {
    const changes = work[index].some(isFormationChange);
    if (index === 0 || changes) saved = sections?.[formationPosition(stop)];
    if (index > 0 && changes) hasChanged = true;
    for (const op of work[index]) {
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
        const match = /^2\/([01])\$(\d+)\//.exec(op.raw);
        const count = Number(match?.[2]);
        units =
          !match || count > units.length
            ? undefined
            : match[1] === "1"
              ? units.slice(count)
              : units.slice(0, units.length - count);
      }
    }
    const groups =
      settings?.formationSource === "operation"
        ? units?.map(operationPattern)
        : undefined;
    const capacity = groups?.map((group) =>
      group ? settings?.operationGroups?.[group] : undefined,
    );
    const cars = groups?.map((group, i) =>
      group
        ? (settings?.operationGroupCars?.[group] ?? capacity?.[i]?.carCount)
        : undefined,
    );
    const total =
      capacity?.length && capacity.every((spec) => spec?.kind === "transport")
        ? capacity.reduce((sum, spec) => sum + spec!.value, 0)
        : undefined;
    const totalCars =
      cars?.length && cars.every((value) => value !== undefined)
        ? cars.reduce((sum, value) => sum! + value!, 0)
        : undefined;
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
