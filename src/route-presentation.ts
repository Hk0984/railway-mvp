import type { Project, Stop } from "./model";
import type { JourneyLeg } from "./routing-model";
import { trainVisits } from "./analysis";
import { trainCarCount } from "./capacity-model";
export function legPresentation(project: Project, leg: JourneyLeg) {
  const train = project.timetables
      .find((d) => d.id === leg.timetableId)
      ?.trains.find((t) => t.id === leg.trainId),
    visits = train ? trainVisits(train) : [],
    terminal = visits.at(-1);
  const external = train?.externalDestination
    ? project.oud2?.externalTerminals.find(
        (e) => e.id === train.externalDestination!.terminalId,
      )?.name
    : undefined;
  const track = (side: "arrival" | "departure") => {
    const ref = side === "departure" ? leg.origin : leg.destination,
      time = side === "departure" ? leg.departure : leg.arrival;
    const raw =
      train?.stops.filter(
        (s) => s.stationId === ref.stationId && s[side] === time,
      ) ?? [];
    const names = [
      ...new Set(
        raw
          .map((s) => platformName(project, s))
          .filter((v): v is string => v !== null),
      ),
    ];
    return raw.length
      ? names.length === 1
        ? names[0]
        : null
      : platformName(
          project,
          side === "departure" ? leg.stops[0] : leg.stops.at(-1),
        );
  };
  return {
    destination:
      external ??
      project.stations.find((s) => s.id === terminal?.stationId)?.name ??
      "行先未記載",
    stops: leg.stops.slice(1, -1).filter((s) => s.status === "stop"),
    carCount: train ? trainCarCount(project, leg.timetableId, train) : undefined,
    departureTrack: track("departure"),
    arrivalTrack: track("arrival"),
  };
}
export function platformName(p: Project, s: Stop | undefined): string | null {
  if (!s || s.track === undefined || s.track === "") return null;
  if (!p.oud2) return s.track;
  if (!/^\d+$/.test(s.track)) return null;
  const positions = p.oud2.positions;
  const ids = [
    ...new Set(
      [s.positionId, ...(s.sourcePositionIds ?? [])].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
  const matching = ids.length
    ? positions.filter((v) => ids.includes(v.id))
    : positions.filter((v) => v.stationId === s.stationId);
  const names = [
    ...new Set(
      matching
        .map((v) => v.tracks[Number(s.track)])
        .filter(
          (v): v is string =>
            typeof v === "string" &&
            v.trim() !== "" &&
            !/^[\sー－―—\-]+$/.test(v),
        ),
    ),
  ];
  return names.length === 1 ? names[0] : null;
}
