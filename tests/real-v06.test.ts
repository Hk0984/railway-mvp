import { it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseOud2 } from "../src/oud2";
import { applyReferenceClassification } from "../src/classification";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand, validateAssignment } from "../src/assignment";
import { defaultAssignmentConfig } from "../src/assignment-model";
for (const file of [
  "琴町線.oud2",
  "堀電バス［は01］［は02］［は03］［北11］.oud2",
])
  it.skipIf(!existsSync(new URL("./fixtures/real/" + file, import.meta.url)))(
    file + " simultaneous audit across all three actual timetables",
    () => {
      const bytes = readFileSync(
          new URL("./fixtures/real/" + file, import.meta.url),
        ),
        hash = createHash("sha256").update(bytes).digest("hex"),
        p = parseOud2(bytes.toString("utf8")).project;
      applyReferenceClassification(p, hash);
      p.datasetId = "v06-real";
      p.capacitySettings = {
        trains: {},
        types: {},
        timetables: Object.fromEntries(
          p.timetables.map((d) => [
            d.id,
            {
              kind: "transport",
              value: 10,
              basis: "人工回帰試験用。実車定員ではない",
            },
          ]),
        ),
      };
      const warnings = JSON.stringify(p.oud2!.warnings);
      for (const d of p.timetables) {
        const idx = buildRoutingIndex([
          { project: p, datasetId: p.datasetId, timetableId: d.id },
        ]);
        let pair: any;
        for (const t of idx.trips.values()) {
          const a = t.visits.findIndex(
              (v) =>
                v.status === "stop" &&
                v.pickupAllowed !== false &&
                v.departure !== undefined &&
                v.departure > 60,
            ),
            b = t.visits.findIndex(
              (v, i) =>
                i > a &&
                v.status === "stop" &&
                v.dropoffAllowed !== false &&
                v.arrival !== undefined &&
                v.stationId !== t.visits[a]?.stationId,
            );
          if (a >= 0 && b > a) {
            pair = [t.visits[a], t.visits[b]];
            break;
          }
        }
        expect(pair).toBeDefined();
        const start = pair[0].departure - 60,
          end = pair[0].departure,
          rows = (["commute", "school"] as const).map((purpose) => ({
            datasetId: p.datasetId!,
            origin: pair[0].stationId,
            destination: pair[1].stationId,
            purpose,
            kind: "outbound" as const,
            source: "manual" as const,
            start,
            end,
            passengers: 8,
          })),
          r = assignDemand(idx, rows, {
            ...defaultAssignmentConfig(),
            start,
            end,
            simulationEnd: end + 14400,
            maxTransfers: 0,
            integer: true,
            capacityConstrained: true,
            competition: "simultaneous",
            diagnosticMode: "full",
            arrivalModel: {
              mode: "minute",
              distribution: "uniform",
              stepSeconds: 60,
            },
          });
        expect(validateAssignment(idx, r)).toEqual([]);
        expect(r.capacity!.totals.completed).toBeGreaterThan(0);
        expect(r.capacity!.loads.every((l) => l.peakLoad <= 10)).toBe(true);
        expect(
          r.audit!.points.every(
            (p) =>
              Math.abs(
                Object.values(p.states).reduce((a, b) => a + b, 0) - 16,
              ) < 1e-8,
          ),
        ).toBe(true);
        expect(JSON.stringify(p.oud2!.warnings)).toBe(warnings);
        console.log(
          "0.6 actual audit",
          file,
          d.name,
          p.stations.find((s) => s.id === pair[0].stationId)!.name,
          "→",
          p.stations.find((s) => s.id === pair[1].stationId)!.name,
          r.capacity!.totals.completed,
        );
      }
      expect(
        createHash("sha256")
          .update(
            readFileSync(new URL("./fixtures/real/" + file, import.meta.url)),
          )
          .digest("hex"),
      ).toBe(hash);
    },
    120000,
  );
