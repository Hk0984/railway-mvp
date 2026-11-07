import { csv } from "./io";
import type { AssignmentResult } from "./assignment-model";
export function trainLoadsCsv(r: AssignmentResult) {
  return csv([
    [
      "method",
      "windowStart",
      "windowEnd",
      "datasetId",
      "timetableId",
      "trainId",
      "trainNumber",
      "type",
      "direction",
      "boardings",
      "alightings",
      "uniquePassengers",
      "peakLoad",
      "capacity",
      "peakOccupancy",
    ],
    ...(r.capacity?.loads ?? r.loads).map((l) => [
      r.config.method,
      r.config.start,
      r.config.end,
      l.datasetId,
      l.timetableId,
      l.trainId,
      l.trainNumber,
      l.typeName,
      l.direction,
      l.totalBoardings,
      l.totalAlightings,
      l.uniquePassengers,
      l.peakLoad,
      l.capacity ?? "",
      l.peakOccupancy ?? "",
    ]),
  ]);
}
export function segmentLoadsCsv(r: AssignmentResult) {
  return csv([
    [
      "method",
      "datasetId",
      "timetableId",
      "trainId",
      "stopIndex",
      "stationId",
      "sourcePositions",
      "arrival",
      "departure",
      "boardings",
      "alightings",
      "nextStationId",
      "onboardToNext",
      "capacity",
      "occupancy",
    ],
    ...(r.capacity?.loads ?? r.loads).flatMap((l) =>
      l.stops.map((s, i) => [
        r.config.method,
        l.datasetId,
        l.timetableId,
        l.trainId,
        i,
        s.stationId,
        (s.sourcePositionIds ?? []).join("|"),
        s.arrival ?? "",
        s.departure ?? "",
        l.boardings[i],
        l.alightings[i],
        l.stops[i + 1]?.stationId ?? "",
        l.segmentObserved?.[i] === false ? "" : (l.segmentLoads[i] ?? 0),
        l.capacity ?? "",
        l.occupancies[i] ?? "",
      ]),
    ),
  ]);
}
export function unallocatedCsv(r: AssignmentResult) {
  if (r.capacity)
    return csv([
      ["cohortId", "state", "stationId", "destination", "passengers", "reason"],
      ...r.capacity.packets
        .filter((p) => p.state !== "completed")
        .map((p) => [
          p.cohortId,
          p.state,
          p.stationId,
          p.destination,
          p.passengers,
          p.reason ?? "",
        ]),
    ]);
  const cohorts = new Map(r.cohorts.map((c) => [c.id, c]));
  return csv([
    [
      "method",
      "datasetId",
      "origin",
      "destination",
      "purpose",
      "kind",
      "source",
      "arrivalStart",
      "arrivalEnd",
      "passengers",
      "reason",
    ],
    ...r.unallocated.map((a) => {
      const c = cohorts.get(a.cohortId)!,
        d = r.input[c.demandIndex];
      return [
        r.config.method,
        d.datasetId,
        d.origin,
        d.destination,
        d.purpose,
        d.kind,
        d.source,
        c.start,
        c.end,
        a.passengers,
        a.reason,
      ];
    }),
  ]);
}
export function allocationsCsv(r: AssignmentResult) {
  if (r.capacity)
    return csv([
      [
        "packetId",
        "cohortId",
        "passengers",
        "trainId",
        "timetableId",
        "origin",
        "destination",
        "boardTime",
        "scheduledAlightTime",
        "alightObserved",
        "stateAtHorizon",
      ],
      ...r.capacity.packets.flatMap((p) =>
        p.history.map((l) => [
          p.id,
          p.cohortId,
          p.passengers,
          l.trainId,
          l.timetableId,
          l.origin.stationId,
          l.destination.stationId,
          l.departure,
          l.arrival,
          l.arrival <= r.capacity!.horizon ? "yes" : "no",
          p.state,
        ]),
      ),
    ]);
  const cohorts = new Map(r.cohorts.map((c) => [c.id, c]));
  return csv([
    [
      "method",
      "demandIndex",
      "purpose",
      "kind",
      "source",
      "arrivalStart",
      "arrivalEnd",
      "passengers",
      "probability",
      "costMinutes",
      "journeyId",
      "legIndex",
      "datasetId",
      "timetableId",
      "trainId",
      "boardStation",
      "alightStation",
      "departure",
      "arrival",
    ],
    ...r.allocations.flatMap((a) => {
      const c = cohorts.get(a.cohortId)!,
        d = r.input[c.demandIndex];
      return r.journeys[a.journeyId].legs.map((l, i) => [
        r.config.method,
        c.demandIndex,
        d.purpose,
        d.kind,
        d.source,
        c.start,
        c.end,
        a.passengers,
        a.probability,
        a.costMinutes,
        a.journeyId,
        i,
        l.datasetId,
        l.timetableId,
        l.trainId,
        l.origin.stationId,
        l.destination.stationId,
        l.departure,
        l.arrival,
      ]);
    }),
  ]);
}
