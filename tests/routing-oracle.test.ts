import { it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { trainVisits } from "../src/analysis";
import {
  buildRoutingIndex,
  searchJourneys,
  validateJourney,
} from "../src/routing";
import type { RouteQuery } from "../src/routing-model";
import type { Train } from "../src/model";

it("matches exhaustive event-pair enumeration on small timetables for all sorts and both time modes", () => {
  let seed = 17491;
  const rand = (n: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  for (let example = 0; example < 18; example++) {
    const p = sampleProject();
    p.stations = p.stations.slice(0, 4);
    p.costs = {};
    const trains: Train[] = [];
    for (let t = 0; t < 7; t++) {
      let time = rand(300);
      const order = rand(2) ? [0, 1, 2, 3] : [3, 2, 1, 0];
      const stops = order.map((s, i) => {
        time += 10 + rand(30);
        const arrival = i ? time : undefined;
        time += rand(70);
        return {
          stationId: `s${s}`,
          status: "stop" as const,
          arrival,
          departure: i < 3 ? time : undefined,
        };
      });
      trains.push({
        id: `t${t}`,
        number: "",
        typeId: "local",
        direction: "down",
        stops,
      });
    }
    p.timetables = [{ id: "test", name: "test", trains }];
    const idx = buildRoutingIndex([
      { datasetId: "a", project: p, timetableId: "test" },
    ]);
    const rides = trains.flatMap((t) => {
      const visits = trainVisits(t);
      return visits.flatMap((a, i) =>
        a.departure === undefined
          ? []
          : visits
              .slice(i + 1)
              .flatMap((b) =>
                b.arrival === undefined
                  ? []
                  : [
                      {
                        id: t.id,
                        from: a.stationId,
                        to: b.stationId,
                        departure: a.departure!,
                        arrival: b.arrival!,
                      },
                    ],
              ),
      );
    });
    for (const mode of ["depart", "arrive"] as const)
      for (const sort of ["arrival", "transfers", "riding"] as const) {
        const query: RouteQuery = {
          origin: { datasetId: "a", stationId: "s0" },
          destination: { datasetId: "a", stationId: "s3" },
          mode,
          time: mode === "depart" ? 100 : 450,
          maxTransfers: 2,
          minimumTransferSeconds: 5,
          directOnly: false,
          sort,
          limit: 1,
        };
        const brute: {
          departure: number;
          arrival: number;
          riding: number;
          changes: number;
        }[] = [];
        function walk(station: string, time: number, legs: typeof rides) {
          if (station === "s3" && legs.length) {
            if (mode === "depart" || time <= query.time)
              brute.push({
                departure: legs[0].departure,
                arrival: time,
                riding: legs.reduce((s, r) => s + r.arrival - r.departure, 0),
                changes: legs.length - 1,
              });
            return;
          }
          if (legs.length === 3) return;
          for (const r of rides) {
            if (
              r.from !== station ||
              r.departure < time + (legs.length ? 5 : 0) ||
              r.id === legs.at(-1)?.id ||
              (mode === "arrive" && r.arrival > query.time)
            )
              continue;
            walk(r.to, r.arrival, [...legs, r]);
          }
        }
        walk("s0", mode === "depart" ? query.time : 0, []);
        const order = (
          a: (typeof brute)[number],
          b: (typeof brute)[number],
        ) => {
          const timing =
            mode === "arrive"
              ? b.departure - a.departure || a.arrival - b.arrival
              : a.arrival - b.arrival || b.departure - a.departure;
          return sort === "riding"
            ? a.riding - b.riding || timing
            : sort === "transfers"
              ? a.changes - b.changes || timing
              : timing || a.changes - b.changes;
        };
        brute.sort(order);
        const got = searchJourneys(idx, query).journeys[0];
        expect(Boolean(got)).toBe(Boolean(brute[0]));
        if (got) {
          expect(
            order(
              {
                departure: got.departure,
                arrival: got.arrival,
                riding: got.ridingSeconds,
                changes: got.transferCount,
              },
              brute[0],
            ),
          ).toBe(0);
          expect(validateJourney(idx, query, got)).toEqual([]);
        }
      }
  }
});
