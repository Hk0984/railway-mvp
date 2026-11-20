import type {
  AssignmentResult,
  DiagramTransfer,
  DiagramTransfers,
} from "./assignment-model";
import type { JourneyLeg } from "./routing-model";

const tripKey = (leg: JourneyLeg) =>
  JSON.stringify([leg.datasetId, leg.timetableId, leg.trainId]);

export function summarizeDiagramTransfers<T extends { passengers: number }>(
  allocations: Iterable<T>,
  legsFor: (allocation: T) => readonly JourneyLeg[],
): DiagramTransfers {
  const totals: DiagramTransfers = {};
  function record(
    train: string,
    visit: number,
    direction: keyof DiagramTransfer,
    passengers: number,
  ) {
    const visits = (totals[train] ??= {});
    const count = (visits[visit] ??= { fromConnection: 0, toConnection: 0 });
    count[direction] += passengers;
  }
  for (const allocation of allocations) {
    const legs = legsFor(allocation);
    if (legs.length < 2 || allocation.passengers <= 0) continue;
    let arrivingKey = tripKey(legs[0]);
    for (let i = 1; i < legs.length; i++) {
      const departingKey = tripKey(legs[i]);
      if (arrivingKey !== departingKey) {
        record(
          arrivingKey,
          legs[i - 1].alightIndex,
          "toConnection",
          allocation.passengers,
        );
        record(
          departingKey,
          legs[i].boardIndex,
          "fromConnection",
          allocation.passengers,
        );
      }
      arrivingKey = departingKey;
    }
  }
  return totals;
}

export function assignmentTransfers(result: AssignmentResult) {
  return result.capacity
    ? summarizeDiagramTransfers(result.capacity.packets, (p) => p.history)
    : summarizeDiagramTransfers(
        result.allocations,
        (a) => result.journeys[a.journeyId].legs,
      );
}
