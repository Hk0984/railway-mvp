import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseOud2 } from "../src/oud2";
import { applyReferenceClassification } from "../src/classification";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand, validateAssignment } from "../src/assignment";
import { defaultAssignmentConfig } from "../src/assignment-model";
const base = new URL("./fixtures/real/", import.meta.url);
for (const [file, origin, destination] of [
  ["琴町線.oud2", "oud-s23", "oud-s31"],
  ["堀電バス［は01］［は02］［は03］［北11］.oud2", "oud-s0", "oud-s20"],
])
  describe(file, () => {
    it.skipIf(!existsSync(new URL(file, base)))(
      "capacity regression across all three real timetables without modifying sources",
      () => {
        const bytes = readFileSync(new URL(file, base)),
          p = parseOud2(bytes.toString("utf8")).project;
        applyReferenceClassification(
          p,
          createHash("sha256").update(bytes).digest("hex"),
        );
        p.datasetId = "real-cap";
        p.capacitySettings = {
          timetables: Object.fromEntries(
            p.timetables.map((d) => [
              d.id,
              {
                value: 10,
                kind: "transport",
                basis: "回帰テスト用の仮定。実車定員ではない",
              },
            ]),
          ),
          types: {},
          trains: {},
        };
        const warningCount = p.oud2!.warnings.length;
        for (const d of p.timetables) {
          const index = buildRoutingIndex([
            { datasetId: p.datasetId!, project: p, timetableId: d.id },
          ]);
          const r = assignDemand(
            index,
            [
              {
                datasetId: p.datasetId!,
                origin,
                destination,
                purpose: "commute",
                kind: "outbound",
                source: "manual",
                passengers: 21,
                start: 25200,
                end: 25260,
              },
            ],
            {
              ...defaultAssignmentConfig(),
              start: 25200,
              end: 25260,
              maxWaitSeconds: 7200,
              integer: true,
              capacityConstrained: true,
            },
          );
          expect(validateAssignment(index, r)).toEqual([]);
          const t = r.capacity!.totals;
          expect(t.completed + t.inTransit + t.waiting + t.noPath).toBe(21);
          expect(t.completed).toBeGreaterThan(0);
          expect(
            r.capacity!.loads.every(
              (l) => l.peakLoad <= 10 && l.totalBoardings === l.totalAlightings,
            ),
          ).toBe(true);
          expect(p.oud2!.warnings.length).toBe(warningCount);
          for (const l of r.capacity!.loads) {
            for (let i = 0; i < l.stops.length - 1; i++)
              if (file.startsWith("琴"))
                expect([
                  l.stops[i].stationId,
                  l.stops[i + 1].stationId,
                ]).not.toEqual(["oud-s23", "oud-s15"]);
          }
        }
      },
      120000,
    );
  });
