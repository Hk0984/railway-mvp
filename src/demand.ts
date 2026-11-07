import type { Project, Demand } from "./model";
import { trainVisits } from "./analysis";
import { isPassengerTrain } from "./classification";
export function timetableCosts(
  p: Project,
  diaId: string,
  passengerOnly = true,
) {
  const dia = p.timetables.find((d) => d.id === diaId)!;
  const costs: Project["costs"] = {};
  for (const o of p.stations) costs[o.id] = {};
  // Enumerate actual visits once per train; do not run an OD frontier for each matrix cell.
  for (const train of dia.trains) {
    if (
      train.cancelled ||
      (passengerOnly && !isPassengerTrain(p, diaId, train))
    )
      continue;
    const visits = trainVisits(train);
    for (let i = 0; i < visits.length; i++) {
      const a = visits[i];
      if (
        a.status !== "stop" ||
        a.pickupAllowed === false ||
        a.departure === undefined
      )
        continue;
      for (const b of visits.slice(i + 1)) {
        if (
          b.stationId === a.stationId ||
          b.status !== "stop" ||
          b.dropoffAllowed === false ||
          b.arrival === undefined ||
          b.arrival < a.departure
        )
          continue;
        const minutes = (b.arrival - a.departure) / 60;
        costs[a.stationId][b.stationId] = Math.min(
          costs[a.stationId][b.stationId] ?? Infinity,
          minutes,
        );
      }
    }
  }
  return costs;
}
export function generateDemand(p: Project, costs: Project["costs"]) {
  const q = p.parameters;
  const demands: Demand[] = [];
  let generated = 0,
    allocated = 0;
  const warnings: string[] = [];
  for (const o of p.stations) {
    const production = o.population * o.railShare * q.generation;
    generated += production;
    const candidates = p.stations
      .filter((d) => d.id !== o.id)
      .map((d) => {
        const cost = costs[o.id]?.[d.id];
        const attraction =
          d.employment * q.employmentWeight +
          d.students * q.studentWeight +
          d.attraction * q.attractionWeight;
        return {
          d,
          log:
            cost !== undefined &&
            Number.isFinite(cost) &&
            cost >= 0 &&
            attraction > 0
              ? Math.log(attraction) - q.beta * cost
              : -Infinity,
        };
      });
    const max = Math.max(...candidates.map((c) => c.log));
    const weights = candidates.map((c) =>
      max === -Infinity ? 0 : Math.exp(c.log - max),
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!sum && production > 0)
      warnings.push(
        `${o.name}: 到達可能な吸引先がなく ${production.toFixed(2)} 人を未配分`,
      );
    candidates.forEach((c, i) => {
      const passengers = sum ? (production * weights[i]) / sum : 0;
      allocated += passengers;
      demands.push({
        origin: o.id,
        destination: c.d.id,
        purpose: q.purpose,
        period: q.period,
        passengers,
        source: "estimated",
      });
    });
  }
  return {
    demands,
    generated,
    allocated,
    unallocated: generated - allocated,
    warnings,
  };
}
