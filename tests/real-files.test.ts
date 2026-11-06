import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseOud2 } from "../src/oud2";
import { decodeOud2 } from "../src/oud2-text";
import { validateProject } from "../src/model";
import { directTrains, trainVisits, stationDepartures } from "../src/analysis";
import { timetableCosts } from "../src/demand";

const base = new URL("./fixtures/real/", import.meta.url);
const cases = [
  {
    file: "琴町線.oud2",
    sha: "aef5a00fea407193151b1255926ae95cecf10e3588007a7d1033d31d5f22fec7",
    positions: 32,
    stations: 31,
    empty: 361,
    counts: [781, 692, 692],
    outside: 17,
  },
  {
    file: "堀電バス［は01］［は02］［は03］［北11］.oud2",
    sha: "8da42108d4326c0f8af89cd1ec94bd4f30dd456e42360c993f9ef0a8aa352fa4",
    positions: 34,
    stations: 33,
    empty: 193,
    counts: [367, 218, 202],
    outside: 0,
  },
];
describe("ユーザー提供の実ファイル（ローカルコピーのみ）", () => {
  for (const c of cases) {
    it.skipIf(!existsSync(new URL(c.file, base)))(
      `${c.file}: コピー整合・全ダイヤ・空欄・分岐・深夜`,
      () => {
        const bytes = readFileSync(new URL(c.file, base));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(c.sha);
        const decoded = decodeOud2(bytes);
        expect(decoded.encoding).toBe("utf-8");
        const { project: p } = parseOud2(decoded.text);
        expect(() => validateProject(p)).not.toThrow();
        expect(p.oud2!.positions).toHaveLength(c.positions);
        expect(p.stations).toHaveLength(c.stations);
        expect(p.oud2!.emptyColumns).toBe(c.empty);
        expect(p.timetables.map((d) => d.trains.length)).toEqual(c.counts);
        expect(p.oud2!.externalTerminals).toHaveLength(c.outside);
        expect(p.oud2!.serviceDayStart).toBe(14400);
        expect(
          p.timetables.some((d) =>
            d.trains.some((t) =>
              t.stops.some((s) => (s.arrival ?? s.departure ?? 0) >= 86400),
            ),
          ),
        ).toBe(true);
        for (const d of p.timetables)
          for (const t of d.trains) {
            const visits = trainVisits(t);
            expect(
              visits.every(
                (s, i) => i === 0 || s.stationId !== visits[i - 1].stationId,
              ),
            ).toBe(true);
          }
        const cost = timetableCosts(p, p.timetables[0].id);
        expect(Object.keys(cost)).toHaveLength(c.stations);
        if (c.file === "琴町線.oud2") {
          expect(p.oud2!.links).toContainEqual({
            from: "oud-s15",
            to: "oud-s25",
          });
          expect(p.oud2!.links).not.toContainEqual({
            from: "oud-s23",
            to: "oud-s15",
          });
          const train = p.timetables[0].trains.find(
            (t) => t.externalOrigin?.raw === "4/1$648/721$/10C",
          )!;
          expect(train).toBeDefined();
          expect(train.externalOrigin!.terminalId).toBe("oud-out-0-1");
          expect(train.externalOrigin!.externalTime).toBe(24480);
          expect(train.externalOrigin!.boundaryTime).toBe(26460);
          const local = directTrains(p.timetables[0], "oud-s0", "oud-s23").find(
            (r) => r.train.id === train.id,
          )!;
          expect(local.departure).toBe(26760);
          expect((local.arrival - local.departure) / 60).toBe(57.5);
          expect(p.stations.some((s) => s.name === "氷群")).toBe(false);
          const through = p.timetables[0].trains.find(
            (t) =>
              t.stops.some(
                (s) => s.positionId === "oud-p15" && s.arrival !== undefined,
              ) &&
              t.stops.some(
                (s) => s.positionId === "oud-p24" && s.departure !== undefined,
              ),
          )!;
          const visit = trainVisits(through).find(
            (s) => s.stationId === "oud-s15",
          )!;
          expect(visit.arrival).toBe(
            through.stops.find((s) => s.positionId === "oud-p15")!.arrival,
          );
          expect(visit.departure).toBe(
            through.stops.find((s) => s.positionId === "oud-p24")!.departure,
          );
          const conflict = p.timetables[0].trains.find(
            (t) => t.number === "711C",
          )!;
          expect(conflict.externalOrigin!.boundaryTime).toBe(30390);
          expect(
            conflict.stops.find((s) => s.stationId === "oud-s0")!.arrival,
          ).toBe(30300);
          expect(
            p.oud2!.warnings.some(
              (w) => w.includes("不一致") && w.includes("30300秒 / 30390秒"),
            ),
          ).toBe(true);
        } else {
          expect(p.oud2!.links).toContainEqual({
            from: "oud-s18",
            to: "oud-s25",
          });
          expect(p.oud2!.links).not.toContainEqual({
            from: "oud-s25",
            to: "oud-s20",
          });
        }
        expect(() =>
          validateProject(JSON.parse(JSON.stringify(p))),
        ).not.toThrow();
        console.log(
          `${c.file}: ${p.stations.length} physical stations / ${p.oud2!.positions.length} rows; trains ${p.timetables.map((d) => d.trains.length).join("/")}; external origin ${p.timetables.flatMap((d) => d.trains).filter((t) => t.externalOrigin).length}, destination ${p.timetables.flatMap((d) => d.trains).filter((t) => t.externalDestination).length}`,
        );
      },
    );
  }
});
