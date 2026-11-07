import { it, expect, describe } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseOud2 } from "../src/oud2";
import {
  buildRoutingIndex,
  searchJourneys,
  validateJourney,
} from "../src/routing";
import type { RouteQuery } from "../src/routing-model";
import { trainVisits } from "../src/analysis";
import {
  generateTemporalDemand,
  defaultTemporalConfig,
  resplitTemporal,
} from "../src/temporal-demand";
import { timetableCosts } from "../src/demand";
import { compareODService } from "../src/od-service";
import { analyzeService } from "../src/service";
import {
  applyReferenceClassification,
  isPassengerTrain,
} from "../src/classification";
import { createHash } from "node:crypto";
const base = new URL("./fixtures/real/", import.meta.url);
for (const [file, origin, destination, branchOrigin, branchDestination] of [
  ["琴町線.oud2", "oud-s0", "oud-s23", "oud-s23", "oud-s31"],
  [
    "堀電バス［は01］［は02］［は03］［北11］.oud2",
    "oud-s0",
    "oud-s33",
    "oud-s0",
    "oud-s20",
  ],
]) {
  describe(file, () => {
    it.skipIf(!existsSync(new URL(file, base)))(
      "all three actual timetables: direct, reverse, branch, arrival-by and valid transfers",
      () => {
        const p = parseOud2(readFileSync(new URL(file, base), "utf8")).project;
        p.datasetId = "real";
        applyReferenceClassification(
          p,
          createHash("sha256")
            .update(readFileSync(new URL(file, base)))
            .digest("hex"),
        );
        p.temporal = generateTemporalDemand(
          p,
          defaultTemporalConfig(),
          timetableCosts(p, p.timetables[0].id),
        );
        const manual = p.temporal.dailyOutbound.find(
          (r) =>
            r.origin === origin &&
            r.destination === destination &&
            r.purpose === "commute",
        )!;
        manual.passengers = 100;
        manual.source = "manual";
        p.temporal = resplitTemporal(p.temporal);
        const fixedDemand = JSON.stringify(p.temporal);
        const outcomes: string[] = [];
        const q = (o = origin, d = destination): RouteQuery => ({
          origin: { datasetId: "real", stationId: o },
          destination: { datasetId: "real", stationId: d },
          mode: "depart",
          time: 7 * 3600,
          maxTransfers: 2,
          minimumTransferSeconds: 120,
          directOnly: false,
          sort: "arrival",
          limit: 4,
        });
        for (const dia of p.timetables) {
          const index = buildRoutingIndex([
            { datasetId: "real", project: p, timetableId: dia.id },
          ]);
          for (const warning of p.oud2!.warnings)
            expect(index.warnings.some((w) => w.endsWith(warning))).toBe(true);
          for (const query of [
            q(),
            q(destination, origin),
            q(branchOrigin, branchDestination),
          ]) {
            const start = performance.now();
            const result = searchJourneys(index, query);
            console.log(
              file,
              dia.name,
              query.origin.stationId,
              query.destination.stationId,
              result.journeys.map(
                (j) => `${j.departure}/${j.arrival}/${j.transferCount}`,
              ),
              Math.round(performance.now() - start) + "ms",
            );
            expect(result.journeys.length).toBeGreaterThan(0);
            if (
              query.origin.stationId === origin &&
              query.destination.stationId === destination
            )
              outcomes.push(
                `${result.journeys[0].departure}/${result.journeys[0].arrival}`,
              );
            if (
              query.origin.stationId === branchOrigin &&
              query.destination.stationId === branchDestination
            )
              expect(result.journeys.every((j) => j.transferCount >= 1)).toBe(
                true,
              );
            for (const j of result.journeys)
              expect(validateJourney(index, query, j)).toEqual([]);
          }
          const direct = searchJourneys(index, { ...q(), directOnly: true });
          expect(direct.journeys.length).toBeGreaterThan(0);
          expect(
            searchJourneys(index, {
              ...q(branchOrigin, branchDestination),
              directOnly: true,
            }).journeys,
          ).toHaveLength(0);
          const arrived = searchJourneys(index, {
            ...q(),
            mode: "arrive",
            time: 10 * 3600,
          });
          expect(arrived.journeys.length).toBeGreaterThan(0);
          for (const j of arrived.journeys)
            expect(
              validateJourney(
                index,
                { ...q(), mode: "arrive", time: 10 * 3600 },
                j,
              ),
            ).toEqual([]);
          expect(JSON.stringify(p.temporal)).toBe(fixedDemand);
        }
        expect(new Set(outcomes).size).toBeGreaterThan(1);
        const night = p.timetables.flatMap((d) =>
          d.trains.flatMap((t) => {
            if (!isPassengerTrain(p, d.id, t)) return [];
            const visits = trainVisits(t);
            for (let i = 0; i < visits.length; i++) {
              const a = visits[i];
              if (
                a.status === "stop" &&
                a.departure !== undefined &&
                a.departure >= 86400
              ) {
                const b = visits
                  .slice(i + 1)
                  .find(
                    (s) =>
                      s.status === "stop" &&
                      s.arrival !== undefined &&
                      s.stationId !== a.stationId,
                  );
                if (b)
                  return [
                    {
                      dia: d.id,
                      origin: a.stationId,
                      destination: b.stationId,
                      time: a.departure,
                    },
                  ];
              }
            }
            return [];
          }),
        )[0];
        expect(night).toBeDefined();
        const nightIndex = buildRoutingIndex([
          { datasetId: "real", project: p, timetableId: night.dia },
        ]);
        const nightQuery = {
          ...q(night.origin, night.destination),
          time: night.time,
          directOnly: true,
        };
        const nightResult = searchJourneys(nightIndex, nightQuery);
        expect(nightResult.journeys.length).toBeGreaterThan(0);
        expect(nightResult.journeys[0].arrival).toBeGreaterThanOrEqual(86400);
        expect(
          validateJourney(nightIndex, nightQuery, nightResult.journeys[0]),
        ).toEqual([]);
        const firstIndex = buildRoutingIndex([
          { datasetId: "real", project: p, timetableId: p.timetables[0].id },
        ]);
        const supply = analyzeService(firstIndex, q(), 25200, 28800);
        const ridingQuery = {
          ...q(branchOrigin, branchDestination),
          sort: "riding" as const,
        };
        const ridingRoutes = searchJourneys(firstIndex, ridingQuery);
        expect(ridingRoutes.journeys.length).toBeGreaterThan(0);
        expect(
          validateJourney(firstIndex, ridingQuery, ridingRoutes.journeys[0]),
        ).toEqual([]);
        const od = compareODService(
          p,
          q().origin,
          q().destination,
          25200,
          28800,
          supply.allJourneys,
          "commute",
        )!;
        expect(od.daily).toBe(100);
        expect(od.hourly).toBeGreaterThan(0);
        expect(od.sources.manual).toBeGreaterThan(0);
      },
      30000,
    );
  });
}
