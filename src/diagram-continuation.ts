import type { Journey } from "./routing-model";

export const minimumTransferGainSeconds = 3 * 60;

export function preferThroughJourneys(feasible: Journey[]) {
  if (!feasible.some((journey) => journey.transferCount > 0)) return feasible;
  const boardingKey = ({ legs: [first] }: Journey) =>
    JSON.stringify([
      first.datasetId,
      first.timetableId,
      first.trainId,
      first.boardIndex,
    ]);
  const through = new Map<string, number>();
  for (const journey of feasible) {
    if (journey.transferCount !== 0) continue;
    const key = boardingKey(journey);
    through.set(key, Math.min(journey.arrival, through.get(key) ?? Infinity));
  }
  if (!through.size) return feasible;
  return feasible.filter(
    (journey) =>
      journey.transferCount === 0 ||
      (through.get(boardingKey(journey)) ?? Infinity) - journey.arrival >=
        minimumTransferGainSeconds,
  );
}
