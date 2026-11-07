import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseOud2 } from "../src/oud2";
import {
  applyReferenceClassification,
  classificationCounts,
  isPassengerTrain,
} from "../src/classification";
import { buildRoutingIndex } from "../src/routing";
import { assignDemand, validateAssignment } from "../src/assignment";
import {
  defaultAssignmentConfig,
  type AssignmentDemand,
} from "../src/assignment-model";
const base = new URL("./fixtures/real/", import.meta.url);
for (const [file, origin, destination] of [
  ["琴町線.oud2", "oud-s23", "oud-s31"],
  ["堀電バス［は01］［は02］［は03］［北11］.oud2", "oud-s0", "oud-s20"],
])
  describe(file, () => {
    it.skipIf(!existsSync(new URL(file, base)))(
      "verifies classification and transfer loads in all three timetables",
      () => {
        const bytes = readFileSync(new URL(file, base)),
          p = parseOud2(new TextDecoder("utf-8").decode(bytes)).project;
        p.datasetId = "real";
        expect(classificationCounts(p, p.timetables[0].id).passenger).toBe(0);
        applyReferenceClassification(
          p,
          createHash("sha256").update(bytes).digest("hex"),
        );
        const audits = p.timetables.map((d) => ({
          name: d.name,
          ...classificationCounts(p, d.id),
        }));
        mkdirSync("artifacts", { recursive: true });
        writeFileSync(
          "artifacts/" +
            (file.startsWith("琴") ? "rail" : "bus") +
            "-classification.json",
          JSON.stringify(audits, null, 2),
        );
        for (const dia of p.timetables) {
          const idx = buildRoutingIndex([
            { datasetId: "real", project: p, timetableId: dia.id },
          ]);
          expect(idx.trips.size).toBe(
            classificationCounts(p, dia.id).passenger,
          );
          expect(
            [...idx.trips.values()].every((t) =>
              isPassengerTrain(p, dia.id, t.train),
            ),
          ).toBe(true);
          expect(
            [...idx.trips.values()].some((t) =>
              ["回送", "試運転"].includes(
                p.types.find((s) => s.id === t.train.typeId)!.name,
              ),
            ),
          ).toBe(false);
          const input: AssignmentDemand[] = [
            {
              datasetId: "real",
              origin,
              destination,
              purpose: "commute",
              kind: "outbound",
              source: "manual",
              start: 25200,
              end: 26100,
              passengers: 101,
            },
          ];
          const c = {
            ...defaultAssignmentConfig(),
            start: 25200,
            end: 26100,
            integer: true,
            maxWaitSeconds: 7200,
          };
          const r = assignDemand(idx, input, c);
          expect(r.totals.selected).toBe(101);
          expect(r.totals.assigned + r.totals.unassigned).toBe(101);
          expect(r.totals.assigned).toBeGreaterThan(0);
          expect(r.totals.boardingEvents).toBeGreaterThan(r.totals.assigned);
          expect(validateAssignment(idx, r)).toEqual([]);
          for (const l of r.loads) {
            expect(l.totalBoardings).toBe(l.totalAlightings);
            expect(l.peakOccupancy).toBeNull();
            expect(l.segmentLoads.every((n) => n >= 0)).toBe(true);
          }
          if (file.startsWith("琴"))
            for (const l of r.loads) {
              for (let i = 0; i < l.stops.length - 1; i++)
                expect([
                  l.stops[i].stationId,
                  l.stops[i + 1].stationId,
                ]).not.toEqual(["oud-s23", "oud-s15"]);
            }
        }
        console.log(file, audits);
      },
      60000,
    );
  });
